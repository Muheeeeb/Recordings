/**
 * The disposition of every closer recording, day by day.
 *
 * Needed because the sale is not marked where it was first assumed. The
 * self-verifier campaign carried `SALE`, but that campaign stopped running on
 * 10 Nov — 4,035 calls on 9 Nov, 113 on 11 Nov, nothing after 18 Nov. Sales
 * since then are on the closers, under `SALESA`, which an earlier check missed
 * because it compared against the exact string "SALE".
 *
 * So this collects EVERY code rather than looking for one, and reports
 * anything sale-shaped separately. No endpoint filters on disposition (a
 * nonsense value returns the whole archive), so it is one lookup per call.
 *
 * Read-only.
 *
 *   npx tsx --env-file=.env.local scripts/morpheus-closer-dispositions.ts
 */

import { readFileSync, writeFileSync, createWriteStream } from 'node:fs'
import { instances } from '../lib/morpheus'

const SALE_LIKE = /^(sale|sales|sold|salesa|sale-a|sale_a)$/i

async function disposition(base: string, headers: Record<string, string>, uuid: string) {
  for (let a = 0; a < 3; a++) {
    const res = await fetch(`${base}/calls/${uuid}`, { headers })
    if (res.ok) return String((await res.json()).disposition_code ?? '').trim()
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 400 * (a + 1))); continue }
    return null
  }
  return null
}

/**
 * One line of morpheus-manifest.jsonl, as much of it as this script reads.
 * The index signature keeps the rest of the record reachable, because each
 * matching leg is written back out verbatim.
 */
type ManifestRow = {
  scope?: string
  call_uuid?: string | null
  created_at: string
  file_size?: number | null
  [field: string]: unknown
}

async function main() {
  const inst = instances()[0]
  const rows = readFileSync('morpheus-manifest.jsonl', 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l) as ManifestRow)
    .filter((r) => r.scope === 'closer')

  // One lookup per CALL, not per recording — several legs share a call_uuid.
  const byCall = new Map<string, ManifestRow[]>()
  for (const r of rows) {
    if (!r.call_uuid) continue
    byCall.set(r.call_uuid, [...(byCall.get(r.call_uuid) ?? []), r])
  }
  console.log(`${rows.length.toLocaleString()} closer recordings = ${byCall.size.toLocaleString()} distinct calls to look up\n`)

  const out = createWriteStream('morpheus-closer-sales.jsonl', { flags: 'w' })
  const codes = new Map<string, number>()
  const byDay = new Map<string, { calls: number; sale: number; recs: number; bytes: number }>()
  let done = 0, failed = 0

  const queue = [...byCall.entries()]
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        const [uuid, legs] = item
        const d = await disposition(inst.base, inst.headers, uuid)
        if (d === null) failed++
        const code = d === null ? '(lookup failed)' : d || '(empty)'
        codes.set(code, (codes.get(code) ?? 0) + 1)

        const day = legs[0].created_at.slice(0, 10)
        const c = byDay.get(day) ?? { calls: 0, sale: 0, recs: 0, bytes: 0 }
        c.calls++
        if (SALE_LIKE.test(code)) {
          c.sale++
          c.recs += legs.length
          c.bytes += legs.reduce((s: number, l: ManifestRow) => s + (l.file_size ?? 0), 0)
          for (const l of legs) out.write(JSON.stringify({ ...l, disposition: code }) + '\n')
        }
        byDay.set(day, c)
        if (++done % 500 === 0) process.stdout.write(`  ${done}/${byCall.size}\r`)
      }
    })
  )
  out.end()
  console.log(`  ${done}/${byCall.size} done          \n`)

  console.log('every disposition on closer calls:')
  for (const [c, n] of [...codes].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${c.padEnd(18)} ${String(n).padStart(6)}${SALE_LIKE.test(c) ? '   <-- sale' : ''}`)
  }
  if (failed) console.log(`   (${failed} lookups failed)`)

  console.log('\nSALES PER DAY (closers)')
  console.log('day            calls   SALE   recordings      size')
  let tc = 0, ts = 0, tr = 0, tb = 0
  for (const day of [...byDay.keys()].sort()) {
    const c = byDay.get(day)!
    tc += c.calls; ts += c.sale; tr += c.recs; tb += c.bytes
    console.log(`${day}   ${String(c.calls).padStart(6)}   ${String(c.sale).padStart(4)}   ${String(c.recs).padStart(10)}   ${(c.bytes / 1024 ** 2).toFixed(0).padStart(6)} MB`)
  }
  console.log(`TOTAL          ${String(tc).padStart(6)}   ${String(ts).padStart(4)}   ${String(tr).padStart(10)}   ${(tb / 1024 ** 2).toFixed(0).padStart(6)} MB`)

  writeFileSync('morpheus-closer-sales-summary.json', JSON.stringify({
    checkedAt: new Date().toISOString(),
    recordings: rows.length, calls: byCall.size,
    dispositions: Object.fromEntries(codes),
    perDay: Object.fromEntries(byDay),
    totals: { calls: tc, sales: ts, saleRecordings: tr, saleBytes: tb },
  }, null, 2))
  console.log('\nsale recordings: morpheus-closer-sales.jsonl')
}

main().catch((e) => { console.error(e); process.exit(1) })
