/**
 * The S3 key a Morpheus recording is stored under.
 *
 * The constraint that shapes this: the dashboard already has a filename parser
 * (lib/parse.ts) written for the VICIdial names the other dialers produce, and
 * the indexer already walks dialer/<Group>/<date>/<file>. Rather than teach
 * those about a second format, Morpheus recordings are named so the existing
 * parser reads them correctly — so they appear in search and on the dashboard
 * with no change to the indexing path at all.
 *
 *   dialer/Morpheus_ACA_Closer/20261124/
 *     20261124-153045_321-Shayan-Ali_2015550123_XFER_6ad05d41fd93479e….m4a
 *     |---- timestamp ----| |- agent -| |- phone -| |seg| |- recording id -|
 *
 * How the parser reads that: it finds the timestamp by matching rather than by
 * position, then classifies the remaining underscore-separated tokens by
 * shape — 10-11 digits is the customer's number, the first non-numeric token
 * is the agent, and the rest is ignored. So the agent token must NOT be bare
 * digits, which is why the dialer id keeps the name attached to it. That also
 * matches what we learned about identity on this API: the dialer id and the
 * uuid both change when an agent is renumbered, and only the name survives, so
 * the name belongs in the key.
 *
 * The recording id is the Morpheus uuid with its dashes stripped. It is in the
 * key so that an object can always be traced back to the API record, and so a
 * re-run can tell what it has already uploaded.
 */

import type { RecordingRow } from './morpheus'
import { splitLabel } from './morpheus'

/** Campaign -> the S3 folder it is filed under. */
export const FOLDERS: { match: RegExp; folder: string }[] = [
  // Matched in order, so the product-specific names win over a bare "closer".
  { match: /aca.*closer/i, folder: 'Morpheus_ACA_Closer' },
  { match: /(med|medicare).*closer/i, folder: 'Morpheus_Med_Closer' },
  { match: /verifier/i, folder: 'Morpheus_Self_Verifier' },
  // The campaigns were renamed once already (Closer -> ACA-CLOSER, Closer2 ->
  // Med-Closer). A closer campaign under a name we have not seen still lands
  // somewhere findable rather than being dropped.
  { match: /closer/i, folder: 'Morpheus_Closer_Other' },
]

export function folderForCampaign(campaign: string | null): string | null {
  const c = (campaign ?? '').trim()
  if (!c) return null
  return FOLDERS.find((f) => f.match.test(c))?.folder ?? null
}

/** Letters, digits and single dashes — safe in a key and in a filename. */
const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

/** "2026-11-24 15:30:45.123+00" -> { day: "20261124", stamp: "20261124-153045" } */
export function keyTimestamp(createdAt: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(createdAt)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  return { day: `${y}${mo}${d}`, stamp: `${y}${mo}${d}-${h}${mi}${s}` }
}

/** The extension to store under, from what the server actually served. */
export function extensionFor(contentType: string | null): string {
  const ct = (contentType ?? '').toLowerCase()
  if (ct.includes('wav')) return 'wav'
  if (ct.includes('mp4') || ct.includes('m4a') || ct.includes('aac')) return 'm4a'
  if (ct.includes('mpeg') || ct.includes('mp3')) return 'mp3'
  if (ct.includes('ogg')) return 'ogg'
  return 'bin'
}

export function buildKey(
  r: RecordingRow,
  opts: { prefix?: string; ext: string }
): string | null {
  const folder = folderForCampaign(r.campaign)
  const t = r.created_at ? keyTimestamp(r.created_at) : null
  if (!folder || !t) return null

  const label = (r.agent ?? '').trim()
  // The role and product are already in the folder, so the agent token keeps
  // just the id and the name — and never bare digits, or the parser would read
  // it as a number and leave the agent empty.
  const parts = splitLabel(label)
  const agent = label
    ? slug([parts.dialerId, parts.name || label].filter(Boolean).join('-')) || 'AGENT'
    : 'NOAGENT'

  const phone = (r.destination_number || r.caller_id_number || '').replace(/\D/g, '')
  const seg = (r.segment ?? '').toLowerCase() === 'transfer' ? 'XFER'
    : (r.segment ?? '').toLowerCase() === 'agent' ? 'AGENTLEG'
    : 'FULL'
  const id = (r.id ?? '').replace(/-/g, '')

  const name = [t.stamp, agent, phone || 'NONUM', seg, id].join('_') + `.${opts.ext}`
  return `${opts.prefix ?? 'dialer/'}${folder}/${t.day}/${name}`
}
