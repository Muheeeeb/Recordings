/**
 * Serial numbers: the only way the QA portal names a recording.
 *
 * Why a serial exists at all. Everything that identifies a recording today
 * contains the customer's phone number — the filename has it, and so the S3
 * key has it, and so does a presigned URL. QA must not see the number, so QA
 * cannot be given a key, a filename, or a link that contains either. It gets a
 * serial, writes that serial on its report, and the admin pastes the serial
 * back here to find the real call.
 *
 * Why not reuse recordings.id. SQLite reuses the rowid of a deleted row unless
 * the column is AUTOINCREMENT, and prune-index.ts deletes rows whose object has
 * gone from S3. A serial written on last month's report could then resolve to a
 * different call — exactly the failure an audit trail must not have. The
 * serials table is AUTOINCREMENT, which never reissues a value.
 *
 * Why the identity is (g, dir, fn). That is the same triple recordingExists()
 * uses, and it survives the index being pruned and rebuilt, so a recording that
 * disappears from the index and comes back keeps the serial it was issued.
 *
 * Note on guessability: serials run in sequence, so a QA associate can type the
 * next number and reach another recording. That is deliberate — QA is allowed
 * to review recordings in the groups it was granted, and the group check in
 * lib/qa.ts is what enforces that, not the opacity of the number. If review
 * ever has to be restricted to assigned work, that belongs in an assignment
 * table, not in making the serial unguessable.
 */

import { db } from './db'

/** `PN-0000123`. Padded so serials written by hand sort and line up. */
export function formatSerial(serial: number): string {
  return `PN-${String(serial).padStart(7, '0')}`
}

/**
 * Accepts what a person is likely to type or paste: `PN-0000123`, `pn-123`,
 * `0000123`, `123`, with stray spaces. Anything else is rejected rather than
 * coerced, so a mistyped serial fails loudly instead of opening the wrong call.
 */
export function parseSerial(input: string): number | null {
  const cleaned = input.trim().toUpperCase().replace(/\s+/g, '')
  const m = /^(?:PN-?)?(\d{1,15})$/.exec(cleaned)
  if (!m) return null
  const value = Number(m[1])
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export type RecordingRef = { group: string; dir: string; fn: string }

/**
 * Issues serials for a page of recordings, reusing any that already exist.
 *
 * The upsert is `DO UPDATE SET issued_at = issued_at` rather than `DO NOTHING`
 * because DO NOTHING returns no row on conflict, and this needs the serial back
 * whether it was just created or issued months ago. The whole page goes in one
 * batch, so a 50-row page costs one round trip rather than fifty.
 *
 * Returned keyed by `group\u0000dir\u0000fn` — a separator that cannot occur in any
 * of the three parts.
 */
export async function issueSerials(refs: RecordingRef[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (refs.length === 0) return out

  const groups = await db().execute('SELECT id, name FROM groups')
  const ids = new Map(
    groups.rows.map((r) => {
      const row = r as unknown as { id: number; name: string }
      return [String(row.name), Number(row.id)]
    })
  )

  const issued = Math.floor(Date.now() / 1000)
  const usable = refs.filter((r) => ids.has(r.group))
  if (usable.length === 0) return out

  const results = await db().batch(
    usable.map((r) => ({
      sql: `INSERT INTO serials (g, dir, fn, issued_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (g, dir, fn) DO UPDATE SET issued_at = issued_at
            RETURNING serial`,
      args: [ids.get(r.group)!, r.dir, r.fn, issued],
    })),
    'write'
  )

  results.forEach((result, i) => {
    const row = result.rows[0] as unknown as { serial: number } | undefined
    if (row) out.set(refKey(usable[i]), Number(row.serial))
  })
  return out
}

export const refKey = (r: RecordingRef) => `${r.group}\u0000${r.dir}\u0000${r.fn}`

/**
 * The recording a serial refers to, or null.
 *
 * This is the privileged direction — it hands back the filename, which contains
 * the phone number — so every caller must already have established that the
 * session is an admin, or (for streaming) that the QA user is allowed the
 * group this returns.
 */
export async function resolveSerial(serial: number): Promise<RecordingRef | null> {
  const result = await db().execute({
    sql: `SELECT g.name AS name, s.dir AS dir, s.fn AS fn
          FROM serials s JOIN groups g ON g.id = s.g
          WHERE s.serial = ? LIMIT 1`,
    args: [serial],
  })
  if (result.rows.length === 0) return null
  const r = result.rows[0] as unknown as { name: string; dir: string; fn: string }
  return { group: String(r.name), dir: String(r.dir), fn: String(r.fn) }
}
