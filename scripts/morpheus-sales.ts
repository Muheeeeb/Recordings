/**
 * Finds the calls that were actually marked as sales.
 *
 * Where the sale lives: the recordings endpoint carries no disposition at all.
 * /calls/{call_uuid} does, and checking the in-scope recordings against it
 * showed the pattern — closers get `Xfer` or `Xfer-M`, because they pass the
 * call on, and `SALE` lands on the SELF-VERIFIER, who is the last step and
 * marks the outcome. So the sales are on the verifier's calls, not the
 * closers'.
 *
 * Why this has to be a walk: `campaign=` is ignored by the recordings
 * endpoint, and no endpoint filters on disposition — a nonsense value like
 * disposition_code=ZZZNOPE returns the whole archive, so a query built on it
 * looks like it worked and means nothing. Only from/to is honoured. So every
 * record is read day by day to find the verifier calls, and each one's
 * call_uuid is then looked up for its disposition.
 *
 * A closer sample is checked too, to confirm SALE really does not appear there
 * rather than assuming it from 300 earlier lookups.
 *
 * Read-only: nothing is downloaded and nothing is uploaded.
 *
 *   npx tsx --env-file=.env.local scripts/morpheus-sales.ts
 */

import { createWriteStream, readFileSync, writeFileSync } from 'node:fs'
import {
  PAGE, dayRange, exactCount, fetchPage, instances,
  isCloserCampaign, isVerifierCampaign, type Instance, type RecordingRow,
} from '../lib/morpheus'

const OUT = 'morpheus-sales.jsonl'
const SUMMARY = 'morpheus-sales-summary.json'
const CLOSER_SAMPLE = 800

const arg = (name: string, fallback: number) => {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? Number(m.split('=')[1]) : fallback
}

type Lite = {
  id: string
  campaign: string | null
  segment: string | null
  agent: string | null
  created_at: string
  duration_sec: number | null
  file_size: number | null
  number: string | null
  call_uuid: string | null
  download_url: string | null
}

const lite = (r: RecordingRow): Lite => ({
  id: r.id,
  campaign: r.campaign,
  segment: r.segment,
  agent: r.agent,
  created_at: r.created_at,
  duration_sec: r.duration_sec,
  file_size: r.file_size,
  number: r.destination_number || r.caller_id_number,
  call_uuid: r.call_uuid,
  download_url: r.download_url,
})

async function disposition(inst: Instance, callUuid: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${inst.base}/calls/${callUuid}`, { headers: inst.headers })
    if (res.ok) {
      const body = await res.json()
      return String(body.disposition_code ?? '').trim() || ''
    }
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
      continue
    }
    return null
  }
  return null
}

async function main() {
  const concurrency = arg('concurrency', 8)
  const inst = instances()[0]

  const total = await exactCount(inst)
  const newest = (await fetchPage(inst, '', 0))[0]
  const oldest = (await fetchPage(inst, '', Math.max(0, total - 1)))[0]
  const days: string[] = []
  for (
    let d = new Date(`${oldest.created_at.slice(0, 10)}T00:00:00Z`);
    d <= new Date(`${newest.created_at.slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1)
  ) days.push(d.toISOString().slice(0, 10))

  console.log(`${total.toLocaleString()} recordings over ${days.length} days`)
  console.log('step 1 of 2: finding every self-verifier call\n')

  const verifier: Lite[] = []
  for (const day of days) {
    const dayTotal = await exactCount(inst, dayRange(day))
    if (dayTotal <= 0) { console.log(`  ${day}   no calls`); continue }

    const queue: number[] = []
    for (let o = 0; o < dayTotal; o += PAGE) queue.push(o)
    let found = 0

    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (let off = queue.shift(); off !== undefined; off = queue.shift()) {
          for (const r of await fetchPage(inst, dayRange(day), off)) {
            if (isVerifierCampaign(r.campaign)) { verifier.push(lite(r)); found++ }
          }
        }
      })
    )
    console.log(`  ${day}   ${String(dayTotal).padStart(7)} calls   verifier ${String(found).padStart(4)}`)
  }

  console.log(`\nself-verifier calls found: ${verifier.length.toLocaleString()}`)
  console.log(`step 2 of 2: reading the disposition of each one\n`)

  // ---- dispositions -----------------------------------------------------
  const out = createWriteStream(OUT, { flags: 'w' })
  const dispCount = new Map<string, number>()
  const byDay = new Map<string, { calls: number; sales: number; saleBytes: number }>()
  let done = 0
  let failed = 0

  const queue = [...verifier]
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let v = queue.shift(); v !== undefined; v = queue.shift()) {
        const d = v.call_uuid ? await disposition(inst, v.call_uuid) : null
        if (d === null) failed++
        const code = d === null ? '(lookup failed)' : d || '(empty)'
        dispCount.set(code, (dispCount.get(code) ?? 0) + 1)

        const day = v.created_at.slice(0, 10)
        const cell = byDay.get(day) ?? { calls: 0, sales: 0, saleBytes: 0 }
        cell.calls++
        const isSale = code.toUpperCase() === 'SALE'
        if (isSale) { cell.sales++; cell.saleBytes += v.file_size ?? 0 }
        byDay.set(day, cell)

        if (isSale) out.write(JSON.stringify({ ...v, disposition: code }) + '\n')
        if (++done % 250 === 0) process.stdout.write(`  ${done}/${verifier.length} looked up\r`)
      }
    })
  )
  out.end()
  console.log(`  ${done}/${verifier.length} looked up          \n`)

  console.log('self-verifier dispositions:')
  for (const [code, n] of [...dispCount].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${code.padEnd(18)} ${String(n).padStart(6)}`)
  }
  if (failed) console.log(`   (${failed} lookups failed)`)

  console.log('\nSALES PER DAY')
  console.log('day          verifier calls   SALE   size of sale recordings')
  let totalSales = 0
  let totalBytes = 0
  for (const day of days) {
    const c = byDay.get(day)
    if (!c) continue
    totalSales += c.sales
    totalBytes += c.saleBytes
    console.log(
      `${day}   ${String(c.calls).padStart(14)}   ${String(c.sales).padStart(4)}   ${(c.saleBytes / 1024 ** 2).toFixed(0).padStart(8)} MB`
    )
  }
  console.log(`\nTOTAL: ${totalSales} sales, ${(totalBytes / 1024 ** 2).toFixed(0)} MB`)

  // ---- do closers ever get SALE? ----------------------------------------
  let closerNote = 'not checked'
  try {
    const closers: Lite[] = readFileSync('morpheus-manifest.jsonl', 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l) as Lite)
      .filter((r) => isCloserCampaign(r.campaign))
    const picks = Array.from({ length: Math.min(CLOSER_SAMPLE, closers.length) }, (_, i) =>
      closers[Math.floor((i * closers.length) / Math.min(CLOSER_SAMPLE, closers.length))]
    )
    console.log(`\nchecking ${picks.length} closer calls for a SALE disposition...`)
    const cDisp = new Map<string, number>()
    const cq = [...picks]
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (let v = cq.shift(); v !== undefined; v = cq.shift()) {
          const d = v.call_uuid ? await disposition(inst, v.call_uuid) : null
          const code = d === null ? '(lookup failed)' : d || '(empty)'
          cDisp.set(code, (cDisp.get(code) ?? 0) + 1)
        }
      })
    )
    const sales = cDisp.get('SALE') ?? 0
    for (const [code, n] of [...cDisp].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${code.padEnd(18)} ${String(n).padStart(5)}`)
    }
    closerNote = `${sales} of ${picks.length} sampled closer calls were marked SALE`
    console.log(`   -> ${closerNote}`)
  } catch {
    console.log('\n(morpheus-manifest.jsonl not found; skipped the closer check)')
  }

  writeFileSync(
    SUMMARY,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        archiveTotal: total,
        verifierCalls: verifier.length,
        dispositions: Object.fromEntries(dispCount),
        salesPerDay: Object.fromEntries(byDay),
        totalSales,
        totalSaleBytes: totalBytes,
        closerCheck: closerNote,
      },
      null,
      2
    )
  )
  console.log(`\nsale recordings: ${OUT}`)
  console.log(`summary:         ${SUMMARY}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
