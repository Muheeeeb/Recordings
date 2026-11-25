/**
 * Checks that the Closer/Closer2 lists are complete.
 *
 * Those lists are built per-agent, because the API ignores campaign=. That is
 * only sound if every Closer-campaign recording actually carries an agent
 * label we hold in the roster. Two things could break it:
 *
 *   1. a Closer recording with a blank agent — nothing to query it by;
 *   2. a closer who recorded too rarely to appear in the roster sample.
 *
 * So this samples the archive independently, keeps the Closer/Closer2 records,
 * and asks whether each one's label is in the roster. It also extrapolates the
 * campaign totals from the sample so the fetched count can be compared against
 * an estimate that was not derived from the roster.
 *
 *   npx tsx --env-file=.env.local scripts/morpheus-verify-coverage.ts
 */

import { readFileSync } from 'node:fs'
import {
  PAGE, ROSTER_FILE, type Instance, type RecordingRow, type Roster,
  exactCount, fetchPage, instances, isCloserCampaign,
} from '../lib/morpheus'

const PAGES = 300

async function checkInstance(inst: Instance, roster: Roster) {
  // Only the labels from THIS server can explain this server's recordings.
  const known = new Set(roster.labels.filter((e) => e.instance === inst.label).map((e) => e.label))
  console.log(`
${'='.repeat(60)}
${inst.label}  (${inst.host})
${'='.repeat(60)}`)

  const total = await exactCount(inst)
  const step = Math.max(PAGE, Math.floor(total / PAGES))

  const closer: RecordingRow[] = []
  let sampled = 0
  const queue = Array.from({ length: PAGES }, (_, i) => i * step).filter((o) => o < total)
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let off = queue.shift(); off !== undefined; off = queue.shift()) {
        const recs = await fetchPage(inst, '', off)
        sampled += recs.length
        for (const r of recs) if (isCloserCampaign(r.campaign)) closer.push(r)
      }
    })
  )

  console.log(`sampled ${sampled.toLocaleString()} of ${total.toLocaleString()} (${((sampled / total) * 100).toFixed(1)}%)`)
  console.log(`closer-campaign records in the sample: ${closer.length}\n`)

  const blank = closer.filter((r) => !(r.agent ?? '').trim())
  const unknown = closer.filter((r) => (r.agent ?? '').trim() && !known.has((r.agent ?? '').trim()))
  console.log(`  blank agent        : ${blank.length}  ${blank.length ? '<-- these cannot be fetched per-agent' : 'none'}`)
  console.log(`  label not in roster: ${unknown.length}  ${unknown.length ? '<-- roster needs a deeper scan' : 'none'}`)
  for (const u of [...new Set(unknown.map((r) => r.agent))].slice(0, 10)) console.log(`     ${u}`)

  const scale = total / sampled
  const byCampaign = new Map<string, number>()
  for (const r of closer) {
    const k = (r.campaign ?? '').trim()
    byCampaign.set(k, (byCampaign.get(k) ?? 0) + 1)
  }
  console.log('\nindependent estimate of the campaign totals:')
  for (const [c, n] of [...byCampaign].sort()) {
    console.log(`  ${c.padEnd(10)} ~${Math.round(n * scale).toLocaleString()}  (${n} seen x ${scale.toFixed(1)})`)
  }
  console.log('\nCompare these with the fetched counts. A fetched count well below')
  console.log('the estimate means the roster missed closers; above it is just')
  console.log('sampling noise or growth since the scan.')
}

async function main() {
  const roster: Roster = JSON.parse(readFileSync(ROSTER_FILE, 'utf8'))
  for (const inst of instances()) await checkInstance(inst, roster)
}

main().catch((e: unknown) => { console.error(e); process.exit(1) })
