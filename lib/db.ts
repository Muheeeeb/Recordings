import { createClient, type Client } from '@libsql/client'

/**
 * Turso (SQLite) index over the recordings in S3.
 *
 * Storage is deliberately compact: group and agent names live in lookup
 * tables, the S3 path prefix is derived rather than stored, and only the
 * filename is kept verbatim. At ~45k new recordings a day that is the
 * difference between months and years of free-tier headroom.
 *
 * The full S3 key is rebuilt as:  dialer/<group>/<dir>/<filename>
 * `dir` is stored as text so any folder layout the dialer uses keeps working.
 */

let client: Client | null = null

export function db(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL
    const authToken = process.env.TURSO_AUTH_TOKEN
    if (!url) throw new Error('TURSO_DATABASE_URL is not set')
    client = createClient({ url, authToken })
  }
  return client
}

export const PREFIX = process.env.S3_PREFIX ?? 'dialer/'

export function buildKey(group: string, dir: string, fn: string): string {
  return dir ? `${PREFIX}${group}/${dir}/${fn}` : `${PREFIX}${group}/${fn}`
}

/** Splits a key back into the parts stored in the index. */
export function splitKey(key: string): { group: string; dir: string; fn: string } | null {
  if (!key.startsWith(PREFIX)) return null
  const rest = key.slice(PREFIX.length).split('/')
  if (rest.length < 2) return null
  const group = rest[0]
  const fn = rest[rest.length - 1]
  const dir = rest.slice(1, -1).join('/')
  return { group, dir, fn }
}

const TABLES = [
  `CREATE TABLE IF NOT EXISTS groups (
     id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS agents (
     id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS recordings (
     id    INTEGER PRIMARY KEY,
     g     INTEGER NOT NULL,
     a     INTEGER,
     dir   TEXT NOT NULL DEFAULT '',
     fn    TEXT NOT NULL,
     ts    INTEGER,
     day   INTEGER,
     lead  INTEGER,
     phone INTEGER,
     sz    INTEGER,
     UNIQUE (g, dir, fn))`,
  // Credentials live here rather than in an env var so they can be changed
  // from the UI; seeded from ADMIN_USERNAME / ADMIN_PASSWORD_HASH on first run.
  `CREATE TABLE IF NOT EXISTS users (
     id            INTEGER PRIMARY KEY,
     username      TEXT UNIQUE NOT NULL,
     password_hash TEXT NOT NULL,
     updated_at    INTEGER)`,
  // Throttling state must outlive a single request: serverless instances share
  // no memory, so an in-process counter would reset on every cold start.
  `CREATE TABLE IF NOT EXISTS login_attempts (
     ip            TEXT PRIMARY KEY,
     fails         INTEGER NOT NULL DEFAULT 0,
     strikes       INTEGER NOT NULL DEFAULT 0,
     blocked_until INTEGER,
     updated_at    INTEGER)`,
  // The dashboard totals are aggregates over every row. They only change when
  // the indexer runs, so they are computed once and read back as a single row
  // rather than recomputed on every page load.
  //
  // The payload holds one entry per day *per group* rather than a flat total,
  // which is what lets the dashboard answer "how many ACA calls on the 28th"
  // without another query. That grid stays small — days times four — however
  // large the recordings table gets.
  `CREATE TABLE IF NOT EXISTS stats_cache (
     id          INTEGER PRIMARY KEY CHECK (id = 1),
     payload     TEXT NOT NULL,
     computed_at INTEGER NOT NULL)`,
]

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS i_ts    ON recordings (ts DESC)`,
  `CREATE INDEX IF NOT EXISTS i_lead  ON recordings (lead)`,
  `CREATE INDEX IF NOT EXISTS i_phone ON recordings (phone)`,
  // The app's most common query is "one group, newest first"; without this the
  // planner walks i_ts filtering by group, which degrades as the table grows.
  `CREATE INDEX IF NOT EXISTS i_g_ts  ON recordings (g, ts DESC)`,
  // The dashboard groups by calendar day; without a stored day the planner has
  // to compute strftime() over every row on each load.
  `CREATE INDEX IF NOT EXISTS i_day   ON recordings (day)`,
]

/**
 * Tables, then column additions, then indexes — in that order.
 *
 * CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so a column added
 * to the definition above never reaches a database that already exists. The
 * ALTER pass in the middle is what actually adds it, and it has to run before
 * any index that references the new column.
 */
export async function ensureSchema() {
  for (const statement of TABLES) await db().execute(statement)

  const info = await db().execute('PRAGMA table_info(recordings)')
  const columns = new Set(info.rows.map((r) => String((r as unknown as { name: string }).name)))
  if (!columns.has('day')) {
    await db().execute('ALTER TABLE recordings ADD COLUMN day INTEGER')
  }
  await db().execute(
    `UPDATE recordings SET day = CAST(strftime('%Y%m%d', ts, 'unixepoch') AS INTEGER)
     WHERE day IS NULL AND ts IS NOT NULL`
  )

  const userInfo = await db().execute('PRAGMA table_info(users)')
  const userCols = new Set(
    userInfo.rows.map((r) => String((r as unknown as { name: string }).name))
  )
  if (!userCols.has('security_question')) {
    await db().execute('ALTER TABLE users ADD COLUMN security_question TEXT')
  }
  if (!userCols.has('security_answer_hash')) {
    await db().execute('ALTER TABLE users ADD COLUMN security_answer_hash TEXT')
  }

  for (const statement of INDEXES) await db().execute(statement)
}

export type SearchParams = {
  q?: string
  group?: string
  from?: number
  to?: number
  limit?: number
  offset?: number
}

export type SearchRow = {
  key: string
  group_name: string
  agent: string | null
  recorded_at: number | null
  lead_id: number | null
  phone: number | null
  size_bytes: number | null
}

/**
 * Numeric terms are matched exactly against lead id and phone so the query
 * uses an index — a substring scan over tens of millions of rows would not
 * stay responsive. Non-numeric terms match the agent name.
 */
export async function searchRecordings(params: SearchParams): Promise<SearchRow[]> {
  const limit = Math.min(params.limit ?? 50, 200)
  const offset = params.offset ?? 0
  const term = params.q?.trim() ?? ''
  const digits = term.replace(/\D/g, '')
  const numeric = digits.length >= 4 && digits.length === term.replace(/[\s()+-]/g, '').length

  const result = await db().execute({
    sql: `
      SELECT g.name AS group_name, a.name AS agent, r.dir, r.fn,
             r.ts, r.lead, r.phone, r.sz
      FROM recordings r
      JOIN groups g ON g.id = r.g
      LEFT JOIN agents a ON a.id = r.a
      WHERE (:group IS NULL OR g.name = :group)
        AND (:from  IS NULL OR r.ts >= :from)
        AND (:to    IS NULL OR r.ts <= :to)
        AND (
          :term IS NULL
          OR (:num IS NOT NULL AND (r.lead = :num OR r.phone = :num))
          OR (:num IS NULL AND a.name LIKE :like)
        )
      ORDER BY r.ts DESC
      LIMIT :limit OFFSET :offset`,
    args: {
      group: params.group ?? null,
      from: params.from ?? null,
      to: params.to ?? null,
      term: term || null,
      num: numeric ? Number(digits) : null,
      like: term ? `%${term}%` : null,
      limit,
      offset,
    },
  })

  return result.rows.map((row) => {
    const r = row as unknown as {
      group_name: string
      agent: string | null
      dir: string
      fn: string
      ts: number | null
      lead: number | null
      phone: number | null
      sz: number | null
    }
    return {
      key: buildKey(r.group_name, r.dir, r.fn),
      group_name: r.group_name,
      agent: r.agent,
      recorded_at: r.ts,
      lead_id: r.lead,
      phone: r.phone,
      size_bytes: r.sz,
    }
  })
}

export async function listGroups(): Promise<string[]> {
  const result = await db().execute('SELECT name FROM groups ORDER BY name')
  return result.rows.map((r) => String((r as unknown as { name: string }).name))
}

/**
 * One row per day per group. Everything the dashboard shows — totals, the daily
 * chart, the group breakdown — is derived from this grid, so filtering by date
 * or group happens in the browser with no further requests.
 */
export type StatCell = { day: number; group: string; count: number; bytes: number }

export type Stats = {
  cells: StatCell[]
  perAgent: { name: string; count: number }[]
}

/** Falls back to recomputing if the indexer has not refreshed in a day. */
const STATS_TTL_SECONDS = 24 * 60 * 60

/**
 * Reads the precomputed totals. The aggregates scan every row, which is slow
 * enough to notice over a long network hop, and they only change when the
 * indexer runs — so the dashboard reads one cached row instead.
 */
export async function getStats(): Promise<Stats> {
  try {
    const cached = await db().execute(
      'SELECT payload, computed_at FROM stats_cache WHERE id = 1'
    )
    if (cached.rows.length > 0) {
      const row = cached.rows[0] as unknown as { payload: string; computed_at: number }
      if (now() - Number(row.computed_at) < STATS_TTL_SECONDS) {
        const parsed = JSON.parse(String(row.payload)) as Stats
        // A payload written before the shape changed is discarded rather than
        // served: the deploy that changes the shape would otherwise hand the
        // dashboard a structure it cannot read.
        if (Array.isArray(parsed?.cells) && Array.isArray(parsed?.perAgent)) {
          return parsed
        }
      }
    }
  } catch {
    // A missing or unreadable cache is not a failure — recompute below.
  }
  return refreshStats()
}

/** When the index was last refreshed, so the UI can show how current it is. */
export async function getIndexFreshness(): Promise<number | null> {
  try {
    const result = await db().execute('SELECT computed_at FROM stats_cache WHERE id = 1')
    if (result.rows.length === 0) return null
    return Number((result.rows[0] as unknown as { computed_at: number }).computed_at)
  } catch {
    return null
  }
}

/** Recomputes the totals and stores them. Called at the end of every index run. */
export async function refreshStats(): Promise<Stats> {
  const stats = await computeStats()
  await db().execute({
    sql: `INSERT INTO stats_cache (id, payload, computed_at) VALUES (1, ?, ?)
          ON CONFLICT (id) DO UPDATE SET
            payload = excluded.payload, computed_at = excluded.computed_at`,
    args: [JSON.stringify(stats), now()],
  })
  return stats
}

async function computeStats(): Promise<Stats> {
  const [grid, perAgent] = await Promise.all([
    db().execute(
      `SELECT r.day AS day, g.name AS name, count(*) AS n, sum(r.sz) AS bytes
       FROM recordings r JOIN groups g ON g.id = r.g
       WHERE r.day IS NOT NULL
       GROUP BY r.day, g.name
       ORDER BY r.day`
    ),
    db().execute(
      `SELECT a.name, count(*) AS n FROM recordings r
       JOIN agents a ON a.id = r.a GROUP BY a.name ORDER BY n DESC`
    ),
  ])

  return {
    cells: grid.rows.map((r) => {
      const row = r as unknown as { day: number; name: string; n: number; bytes: number }
      return {
        day: Number(row.day),
        group: String(row.name),
        count: Number(row.n),
        bytes: Number(row.bytes ?? 0),
      }
    }),
    perAgent: perAgent.rows.map((r) => {
      const row = r as unknown as { name: string; n: number }
      return { name: String(row.name), count: Number(row.n) }
    }),
  }
}

/* ---------------------------------------------------------------- throttling */

const MAX_FAILS = 3
const FIRST_BLOCK_SECONDS = 5 * 60
const REPEAT_BLOCK_SECONDS = 30 * 60

export type Throttle = { blocked: boolean; retryAfter: number; remaining: number }

const now = () => Math.floor(Date.now() / 1000)

export async function checkThrottle(ip: string | null): Promise<Throttle> {
  if (!ip) return { blocked: false, retryAfter: 0, remaining: MAX_FAILS }

  const result = await db().execute({
    sql: 'SELECT fails, blocked_until FROM login_attempts WHERE ip = ? LIMIT 1',
    args: [ip],
  })
  if (result.rows.length === 0) return { blocked: false, retryAfter: 0, remaining: MAX_FAILS }

  const row = result.rows[0] as unknown as { fails: number; blocked_until: number | null }
  const until = Number(row.blocked_until ?? 0)
  if (until > now()) {
    return { blocked: true, retryAfter: until - now(), remaining: 0 }
  }
  return { blocked: false, retryAfter: 0, remaining: Math.max(0, MAX_FAILS - Number(row.fails ?? 0)) }
}

/**
 * Counts a failure and blocks once the attempt limit is hit. The first block is
 * short; every block after that is long, so a persistent guesser is slowed far
 * more than someone who simply mistyped.
 */
export async function recordFailure(ip: string | null): Promise<Throttle> {
  if (!ip) return { blocked: false, retryAfter: 0, remaining: MAX_FAILS }

  const result = await db().execute({
    sql: 'SELECT fails, strikes FROM login_attempts WHERE ip = ? LIMIT 1',
    args: [ip],
  })
  const prev = result.rows[0] as unknown as { fails: number; strikes: number } | undefined
  const fails = Number(prev?.fails ?? 0) + 1
  let strikes = Number(prev?.strikes ?? 0)
  let blockedUntil: number | null = null
  let nextFails = fails

  if (fails >= MAX_FAILS) {
    strikes += 1
    blockedUntil = now() + (strikes <= 1 ? FIRST_BLOCK_SECONDS : REPEAT_BLOCK_SECONDS)
    nextFails = 0 // the counter restarts; the strike count is what escalates
  }

  await db().execute({
    sql: `INSERT INTO login_attempts (ip, fails, strikes, blocked_until, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (ip) DO UPDATE SET
            fails = excluded.fails, strikes = excluded.strikes,
            blocked_until = excluded.blocked_until, updated_at = excluded.updated_at`,
    args: [ip, nextFails, strikes, blockedUntil, now()],
  })

  return blockedUntil
    ? { blocked: true, retryAfter: blockedUntil - now(), remaining: 0 }
    : { blocked: false, retryAfter: 0, remaining: MAX_FAILS - fails }
}

/** Clears the counter on success, but keeps nothing that would reset escalation. */
export async function clearFailures(ip: string | null): Promise<void> {
  if (!ip) return
  await db().execute({ sql: 'DELETE FROM login_attempts WHERE ip = ?', args: [ip] })
}

/* -------------------------------------------------------------------- users */

export type StoredUser = { username: string; passwordHash: string }

/** Usernames are email addresses, which are not case sensitive in practice. */
export const normaliseUser = (username: string) => username.trim().toLowerCase()

/**
 * Reads the credential, seeding it from the environment the first time so an
 * existing deployment keeps working after this table was introduced.
 */
export async function getUser(username: string): Promise<StoredUser | null> {
  const key = normaliseUser(username)
  const found = await db().execute({
    sql: 'SELECT username, password_hash FROM users WHERE lower(username) = ? LIMIT 1',
    args: [key],
  })
  if (found.rows.length > 0) {
    const r = found.rows[0] as unknown as { username: string; password_hash: string }
    return { username: String(r.username), passwordHash: String(r.password_hash) }
  }

  const seedUser = process.env.ADMIN_USERNAME
  const seedHash = process.env.ADMIN_PASSWORD_HASH
  if (!seedUser || !seedHash || normaliseUser(seedUser) !== key) return null

  const any = await db().execute('SELECT 1 FROM users LIMIT 1')
  if (any.rows.length > 0) return null // credentials already managed in the table

  await db().execute({
    sql: `INSERT INTO users (username, password_hash, updated_at) VALUES (?, ?, ?)
          ON CONFLICT (username) DO NOTHING`,
    args: [seedUser, seedHash, now()],
  })
  return { username: seedUser, passwordHash: seedHash }
}

export async function setPassword(username: string, passwordHash: string): Promise<void> {
  await db().execute({
    sql: `UPDATE users SET password_hash = ?, updated_at = ? WHERE lower(username) = ?`,
    args: [passwordHash, now(), normaliseUser(username)],
  })
}

export type SecurityChallenge = { question: string; answerHash: string } | null

export async function getSecurityChallenge(username: string): Promise<SecurityChallenge> {
  const result = await db().execute({
    sql: `SELECT security_question AS q, security_answer_hash AS a
          FROM users WHERE lower(username) = ? LIMIT 1`,
    args: [normaliseUser(username)],
  })
  if (result.rows.length === 0) return null
  const r = result.rows[0] as unknown as { q: string | null; a: string | null }
  if (!r.q || !r.a) return null
  return { question: String(r.q), answerHash: String(r.a) }
}

export async function setSecurityChallenge(
  username: string,
  question: string,
  answerHash: string
): Promise<void> {
  await db().execute({
    sql: `UPDATE users SET security_question = ?, security_answer_hash = ?, updated_at = ?
          WHERE lower(username) = ?`,
    args: [question, answerHash, now(), normaliseUser(username)],
  })
}

/** Guards the presign endpoint: only keys present in the index can be signed. */
export async function recordingExists(key: string): Promise<boolean> {
  const parts = splitKey(key)
  if (!parts) return false
  const result = await db().execute({
    sql: `SELECT 1 FROM recordings r JOIN groups g ON g.id = r.g
          WHERE g.name = ? AND r.dir = ? AND r.fn = ? LIMIT 1`,
    args: [parts.group, parts.dir, parts.fn],
  })
  return result.rows.length > 0
}
