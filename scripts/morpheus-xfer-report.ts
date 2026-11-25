/**
 * Counts XFER calls per agent, two independent ways, from the CSVs that
 * scripts/morpheus-fetch-agents.ts already wrote. No API calls.
 *
 * Why two ways: the dialer marks each recording with a `segment` of `full`,
 * `transfer` or `agent`, and `transfer` is the obvious candidate for "XFER".
 * But a transferred call produces SEVERAL recordings sharing one call_uuid —
 * one leg for the fronter and one for the closer — and the segment labels do
 * not fall out neatly by role: closers' received transfers are marked
 * `transfer`, and fronters have `transfer` legs of their own too. Counting
 * `segment='transfer'` rows therefore counts legs, not handoffs.
 *
 * So the second measure is the one to trust for "how many did this fronter
 * pass to a closer": a call_uuid of theirs that also appears on a Closer or
 * Closer2 recording. That is a handoff by definition, independent of how the
 * legs happen to be labelled.
 *
 *   npx tsx scripts/morpheus-xfer-report.ts
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'

const OUTDIR = 'out'

type Row = Record<string, string>

/** Minimal CSV reader: enough for the quoting this project's own writer emits. */
function readCsv(path: string): Row[] {
  const text = readFileSync(path, 'utf8')
  const lines: string[][] = []
  let field = ''
  let row: string[] = []
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); field = ''; lines.push(row); row = [] }
    else if (c !== '\r') field += c
  }
  if (field || row.length) { row.push(field); lines.push(row) }

  const [head, ...rest] = lines
  return rest
    .filter((r) => r.length === head.length)
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])) as Row)
}

function main() {
  const closer = readCsv(`${OUTDIR}/closer-campaigns.csv`)
  // Which closer picked up each call, so a handoff can name its destination.
  const closerByCall = new Map<string, Row>()
  for (const r of closer) if (r.call_uuid) closerByCall.set(r.call_uuid, r)
  console.log(`closer recordings loaded: ${closer.length}  (${closerByCall.size} distinct calls)\n`)

  const files = readdirSync(OUTDIR).filter((f) => f.endsWith('.csv') && !f.startsWith('_') && f !== 'closer-campaigns.csv')

  console.log('agent                     calls   seg=transfer   handed to closer   conn%')
  console.log('-'.repeat(78))

  const summary: string[] = []
  for (const f of files.sort()) {
    const rows = readCsv(`${OUTDIR}/${f}`)
    if (rows.length === 0) continue

    const segTransfer = rows.filter((r) => r.segment === 'transfer').length

    // Distinct calls of this agent that a closer also recorded.
    const handed = new Set<string>()
    for (const r of rows) if (r.call_uuid && closerByCall.has(r.call_uuid)) handed.add(r.call_uuid)

    const distinctCalls = new Set(rows.map((r) => r.call_uuid).filter(Boolean)).size
    // Connected calls only — a dial nobody answered was never transferable.
    const connected = rows.filter((r) => Number(r.duration_sec) >= 10).length
    const pct = connected ? ((handed.size / connected) * 100).toFixed(1) : '-'

    const name = (rows[0].name || f.replace('.csv', '')).slice(0, 24)
    console.log(
      `${name.padEnd(24)} ${String(rows.length).padStart(6)}   ${String(segTransfer).padStart(12)}   ${String(handed.size).padStart(16)}   ${pct.padStart(5)}`
    )
    summary.push(`"${name}",${rows[0].dialer_id},${rows.length},${distinctCalls},${connected},${segTransfer},${handed.size}`)
  }

  console.log('-'.repeat(78))
  console.log('calls           = recordings for this agent')
  console.log('seg=transfer    = recordings the dialer marked segment=transfer (legs, not handoffs)')
  console.log('handed to closer= distinct calls of theirs that a Closer/Closer2 also recorded')
  console.log('conn%           = handoffs as a share of their calls lasting 10s or more')

  writeFileSync(
    `${OUTDIR}/_xfer.csv`,
    'name,dialer_id,recordings,distinct_calls,connected_10s,segment_transfer,handed_to_closer\n' + summary.join('\n')
  )
  console.log(`\n${OUTDIR}/_xfer.csv`)

  // The closers' own side, for comparison.
  const bySeg = new Map<string, number>()
  for (const r of closer) bySeg.set(r.segment || '(blank)', (bySeg.get(r.segment || '(blank)') ?? 0) + 1)
  console.log(`\nclosers' own segments: ${[...bySeg].sort().map(([s, n]) => `${s} ${n}`).join(', ')}`)
}

main()
