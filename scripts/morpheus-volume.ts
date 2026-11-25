/**
 * How much data is actually there, so the minimum-duration decision is made on
 * numbers rather than a guess. Reports the exact total, then samples to build
 * a duration profile and estimate storage per campaign.
 *
 *   npx tsx --env-file=.env.local scripts/morpheus-volume.ts
 */

const HOST = process.env.MORPHEUS_HOST!
const KEY = process.env.MORPHEUS_API_KEY!
const BASE = `https://${HOST}/api/v1/call-control`
const KEEP = new Set(['Fronter', 'Closer', 'Closer2'])

type Rec = { campaign: string; duration_sec: number; file_size: number; created_at: string }

async function main() {
  // count=exact puts the total in Content-Range; the docs call it expensive,
  // so it is asked for once with the smallest possible page.
  const head = await fetch(`${BASE}/recordings?limit=1&count=exact`, {
    headers: { 'X-API-Key': KEY, Accept: 'application/json' },
  })
  console.log(`exact total  : ${head.headers.get('content-range') ?? '(no Content-Range header)'}`)

  const all: Rec[] = []
  for (let off = 0; off < 2000; off += 100) {
    const res = await fetch(`${BASE}/recordings?limit=100&offset=${off}`, {
      headers: { 'X-API-Key': KEY, Accept: 'application/json' },
    })
    if (!res.ok) { console.log(`  stopped at offset ${off}: ${res.status}`); break }
    const recs: Rec[] = (await res.json()).recordings ?? []
    all.push(...recs)
    if (recs.length < 100) break
  }
  console.log(`sampled      : ${all.length} recordings\n`)

  const withAudio = all.filter((r) => (r.file_size ?? 0) > 0)
  const wanted = withAudio.filter((r) => KEEP.has(r.campaign))

  const buckets = [
    ['0-9s', (d: number) => d < 10],
    ['10-29s', (d: number) => d >= 10 && d < 30],
    ['30-59s', (d: number) => d >= 30 && d < 60],
    ['60-179s', (d: number) => d >= 60 && d < 180],
    ['180s+', (d: number) => d >= 180],
  ] as const

  console.log('duration profile (wanted campaigns, audio present)')
  console.log('  bucket      count     share     total size')
  for (const [label, test] of buckets) {
    const b = wanted.filter((r) => test(r.duration_sec ?? 0))
    const mb = b.reduce((s, r) => s + (r.file_size ?? 0), 0) / 1024 ** 2
    const pct = wanted.length ? ((b.length / wanted.length) * 100).toFixed(1) : '0'
    console.log(`  ${label.padEnd(10)} ${String(b.length).padStart(5)}  ${pct.padStart(6)}%   ${mb.toFixed(1).padStart(8)} MB`)
  }

  const totalMb = wanted.reduce((s, r) => s + (r.file_size ?? 0), 0) / 1024 ** 2
  const avgKb = wanted.length ? (totalMb * 1024) / wanted.length : 0
  console.log(`\n  sample total: ${wanted.length} recs, ${totalMb.toFixed(1)} MB, avg ${avgKb.toFixed(0)} KB`)

  for (const cut of [0, 10, 30, 60]) {
    const kept = wanted.filter((r) => (r.duration_sec ?? 0) >= cut)
    const mb = kept.reduce((s, r) => s + (r.file_size ?? 0), 0) / 1024 ** 2
    const pct = wanted.length ? ((kept.length / wanted.length) * 100).toFixed(0) : '0'
    console.log(`  min ${String(cut).padStart(3)}s -> keep ${String(kept.length).padStart(5)} (${pct.padStart(3)}%)  ${mb.toFixed(1).padStart(8)} MB of sample`)
  }

  const days = [...new Set(all.map((r) => (r.created_at || '').slice(0, 10)))].filter(Boolean).sort()
  console.log(`\n  sample covers: ${days[0]} .. ${days[days.length - 1]} (${days.length} day(s))`)
}

main().catch((e) => { console.error(e); process.exit(1) })

// Keeps this file a module so its top-level names stay file-scoped.
export {}
