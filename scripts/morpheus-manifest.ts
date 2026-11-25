/**
 * Walks every recording on Morpheus, day by day, and writes the in-scope ones
 * to a manifest. Read-only — it downloads nothing and uploads nothing.
 *
 * Why a full walk rather than sampling: the API ignores `campaign=` (every
 * value returns the whole archive, including a nonsense one), so the only way
 * to count a campaign is to look at every record's own campaign field. For the
 * big campaigns a sample is fine, but the self-verifier XFER calls are about
 * 0.006% of the archive — at one-in-thirty sampling that is three records seen
 * and a count that could be out by a factor of two. A filter that decides what
 * gets archived should not rest on that.
 *
 * The walk is per day, using from/to (`to` is exclusive), because offsets into
 * the whole list shift as new calls are inserted at the head — roughly 70,000
 * a day — and a 15,000-page walk would both miss and duplicate records. A
 * day's range is stable once the day is over.
 *
 * The manifest is also what the puller needs: it says exactly which recording
 * ids to fetch, so the pull does not have to re-decide the scope.
 *
 *   npx tsx --env-file=.env.local scripts/morpheus-manifest.ts [--concurrency=8]
 */

import { createWriteStream, writeFileSync } from 'node:fs'
import {
  PAGE, dayRange, exactCount, fetchPage, instances, isCloserCampaign,
  isTransfer, isVerifierCampaign, type Instance, type RecordingRow,
} from '../lib/morpheus'

const MANIFEST = 'morpheus-manifest.jsonl'
const COUNTS = 'morpheus-counts.json'

const arg = (name: string, fallback: number) => {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? Number(m.split('=')[1]) : fallback
}

/** In scope: every closer recording, and self-verifier XFER calls only. */
function scopeOf(r: RecordingRow): 'closer' | 'verifier-xfer' | null {
  if (isCloserCampaign(r.campaign)) return 'closer'
  if (isVerifierCampaign(r.campaign) && isTransfer(r.segment)) return 'verifier-xfer'
  return null
}

type Cell = { n: number; bytes: number; secs: number }
const cell = (): Cell => ({ n: 0, bytes: 0, secs: 0 })
const addTo = (c: Cell, r: RecordingRow) => {
  c.n++
  c.bytes += r.file_size ?? 0
  c.secs += r.duration_sec ?? 0
}

async function main() {
  const concurrency = arg('concurrency', 8)
  const inst: Instance = instances()[0]

  const total = await exactCount(inst)
  const newest = (await fetchPage(inst, '', 0))[0]
  const oldest = (await fetchPage(inst, '', Math.max(0, total - 1)))[0]
  if (!newest || !oldest) throw new Error('could not read the ends of the archive')

  const days: string[] = []
  const end = new Date(`${newest.created_at.slice(0, 10)}T00:00:00Z`)
  for (let d = new Date(`${oldest.created_at.slice(0, 10)}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10))
  }

  console.log(`${inst.label}: ${total.toLocaleString()} recordings, ${oldest.created_at.slice(0, 10)} .. ${newest.created_at.slice(0, 10)}`)
  console.log(`walking ${days.length} days\n`)

  const out = createWriteStream(MANIFEST, { flags: 'w' })

  // campaign -> segment -> cell, plus a per-day view of what is in scope.
  const byCampaign = new Map<string, Map<string, Cell>>()
  const byDay = new Map<string, { closer: Cell; verifierXfer: Cell; all: number }>()
  let seen = 0
  let inScope = 0
  let noAudio = 0

  for (const day of days) {
    const dayTotal = await exactCount(inst, dayRange(day))
    if (dayTotal <= 0) {
      console.log(`  ${day}   no calls`)
      byDay.set(day, { closer: cell(), verifierXfer: cell(), all: 0 })
      continue
    }

    const offsets: number[] = []
    for (let o = 0; o < dayTotal; o += PAGE) offsets.push(o)

    const d = { closer: cell(), verifierXfer: cell(), all: 0 }
    const queue = [...offsets]
    let pages = 0

    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (let off = queue.shift(); off !== undefined; off = queue.shift()) {
          const recs = await fetchPage(inst, dayRange(day), off)
          for (const r of recs) {
            seen++
            d.all++

            const campaign = (r.campaign ?? '').trim() || '(blank)'
            const segment = (r.segment ?? '').trim() || '(blank)'
            const segs = byCampaign.get(campaign) ?? new Map<string, Cell>()
            const c = segs.get(segment) ?? cell()
            addTo(c, r)
            segs.set(segment, c)
            byCampaign.set(campaign, segs)

            const scope = scopeOf(r)
            if (!scope) continue
            if ((r.file_size ?? 0) <= 0) { noAudio++; continue }

            inScope++
            addTo(scope === 'closer' ? d.closer : d.verifierXfer, r)
            out.write(
              JSON.stringify({
                id: r.id,
                scope,
                campaign: r.campaign,
                segment: r.segment,
                agent: r.agent,
                agent_user_id: r.agent_user_id,
                created_at: r.created_at,
                duration_sec: r.duration_sec,
                file_size: r.file_size,
                number: r.destination_number || r.caller_id_number,
                call_uuid: r.call_uuid,
                download_url: r.download_url,
              }) + '\n'
            )
          }
          if (++pages % 100 === 0) {
            process.stdout.write(`  ${day}   ${pages}/${offsets.length} pages, ${inScope} in scope\r`)
          }
        }
      })
    )

    byDay.set(day, d)
    const mb = (d.closer.bytes + d.verifierXfer.bytes) / 1024 ** 2
    console.log(
      `  ${day}   ${String(d.all).padStart(7)} calls   closers ${String(d.closer.n).padStart(5)}   verifier-XFER ${String(d.verifierXfer.n).padStart(4)}   ${mb.toFixed(0).padStart(6)} MB   `
    )
  }

  out.end()

  // ---- exact totals ------------------------------------------------------
  console.log(`\n${'='.repeat(78)}\nEVERY CAMPAIGN, EXACT\n${'='.repeat(78)}`)
  console.log('campaign                 segment        recordings      size    avg len')
  const campaignTotals: Record<string, number> = {}
  for (const [campaign, segs] of [...byCampaign].sort()) {
    let n = 0
    for (const [segment, c] of [...segs].sort()) {
      n += c.n
      console.log(
        `${campaign.padEnd(24)} ${segment.padEnd(12)} ${c.n.toLocaleString().padStart(11)}   ${(c.bytes / 1024 ** 3).toFixed(2).padStart(7)} GB  ${(c.secs / Math.max(1, c.n)).toFixed(0).padStart(5)}s`
      )
    }
    campaignTotals[campaign] = n
  }

  const closerTotal = [...byDay.values()].reduce((s, d) => s + d.closer.n, 0)
  const closerBytes = [...byDay.values()].reduce((s, d) => s + d.closer.bytes, 0)
  const vxTotal = [...byDay.values()].reduce((s, d) => s + d.verifierXfer.n, 0)
  const vxBytes = [...byDay.values()].reduce((s, d) => s + d.verifierXfer.bytes, 0)

  console.log(`\n${'='.repeat(78)}\nTHE PULL SCOPE, EXACT\n${'='.repeat(78)}`)
  console.log(`  closers (complete)        ${closerTotal.toLocaleString().padStart(8)} files   ${(closerBytes / 1024 ** 3).toFixed(1).padStart(6)} GB`)
  console.log(`  self-verifier XFER only   ${vxTotal.toLocaleString().padStart(8)} files   ${(vxBytes / 1024 ** 3).toFixed(2).padStart(6)} GB`)
  console.log(`  ${''.padEnd(24)} ${(closerTotal + vxTotal).toLocaleString().padStart(8)} files   ${((closerBytes + vxBytes) / 1024 ** 3).toFixed(1).padStart(6)} GB`)
  console.log(`\n  walked ${seen.toLocaleString()} records; ${noAudio} in-scope rows had no audio and were skipped`)
  console.log(`  manifest: ${MANIFEST}`)

  writeFileSync(
    COUNTS,
    JSON.stringify(
      {
        walkedAt: new Date().toISOString(),
        instance: inst.label,
        archiveTotal: total,
        recordsWalked: seen,
        campaigns: Object.fromEntries(
          [...byCampaign].map(([c, segs]) => [c, Object.fromEntries([...segs].map(([s, v]) => [s, v]))])
        ),
        days: Object.fromEntries(byDay),
        scope: { closers: { n: closerTotal, bytes: closerBytes }, verifierXfer: { n: vxTotal, bytes: vxBytes } },
      },
      null,
      2
    )
  )
  console.log(`  counts:   ${COUNTS}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
