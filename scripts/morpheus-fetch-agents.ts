/**
 * Pulls the complete recording list for named agents, and for the Closer and
 * Closer2 campaigns, out of Morpheus. Run scripts/morpheus-roster.ts first.
 *
 * Resolution is by NAME, because the dialer id and the agent_user_id both
 * change when an agent is renumbered — see lib/morpheus.ts. Each requested
 * name is resolved to every uuid it has ever appeared under, and each of those
 * is queried, so a renumbered agent's history comes back whole.
 *
 * Matching is exact after normalising, never fuzzy: the roster holds "Sami
 * Ullah Khan", "Sami Ullah" and "Sami Khan" as three different people, and a
 * loose match would merge them without saying so. Names that share a word but
 * are not equal are printed as near misses for a human to judge.
 *
 * The Closer/Closer2 lists are built from the closers in the roster and then
 * filtered on each record's own campaign field, because campaign= is ignored
 * by the API. That costs a few hundred requests instead of walking all
 * ~900,000 recordings. scripts/morpheus-verify-coverage.ts checks that this
 * per-agent route does not miss anything.
 *
 *   npx tsx --env-file=.env.local scripts/morpheus-fetch-agents.ts
 *
 * Writes one CSV per requested agent, plus closer-campaigns.csv, into out/.
 * These are recording LISTS. The audio is a separate problem: every download
 * currently answers 410 — see scripts/morpheus-pull-check.ts.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import {
  ROSTER_FILE, type Instance, type RecordingRow, type Roster,
  allForAgent, exactCount, instances, isCloserCampaign, isTransfer, nameKey, splitLabel,
} from '../lib/morpheus'

const OUTDIR = 'out'

/** The agents asked for. The id is kept so a mismatch with the roster shows. */
const REQUESTED: [string, string][] = [
  ['144', 'Sami ullah khan'],
  ['145', 'Muhammad Ubaid Ashraf'],
  ['153', 'Abdul SUbhan'],
  ['157', 'Syed Noor'],
  ['167', 'M Farhan'],
  ['185', 'Syed Ali raza'],
  ['209', 'Manzer Hayyat Abbasi'],
]

/** Shares a word with the requested name, but is not the same person. */
const nearMiss = (asked: string, candidate: string) => {
  const words = new Set(nameKey(asked).split(' '))
  const shared = nameKey(candidate).split(' ').filter((w) => words.has(w)).length
  return shared > 0 && nameKey(asked) !== nameKey(candidate)
}

const HEAD =
  'instance,recorded_at,agent_label,dialer_id,name,product,campaign,segment,direction,duration_sec,file_size,customer_number,lead_id,call_uuid,recording_id,download_path'

/** Rows are tagged as they are fetched: a recording id means nothing without
 *  knowing which server issued it. */
type Tagged = RecordingRow & { instance: string }

function csv(rows: Tagged[]) {
  const esc = (v: unknown) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [
    HEAD,
    ...rows.map((r) => {
      const p = splitLabel(r.agent ?? '')
      return [
        r.instance, r.created_at, r.agent, p.dialerId, p.name, p.product, r.campaign,
        r.segment, r.direction, r.duration_sec, r.file_size,
        r.destination_number || r.caller_id_number, r.lead_id, r.call_uuid,
        r.id, r.download_url,
      ].map(esc).join(',')
    }),
  ].join('\n')
}

const byTime = (a: Tagged, b: Tagged) =>
  String(a.created_at).localeCompare(String(b.created_at))

/** Fetch one agent's recordings and stamp each row with its server. */
async function taggedFor(inst: Instance, uuid: string): Promise<Tagged[]> {
  const rows = await allForAgent(inst, uuid)
  return rows.map((r) => ({ ...r, instance: inst.label }))
}
const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(2)
const mb = (bytes: number) => (bytes / 1024 ** 2).toFixed(0)

async function main() {
  const roster: Roster = JSON.parse(readFileSync(ROSTER_FILE, 'utf8'))
  mkdirSync(OUTDIR, { recursive: true })
  const insts = instances()
  const byLabelName = new Map(insts.map((i) => [i.label, i]))
  console.log(`roster: ${roster.labels.length} labels, scanned ${roster.scannedAt.slice(0, 16)}`)
  for (const [k, v] of Object.entries(roster.archiveTotal ?? {})) {
    console.log(`   ${k}: ${Number(v).toLocaleString()} recordings at scan time`)
  }

  // A roster entry is useless without credentials for the server it came from.
  const missing = [...new Set(roster.labels.map((e) => e.instance))].filter((l) => !byLabelName.has(l))
  if (missing.length) console.log(`
WARNING: roster has labels from ${missing.join(', ')} but no credentials for them — those are skipped.`)

  console.log(`\n${'='.repeat(74)}\nTHE SEVEN NAMED AGENTS\n${'='.repeat(74)}`)

  const summary: string[] = []
  let grandRows = 0
  let grandBytes = 0
  let grandXfer = 0

  for (const [askedId, askedName] of REQUESTED) {
    const hits = roster.labels.filter((e) => nameKey(e.name) === nameKey(askedName))
    console.log(`\n${askedId}  ${askedName}`)

    if (hits.length === 0) {
      console.log('   NOT FOUND under this name in the roster.')
      for (const n of roster.labels.filter((e) => nearMiss(askedName, e.name)).slice(0, 6)) {
        console.log(`     similar, but a different person: ${n.label}`)
      }
      summary.push(`${askedId},"${askedName}",0,0,not found`)
      continue
    }

    const rows: Tagged[] = []
    for (const h of hits) {
      const inst = byLabelName.get(h.instance)
      if (!inst) continue
      const n = await exactCount(inst, `agent_user_id=${h.uuid}`)
      const note = h.dialerId === askedId ? '' : `   <-- its dialer id is ${h.dialerId}, you gave ${askedId}`
      console.log(`   [${h.instance}] ${h.label.padEnd(32)} ${String(n).padStart(6)} recordings${note}`)
      rows.push(...(await taggedFor(inst, h.uuid)))
    }
    rows.sort(byTime)

    const bytes = rows.reduce((s, r) => s + (r.file_size ?? 0), 0)
    grandRows += rows.length
    grandBytes += bytes
    const file = `${OUTDIR}/${askedName.replace(/\s+/g, '_')}.csv`
    writeFileSync(file, csv(rows))

    const camps = new Map<string, number>()
    for (const r of rows) camps.set(r.campaign || '(blank)', (camps.get(r.campaign || '(blank)') ?? 0) + 1)
    const segs = new Map<string, number>()
    for (const r of rows) segs.set(r.segment || '(blank)', (segs.get(r.segment || '(blank)') ?? 0) + 1)
    const xfer = rows.filter((r) => isTransfer(r.segment))
    const xferMin = xfer.reduce((s, r) => s + (r.duration_sec ?? 0), 0) / 60

    console.log(`   => ${rows.length} recordings, ${mb(bytes)} MB, ${rows[0]?.created_at?.slice(0, 10)} .. ${rows[rows.length - 1]?.created_at?.slice(0, 10)}`)
    console.log(`      campaigns: ${[...camps].map(([c, n]) => `${c} ${n}`).join(', ')}`)
    console.log(`      segments : ${[...segs].sort().map(([c, n]) => `${c} ${n}`).join(', ')}`)
    console.log(`      XFER     : ${xfer.length}  (${((xfer.length / rows.length) * 100).toFixed(1)}% of calls, ${xferMin.toFixed(0)} min of talk)`)
    console.log(`      ${file}`)
    grandXfer += xfer.length
    summary.push(`${askedId},"${askedName}",${hits.length},${rows.length},${xfer.length},${hits.map((h) => h.dialerId).join('/')}`)
  }

  console.log(`\n   TOTAL for the seven: ${grandRows} recordings, ${gb(grandBytes)} GB, ${grandXfer} transferred`)

  console.log(`\n${'='.repeat(74)}\nCLOSER AND CLOSER2 CAMPAIGNS\n${'='.repeat(74)}`)

  const closers = roster.labels.filter((e) => /^closer/i.test(e.role ?? ''))
  console.log(`${closers.length} closer labels in the roster\n`)

  const closerRows: Tagged[] = []
  let done = 0
  for (const c of closers) {
    const inst = byLabelName.get(c.instance)
    if (!inst) { done++; continue }
    const recs = await taggedFor(inst, c.uuid)
    closerRows.push(...recs.filter((r) => isCloserCampaign(r.campaign)))
    process.stdout.write(`   ${++done}/${closers.length} agents, ${closerRows.length} closer-campaign recordings\r`)
  }
  console.log(`   ${done}/${closers.length} agents, ${closerRows.length} closer-campaign recordings      \n`)

  const byCampaign = new Map<string, { n: number; bytes: number; dur: number }>()
  for (const r of closerRows) {
    const key = (r.campaign ?? '').trim()
    const e = byCampaign.get(key) ?? { n: 0, bytes: 0, dur: 0 }
    e.n++
    e.bytes += r.file_size ?? 0
    e.dur += r.duration_sec ?? 0
    byCampaign.set(key, e)
  }
  console.log('campaign     recordings       size    avg len     XFER')
  for (const [c, e] of [...byCampaign].sort()) {
    const x = closerRows.filter((r) => (r.campaign ?? '').trim() === c && isTransfer(r.segment)).length
    console.log(`${c.padEnd(12)} ${String(e.n).padStart(8)}   ${gb(e.bytes).padStart(6)} GB  ${(e.dur / e.n).toFixed(0).padStart(5)}s  ${String(x).padStart(7)}`)
  }
  const closerByInstance = new Map<string, number>()
  for (const r of closerRows) closerByInstance.set(r.instance, (closerByInstance.get(r.instance) ?? 0) + 1)
  if (closerByInstance.size > 1) {
    console.log(`by server: ${[...closerByInstance].sort().map(([i, n]) => `${i} ${n}`).join(', ')}`)
  }
  const closerSegs = new Map<string, number>()
  for (const r of closerRows) closerSegs.set(r.segment || '(blank)', (closerSegs.get(r.segment || '(blank)') ?? 0) + 1)
  console.log(`segments: ${[...closerSegs].sort().map(([c, n]) => `${c} ${n}`).join(', ')}`)

  closerRows.sort(byTime)
  writeFileSync(`${OUTDIR}/closer-campaigns.csv`, csv(closerRows))
  console.log(`\n${OUTDIR}/closer-campaigns.csv  (${closerRows.length} rows)`)
  console.log(`range: ${closerRows[0]?.created_at?.slice(0, 10)} .. ${closerRows[closerRows.length - 1]?.created_at?.slice(0, 10)}`)

  writeFileSync(
    `${OUTDIR}/_summary.csv`,
    'asked_id,asked_name,ids_found,recordings,ids_in_morpheus\n' + summary.join('\n')
  )
  console.log(`${OUTDIR}/_summary.csv`)
}

main().catch((e) => { console.error(e); process.exit(1) })
