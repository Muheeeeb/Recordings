/**
 * What a QA associate is allowed to receive.
 *
 * Masking is done here, in SQL, and not in the UI. The reason is that the phone
 * number lives in three places — the `phone` column, the filename, and
 * therefore the S3 key — so a template that simply declines to render it still
 * ships it in the JSON. Everything in this file is built so the number never
 * reaches a response in the first place: the queries select `substr(phone, -4)`
 * rather than `phone`, and the row type has no field that could hold a key or a
 * filename.
 *
 * Two rules worth stating because they are easy to undo by accident:
 *
 * 1. A QA account sees only the groups it has been granted (lib/users.ts), and
 *    an account with no grants sees nothing. Every function here takes that
 *    list and intersects with it; none of them has an "all groups" mode.
 *
 * 2. QA cannot search by number. Not because the number is hard to type, but
 *    because a search that answers "does this number exist" is an oracle:
 *    somebody with a list of numbers could confirm each one against the
 *    archive, which defeats the masking entirely. Digits are read as a serial
 *    and nothing else.
 */

import { db } from './db'
import { issueSerials, parseSerial, refKey, type RecordingRef } from './serials'

/**
 * Everything a reviewer needs and nothing more.
 *
 * There is intentionally no `key`, no `fn` and no `phone` field. Adding one
 * would make every endpoint in app/api/qa leak by default, which is why the
 * shape is the guard rather than the callers being careful.
 */
export type QaRow = {
  serial: number
  group: string
  agent: string | null
  recordedAt: number | null
  leadId: number | null
  phoneLast4: string | null
  sizeBytes: number | null
}

export type QaSearchParams = {
  q?: string
  group?: string
  from?: number
  to?: number
  limit?: number
  offset?: number
}

export type QaSearchResult =
  | { ok: true; rows: QaRow[] }
  | { ok: false; reason: 'no-groups' | 'not-granted' | 'numeric-search' }

type InternalRow = RecordingRef & {
  agent: string | null
  ts: number | null
  lead: number | null
  last4: string | null
  sz: number | null
}

/**
 * The rows a QA user may see, newest first.
 *
 * `allowed` is the group list from the user's grants. It is never widened here:
 * an empty list returns no-access rather than everything, so a new or
 * misconfigured account fails closed.
 */
export async function qaSearch(
  params: QaSearchParams,
  allowed: string[]
): Promise<QaSearchResult> {
  if (allowed.length === 0) return { ok: false, reason: 'no-groups' }

  // A group filter is only honoured if it is one of the granted groups; asking
  // for anything else narrows to nothing rather than reaching outside.
  //
  // The two refusals are distinguished because they mean different things to
  // the person reading the message — "nobody has given you access yet" is a
  // thing to raise with an admin, while "not that group" is a stale bookmark.
  // Neither reveals whether the group asked for exists.
  const groups = params.group ? allowed.filter((g) => g === params.group) : allowed
  if (groups.length === 0) return { ok: false, reason: 'not-granted' }

  const term = (params.q ?? '').trim()
  const limit = Math.min(params.limit ?? 50, 200)

  // Rule 2 above: digits mean a serial. Anything else numeric is refused
  // rather than quietly matched against the agent name, so the caller can say
  // why instead of showing an empty result that looks like "no such call".
  let serial: number | null = null
  if (term) {
    serial = parseSerial(term)
    if (serial === null && /^[\d\s()+-]+$/.test(term)) {
      return { ok: false, reason: 'numeric-search' }
    }
  }

  const args: Record<string, string | number | null> = {
    serial,
    like: serial === null && term ? `%${term}%` : null,
    from: params.from ?? null,
    to: params.to ?? null,
    limit,
    offset: params.offset ?? 0,
  }
  const placeholders = groups.map((name, i) => {
    args[`g${i}`] = name
    return `:g${i}`
  })

  // The join to `serials` is a LEFT JOIN because a recording has no serial
  // until it is first shown. Rows that come back without one are issued a
  // serial below and the mapping is filled in, so the caller always sees one.
  const result = await db().execute({
    sql: `
      SELECT g.name AS "group", r.dir AS dir, r.fn AS fn,
             a.name AS agent, r.ts AS ts, r.lead AS lead, r.sz AS sz,
             substr(CAST(r.phone AS TEXT), -4) AS last4,
             s.serial AS serial
      FROM recordings r
      JOIN groups g ON g.id = r.g
      LEFT JOIN agents a ON a.id = r.a
      LEFT JOIN serials s ON s.g = r.g AND s.dir = r.dir AND s.fn = r.fn
      WHERE g.name IN (${placeholders.join(', ')})
        AND (:from   IS NULL OR r.ts >= :from)
        AND (:to     IS NULL OR r.ts <= :to)
        AND (:serial IS NULL OR s.serial = :serial)
        AND (:like   IS NULL OR a.name LIKE :like)
      ORDER BY r.ts DESC
      LIMIT :limit OFFSET :offset`,
    args,
  })

  const internal: (InternalRow & { serial: number | null })[] = result.rows.map((row) => {
    const r = row as unknown as {
      group: string
      dir: string
      fn: string
      agent: string | null
      ts: number | null
      lead: number | null
      sz: number | null
      last4: string | null
      serial: number | null
    }
    return {
      group: String(r.group),
      dir: String(r.dir),
      fn: String(r.fn),
      agent: r.agent === null ? null : String(r.agent),
      ts: r.ts === null ? null : Number(r.ts),
      lead: r.lead === null ? null : Number(r.lead),
      sz: r.sz === null ? null : Number(r.sz),
      last4: r.last4 === null ? null : String(r.last4).padStart(4, '0'),
      serial: r.serial === null ? null : Number(r.serial),
    }
  })

  const missing = internal.filter((r) => r.serial === null)
  const issued = await issueSerials(missing.map(({ group, dir, fn }) => ({ group, dir, fn })))

  const rows: QaRow[] = []
  for (const r of internal) {
    const serialValue = r.serial ?? issued.get(refKey(r)) ?? null
    // A row that could not be issued a serial is dropped rather than returned
    // without one: there would be no way for QA to refer to it on a report, and
    // no way to log what was played.
    if (serialValue === null) continue
    rows.push({
      serial: serialValue,
      group: r.group,
      agent: r.agent,
      recordedAt: r.ts,
      leadId: r.lead,
      phoneLast4: r.last4,
      sizeBytes: r.sz,
    })
  }

  return { ok: true, rows }
}

/**
 * Resolves a serial for streaming, enforcing the group grant.
 *
 * Returns the recording's parts — which include the filename, and therefore the
 * number — so this is only ever called on the server to build an S3 key. It is
 * never used to build a response body.
 */
export async function qaResolve(
  serial: number,
  allowed: string[]
): Promise<RecordingRef | null> {
  if (allowed.length === 0) return null
  const result = await db().execute({
    sql: `SELECT g.name AS name, s.dir AS dir, s.fn AS fn
          FROM serials s JOIN groups g ON g.id = s.g
          WHERE s.serial = ? LIMIT 1`,
    args: [serial],
  })
  if (result.rows.length === 0) return null
  const r = result.rows[0] as unknown as { name: string; dir: string; fn: string }
  const group = String(r.name)
  if (!allowed.includes(group)) return null
  return { group, dir: String(r.dir), fn: String(r.fn) }
}

/** The granted groups that actually hold recordings, for the filter dropdown. */
export async function qaGroups(allowed: string[]): Promise<string[]> {
  if (allowed.length === 0) return []
  const placeholders = allowed.map((_, i) => `:g${i}`)
  const args: Record<string, string> = {}
  allowed.forEach((name, i) => (args[`g${i}`] = name))
  const result = await db().execute({
    sql: `SELECT name FROM groups WHERE name IN (${placeholders.join(', ')}) ORDER BY name`,
    args,
  })
  return result.rows.map((r) => String((r as unknown as { name: string }).name))
}
