/**
 * The Morpheus S3 keys must be readable by the SAME parser the dashboard uses
 * for every other dialer, or the recordings land in the bucket and never show
 * up in search. This feeds real API rows through buildKey and then back
 * through parseRecording, and fails if anything is lost in the round trip.
 *
 *   npx tsx --env-file=.env.local scripts/test-morpheus-key.ts
 */

import { parseRecording } from '../lib/parse'
import { dialerForGroup } from '../lib/dialers'
import { buildKey, extensionFor, folderForCampaign } from '../lib/morpheus-key'
import type { RecordingRow } from '../lib/morpheus'

const row = (over: Partial<RecordingRow>): RecordingRow => ({
  id: '6ad05d41-fd93-479e-ad1e-31e6192c1fef',
  agent: '321-Closer Shayan Ali ACA',
  agent_user_id: 'u1',
  campaign: 'ACA-CLOSER',
  created_at: '2026-11-24 15:30:45.123456+00',
  duration_sec: 271,
  file_size: 400000,
  destination_number: '2015550123',
  caller_id_number: null,
  download_url: '/x',
  segment: 'transfer',
  direction: 'outbound',
  call_uuid: 'c1',
  lead_id: 'l1',
  finalized_at: null,
  ...over,
})

const cases: { what: string; r: RecordingRow; ext: string; want: Record<string, string | null> }[] = [
  {
    what: 'ACA closer, transferred leg',
    r: row({}),
    ext: 'm4a',
    want: { group: 'Morpheus_ACA_Closer', agent: '321-Shayan-Ali', phone: '2015550123', dialer: 'Morpheus' },
  },
  {
    what: 'Medicare closer, WAV',
    r: row({ campaign: 'Med-Closer', agent: '326-Closer Saad Khan MedC', destination_number: '12015550147' }),
    ext: 'wav',
    want: { group: 'Morpheus_Med_Closer', agent: '326-Saad-Khan', phone: '2015550147', dialer: 'Morpheus' },
  },
  {
    what: 'self verifier',
    r: row({ campaign: 'ACA-Self Verifier', agent: '157-Syed Noor', segment: 'full' }),
    ext: 'm4a',
    want: { group: 'Morpheus_Self_Verifier', agent: '157-Syed-Noor', phone: '2015550123', dialer: 'Morpheus' },
  },
  {
    what: 'no agent on the record',
    r: row({ agent: '' }),
    ext: 'm4a',
    want: { group: 'Morpheus_ACA_Closer', agent: 'NOAGENT', phone: '2015550123', dialer: 'Morpheus' },
  },
  {
    what: 'no customer number',
    r: row({ destination_number: null, caller_id_number: null }),
    ext: 'm4a',
    want: { group: 'Morpheus_ACA_Closer', agent: '321-Shayan-Ali', phone: null, dialer: 'Morpheus' },
  },
]

let failures = 0

for (const c of cases) {
  const key = buildKey(c.r, { ext: c.ext })
  if (!key) { failures++; console.log(`FAIL  ${c.what}: buildKey returned null`); continue }

  const p = parseRecording(key)
  const got: Record<string, string | null> = {
    group: p.group,
    agent: p.agent,
    phone: p.phone,
    dialer: dialerForGroup(p.group ?? ''),
  }

  const problems: string[] = []
  if (!p.parsed) problems.push('the parser did not recognise it as a recording')
  if (p.recordedAt !== '2026-11-24T15:30:45Z') problems.push(`recordedAt: got ${p.recordedAt}`)
  for (const [k, want] of Object.entries(c.want)) {
    if (got[k] !== want) problems.push(`${k}: wanted ${want}, got ${got[k]}`)
  }
  // The uuid has to survive so an object can be traced back to the API record.
  if (!key.includes(c.r.id.replace(/-/g, ''))) problems.push('the recording id is not in the key')

  console.log(`${problems.length ? 'FAIL' : 'ok  '}  ${c.what}`)
  console.log(`        ${key}`)
  if (problems.length) { failures++; problems.forEach((x) => console.log(`        ${x}`)) }
  else console.log(`        group=${p.group} agent=${p.agent} phone=${p.phone ?? '—'} at=${p.recordedAt}`)
}

// Campaigns that are out of scope must not be filed anywhere.
for (const c of ['Fronter', '', 'Bots campaign']) {
  const f = folderForCampaign(c)
  if (f === null) console.log(`ok    campaign ${JSON.stringify(c)} correctly has no folder`)
  else { failures++; console.log(`FAIL  campaign ${JSON.stringify(c)} mapped to ${f}`) }
}

// The extension must follow what the server actually served, since the format
// changed mid-archive.
for (const [ct, want] of [['audio/wav', 'wav'], ['audio/mp4', 'm4a'], ['audio/mpeg', 'mp3']] as const) {
  const got = extensionFor(ct)
  if (got === want) console.log(`ok    ${ct} -> .${got}`)
  else { failures++; console.log(`FAIL  ${ct} -> .${got}, wanted .${want}`) }
}

console.log(failures === 0 ? '\nall cases passed' : `\n${failures} case(s) failed`)
process.exit(failures === 0 ? 0 : 1)
