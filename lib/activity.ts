/**
 * The activity log.
 *
 * What this replaces: a `console.info('[audit] …')` line in the play endpoint.
 * On Vercel those logs roll off within days, so the question the admin actually
 * wants answered — "who listened to this call, and when" — had no answer a
 * week later. These rows are in the same database as the index and stay.
 *
 * What is logged is deliberately narrow: who, what, which recording, from where.
 * No phone numbers and no S3 keys are written here. The log is read by people
 * who are allowed to see numbers anyway, but a log is copied, exported and
 * pasted far more often than a dashboard is, so it holds serials only.
 */

import { db } from './db'
import type { Role } from './db'

export type Action =
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'search'
  | 'play'
  | 'download'
  | 'denied'
  | 'admin_lookup'
  | 'user_created'
  | 'user_changed'

export type ActivityEntry = {
  username: string
  role?: Role | null
  action: Action
  serial?: number | null
  detail?: string | null
  ip?: string | null
  ua?: string | null
}

const now = () => Math.floor(Date.now() / 1000)

/** A user agent string is unbounded; a long one is of no extra use here. */
const trim = (value: string | null | undefined, max: number) =>
  value ? value.slice(0, max) : null

/**
 * Writes one row. Never throws.
 *
 * A failed log must not break playback or sign-in — that would turn a logging
 * outage into an outage of the thing being logged. The failure is reported to
 * the server console so it is still visible to whoever is looking.
 */
export async function logActivity(entry: ActivityEntry): Promise<void> {
  try {
    await db().execute({
      sql: `INSERT INTO activity (ts, username, role, action, serial, detail, ip, ua)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        now(),
        entry.username,
        entry.role ?? null,
        entry.action,
        entry.serial ?? null,
        trim(entry.detail, 500),
        trim(entry.ip, 60),
        trim(entry.ua, 300),
      ],
    })
  } catch (error) {
    console.error('activity log write failed', entry.action, error)
  }
}

/**
 * Whether this play is worth a new row.
 *
 * An audio element fetches a recording in many Range requests, and some
 * browsers fetch the opening twice. Logging each one would bury the log in
 * noise and make "how many calls did this associate review" unanswerable, so a
 * repeat of the same recording by the same person inside the window is treated
 * as the same listening session.
 */
export async function shouldLogPlay(
  username: string,
  serial: number,
  withinSeconds = 300
): Promise<boolean> {
  try {
    const result = await db().execute({
      sql: `SELECT ts FROM activity
            WHERE username = ? AND serial = ? AND action = 'play'
            ORDER BY ts DESC LIMIT 1`,
      args: [username, serial],
    })
    if (result.rows.length === 0) return true
    const ts = Number((result.rows[0] as unknown as { ts: number }).ts)
    return now() - ts > withinSeconds
  } catch {
    // If the check fails, log it. A duplicate row is harmless; a missing one
    // is a hole in the audit trail.
    return true
  }
}

export type ActivityFilter = {
  username?: string
  action?: string
  serial?: number
  from?: number
  to?: number
  limit?: number
  offset?: number
}

export type ActivityRow = {
  id: number
  ts: number
  username: string
  role: string | null
  action: string
  serial: number | null
  detail: string | null
  ip: string | null
  ua: string | null
}

export async function listActivity(filter: ActivityFilter): Promise<ActivityRow[]> {
  const limit = Math.min(filter.limit ?? 100, 500)
  const result = await db().execute({
    sql: `SELECT id, ts, username, role, action, serial, detail, ip, ua
          FROM activity
          WHERE (:username IS NULL OR lower(username) = lower(:username))
            AND (:action   IS NULL OR action = :action)
            AND (:serial   IS NULL OR serial = :serial)
            AND (:from     IS NULL OR ts >= :from)
            AND (:to       IS NULL OR ts <= :to)
          ORDER BY ts DESC, id DESC
          LIMIT :limit OFFSET :offset`,
    args: {
      username: filter.username ?? null,
      action: filter.action ?? null,
      serial: filter.serial ?? null,
      from: filter.from ?? null,
      to: filter.to ?? null,
      limit,
      offset: filter.offset ?? 0,
    },
  })

  return result.rows.map((row) => {
    const r = row as unknown as ActivityRow
    return {
      id: Number(r.id),
      ts: Number(r.ts),
      username: String(r.username),
      role: r.role === null ? null : String(r.role),
      action: String(r.action),
      serial: r.serial === null ? null : Number(r.serial),
      detail: r.detail === null ? null : String(r.detail),
      ip: r.ip === null ? null : String(r.ip),
      ua: r.ua === null ? null : String(r.ua),
    }
  })
}

/** How much each person did, for the summary strip on the activity page. */
export async function activitySummary(
  from: number,
  to: number
): Promise<{ username: string; action: string; n: number }[]> {
  const result = await db().execute({
    sql: `SELECT username, action, count(*) AS n FROM activity
          WHERE ts >= ? AND ts <= ?
          GROUP BY username, action ORDER BY n DESC`,
    args: [from, to],
  })
  return result.rows.map((row) => {
    const r = row as unknown as { username: string; action: string; n: number }
    return { username: String(r.username), action: String(r.action), n: Number(r.n) }
  })
}

/**
 * Drops rows older than the retention window.
 *
 * Called from the nightly job rather than on a request path. A year is long
 * enough to answer a dispute about a call and short enough that the table does
 * not grow without limit.
 */
export async function pruneActivity(keepDays = 365): Promise<number> {
  const cutoff = now() - keepDays * 24 * 60 * 60
  const result = await db().execute({
    sql: 'DELETE FROM activity WHERE ts < ?',
    args: [cutoff],
  })
  return Number(result.rowsAffected ?? 0)
}
