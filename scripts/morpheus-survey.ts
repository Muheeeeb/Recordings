/**
 * Surveys a few hundred recordings to answer what the docs do not: which
 * campaigns exist, how often the agent field is actually filled, and whether
 * the undocumented from/to filter works.
 *
 *   npx tsx --env-file=.env.local scripts/morpheus-survey.ts
 */

const HOST = process.env.MORPHEUS_HOST!
const KEY = process.env.MORPHEUS_API_KEY!
const BASE = `https://${HOST}/api/v1/call-control`

type Rec = {
  id: string
  campaign: string
  agent: string
  agent_user_id: string
  caller_id_number: string
  destination_number: string
  direction: string
  duration_sec: number
  file_size: number
  created_at: string
  finalized_at: string | null
}

async function page(offset: number, limit = 100): Promise<Rec[]> {
  const res = await fetch(`${BASE}/recordings?limit=${limit}&offset=${offset}`, {
    headers: { 'X-API-Key': KEY, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`list failed ${res.status}`)
  return (await res.json()).recordings ?? []
}

async function main() {
  const all: Rec[] = []
  for (let off = 0; off < 500; off += 100) {
    const p = await page(off)
    all.push(...p)
    if (p.length < 100) break
  }
  console.log(`sampled ${all.length} recordings\n`)

  const campaigns = new Map<string, number>()
  let withAgent = 0
  let withAudio = 0
  let finalized = 0
  const dates = new Set<string>()

  for (const r of all) {
    campaigns.set(r.campaign || '(blank)', (campaigns.get(r.campaign || '(blank)') ?? 0) + 1)
    if (r.agent) withAgent++
    if ((r.file_size ?? 0) > 0) withAudio++
    if (r.finalized_at) finalized++
    dates.add((r.created_at || '').slice(0, 10))
  }

  console.log('campaigns:')
  for (const [c, n] of [...campaigns.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(4)}  ${c}`)
  }

  console.log(`\nagent field filled : ${withAgent} / ${all.length}`)
  console.log(`file_size > 0      : ${withAudio} / ${all.length}`)
  console.log(`finalized_at set   : ${finalized} / ${all.length}`)
  const ds = [...dates].filter(Boolean).sort()
  console.log(`dates covered      : ${ds[0]} .. ${ds[ds.length - 1]}  (${ds.length} days)`)

  // The docs never say what from/to accept, so try the obvious spellings.
  console.log('\nfrom/to filter:')
  for (const probe of ['from=2026-11-01', 'from=2026-11-01&to=2026-11-14',
                       'from=2026-11-01T00:00:00Z', 'from=1762000000']) {
    try {
      const res = await fetch(`${BASE}/recordings?limit=1&${probe}`, {
        headers: { 'X-API-Key': KEY, Accept: 'application/json' },
      })
      const txt = await res.text()
      let note = ''
      if (res.ok) {
        const recs = JSON.parse(txt).recordings ?? []
        note = recs.length ? `oldest returned ${recs[0].created_at?.slice(0, 10)}` : 'empty result'
      } else {
        note = txt.slice(0, 90).replace(/\s+/g, ' ')
      }
      console.log(`   ${probe.padEnd(34)} ${res.status}  ${note}`)
    } catch {
      console.log(`   ${probe.padEnd(34)} error`)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })

// Keeps this file a module so its top-level names stay file-scoped.
export {}
