/**
 * Shared helpers for talking to the Morpheus dialer API.
 *
 * What the API will and will not do, established by probing it directly:
 *
 *   - `limit` is capped at 100 however large a value is sent.
 *   - `count=exact` puts the true total in the Content-Range header.
 *   - `from`/`to` work, and `to` is EXCLUSIVE, so one day is [d, d+1).
 *   - `agent_user_id` is the only other filter honoured.
 *   - `campaign=`, `agent=`, `agent_name=`, `agent_id=` are all silently
 *     IGNORED — they return the whole archive for any value, including a
 *     nonsense one, so a query built on them looks like it worked and is
 *     meaningless.
 *   - `/agents` is 404; `/users` and `/campaigns` are 403 for our key.
 *
 * Identity is the subtle part. Each recording carries an `agent` label:
 *
 *     305-Closer Ahmad Hassan ACA          144-Sami Ullah Khan
 *     ^^^ dialer id                        ^^^ dialer id
 *         ^^^^^^ role     ^^^^ product         ^^^^^^^^^^^^^^ name
 *
 * A given agent_user_id only ever appears under one label, so when an agent's
 * dialer id is reassigned they get a new label AND a new uuid — thirteen
 * people in the roster already hold two ids each. The dialer id and the uuid
 * are therefore both unstable over time, and the name is the only part that
 * survives a renumbering. Anything that needs "everything this person
 * recorded" has to resolve the name to every uuid it has ever had.
 */

export type RecordingRow = {
  id: string
  agent: string | null
  agent_user_id: string | null
  campaign: string | null
  created_at: string
  duration_sec: number | null
  file_size: number | null
  destination_number: string | null
  caller_id_number: string | null
  download_url: string | null
  /**
   * Which leg of the call this recording is. `full` is a plain call; the other
   * two appear when a call was passed on — `transfer` is the transferred leg
   * (a fronter's XFER, and the closer's side of it) and `agent` is the agent
   * leg of the same call. A transferred call therefore produces more than one
   * recording under one call_uuid.
   */
  segment: string | null
  direction: string | null
  call_uuid: string | null
  lead_id: string | null
  finalized_at: string | null
}

/** An XFER: the dialer records the transferred leg under this segment. */
export const isTransfer = (segment: string | null) =>
  (segment ?? '').trim().toLowerCase() === 'transfer'

/** One label the dialer has written, with everything known about it. */
export type Entry = {
  /** Which Morpheus server this label and uuid belong to. */
  instance: string
  /** The label exactly as the dialer writes it. */
  label: string
  dialerId: string | null
  name: string
  product: string | null
  role: string | null
  uuid: string
  seen: number
  first: string
  last: string
}

export type Roster = {
  scannedAt: string
  /** Per-instance archive size at scan time, keyed by instance label. */
  archiveTotal: Record<string, number>
  sampledPages: number
  labels: Entry[]
}

export const ROSTER_FILE = 'morpheus-roster.json'

/** The API returns at most this many rows per page whatever `limit` says. */
export const PAGE = 100

/**
 * One Morpheus server. There are two of them — poshnee.morpheus.cx
 * ("Morpheus 1") and poshnee2.morpheus.cx ("Morpheus 2") — and an API key is
 * issued per server, so each needs its own. Agents, campaigns and recording
 * ids are scoped to one instance and must never be mixed: the same person can
 * exist on both with a different dialer id and a different uuid, so anything
 * written out carries the instance it came from.
 */
export type Instance = {
  /** Short name used in output and filenames. */
  label: string
  host: string
  base: string
  headers: Record<string, string>
}

function makeInstance(label: string, host: string, key: string): Instance {
  return {
    label,
    host,
    base: `https://${host}/api/v1/call-control`,
    headers: { 'X-API-Key': key, Accept: 'application/json' },
  }
}

/**
 * The instances this environment has credentials for.
 *
 * MORPHEUS1_* and MORPHEUS2_* name the two servers explicitly. The older
 * MORPHEUS_HOST / MORPHEUS_API_KEY pair is still honoured and refers to
 * Morpheus 2, which is the only one that was configured at first.
 */
export function instances(): Instance[] {
  const out: Instance[] = []
  const add = (label: string, host?: string, key?: string) => {
    if (host && key && !out.some((i) => i.host === host)) out.push(makeInstance(label, host, key))
  }
  add('morpheus1', process.env.MORPHEUS1_HOST, process.env.MORPHEUS1_API_KEY)
  add('morpheus2', process.env.MORPHEUS2_HOST, process.env.MORPHEUS2_API_KEY)
  add('morpheus2', process.env.MORPHEUS_HOST, process.env.MORPHEUS_API_KEY)
  if (out.length === 0) {
    throw new Error(
      'No Morpheus credentials. Set MORPHEUS1_HOST/MORPHEUS1_API_KEY and/or ' +
        'MORPHEUS2_HOST/MORPHEUS2_API_KEY in .env.local'
    )
  }
  return out
}

/** The single instance, for scripts that still assume one. */
export function api(): Instance {
  return instances()[0]
}

/** "305-Closer Ahmad Hassan ACA" -> id 305, role Closer, name, product ACA. */
export function splitLabel(label: string) {
  const m = /^\s*(\d+)\s*-\s*(.*)$/.exec(label)
  const dialerId = m ? m[1] : null
  let rest = (m ? m[2] : label).trim()

  const role = /^(Closer\s*\d*|Fronter|Self\s*Verifier|Verifier|Agent)\b/i.exec(rest)
  if (role) rest = rest.slice(role[0].length).trim()

  const prod = /\b(ACA|MedC|Medicare|MED)\s*$/i.exec(rest)
  if (prod) rest = rest.slice(0, rest.length - prod[0].length).trim()

  return {
    dialerId,
    role: role ? role[0].replace(/\s+/g, ' ').trim() : null,
    product: prod ? prod[1] : null,
    name: rest,
  }
}

/**
 * Names are compared on letters alone, so "Abdul SUbhan" and "abdul subhan"
 * are the same key. Comparison stays EXACT after normalising: the roster holds
 * "Sami Ullah Khan", "Sami Ullah" and "Sami Khan" as three different people,
 * and a fuzzy match would quietly merge them.
 */
export const nameKey = (name: string) =>
  name.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).join(' ')

/** The archive total, from Content-Range rather than counted by hand. */
export async function exactCount(inst: Instance, qs = ''): Promise<number> {
  const { base, headers } = inst
  const res = await fetch(`${base}/recordings?limit=1&count=exact&${qs}`, { headers })
  if (!res.ok) return -1
  const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')
  return m ? Number(m[1]) : -1
}

/** One page, retrying the failures that are worth retrying. */
export async function fetchPage(inst: Instance, qs: string, offset: number): Promise<RecordingRow[]> {
  const { base, headers } = inst
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${base}/recordings?limit=${PAGE}&offset=${offset}&${qs}`, { headers })
    if (res.ok) return (await res.json()).recordings ?? []
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
      continue
    }
    return []
  }
  return []
}

/** Every recording for one uuid. Pages until a short page ends the list. */
export async function allForAgent(inst: Instance, uuid: string): Promise<RecordingRow[]> {
  const out: RecordingRow[] = []
  for (let off = 0; off <= 100_000; off += PAGE) {
    const recs = await fetchPage(inst, `agent_user_id=${uuid}`, off)
    out.push(...recs)
    if (recs.length < PAGE) break
  }
  return out
}

/** `to` is exclusive, so a single day is the half-open range [d, d+1). */
export function dayRange(day: string): string {
  const n = new Date(`${day}T00:00:00Z`)
  n.setUTCDate(n.getUTCDate() + 1)
  return `from=${day}&to=${n.toISOString().slice(0, 10)}`
}

/**
 * A closer campaign, under any of the names the dialer has used. It started
 * with "Closer" and "Closer2"; on 20 Nov those were renamed "ACA-CLOSER" and
 * "Med-Closer", which is an improvement — the product is now in the campaign
 * itself instead of only in the agent's label. Matching on the word rather
 * than an exact name means the next rename does not silently return nothing,
 * which is how the first one was caught.
 */
export const isCloserCampaign = (campaign: string | null) =>
  /closer/i.test((campaign ?? '').trim())

/** The self-verifier campaign, likewise matched on the word. */
export const isVerifierCampaign = (campaign: string | null) =>
  /verifier/i.test((campaign ?? '').trim())
