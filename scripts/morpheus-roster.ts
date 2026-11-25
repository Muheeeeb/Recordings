/**
 * Builds the roster of every agent the dialers have recorded under, across
 * BOTH Morpheus servers, and writes it to morpheus-roster.json for the other
 * Morpheus scripts to read.
 *
 * It has to be built by scanning because the API offers no agents endpoint
 * (/agents is 404, /users and /campaigns are 403 for our key) and ignores
 * every agent filter except agent_user_id — see lib/morpheus.ts for the full
 * list of what the API does and does not honour.
 *
 * The roster is keyed on the NAME, not the dialer id or the uuid, because a
 * renumbering gives an agent a new value for both of those while the name
 * stays put. Each entry also records which server it came from: ids and uuids
 * are scoped to one instance, so the same person on both servers is two
 * entries that must be queried separately and may legitimately differ.
 *
 *   npx tsx --env-file=.env.local scripts/morpheus-roster.ts [--pages=1400]
 */

import { writeFileSync } from 'node:fs'
import {
  PAGE, ROSTER_FILE, type Entry, type Instance, type Roster,
  exactCount, fetchPage, instances, nameKey, splitLabel,
} from '../lib/morpheus'

const arg = (name: string, fallback: number) => {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? Number(m.split('=')[1]) : fallback
}

async function scan(inst: Instance, pages: number, concurrency: number) {
  const total = await exactCount(inst)
  // Offsets spread across the whole archive rather than taken from the head:
  // the newest pages are nearly all one campaign and would miss most agents.
  const step = Math.max(PAGE, Math.floor(total / pages))
  const offsets = Array.from({ length: pages }, (_, i) => i * step).filter((o) => o < total)

  console.log(`\n${inst.label}  (${inst.host})`)
  console.log(`  archive: ${total.toLocaleString()} recordings`)
  console.log(`  scanning ${offsets.length} pages x ${PAGE} = ${(offsets.length * PAGE).toLocaleString()} records (every ~${step}th)`)

  const byLabel = new Map<string, Entry>()
  let done = 0
  let withAgent = 0
  let seenRows = 0

  const queue = [...offsets]
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let off = queue.shift(); off !== undefined; off = queue.shift()) {
        const recs = await fetchPage(inst, '', off)
        seenRows += recs.length
        for (const r of recs) {
          const label = (r.agent ?? '').trim()
          if (!label) continue
          withAgent++
          const e = byLabel.get(label)
          if (e) {
            e.seen++
            if (r.created_at < e.first) e.first = r.created_at
            if (r.created_at > e.last) e.last = r.created_at
          } else {
            byLabel.set(label, {
              instance: inst.label,
              label,
              ...splitLabel(label),
              uuid: r.agent_user_id ?? '',
              seen: 1,
              first: r.created_at,
              last: r.created_at,
            })
          }
        }
        if (++done % 50 === 0) process.stdout.write(`  ${done}/${offsets.length} pages, ${byLabel.size} labels\r`)
      }
    })
  )
  console.log(`  ${done}/${offsets.length} pages, ${byLabel.size} labels          `)
  console.log(`  records carrying an agent: ${withAgent.toLocaleString()} of ${seenRows.toLocaleString()} scanned`)

  return { total, pages: done, labels: [...byLabel.values()] }
}

async function main() {
  const pages = arg('pages', 1400)
  const concurrency = arg('concurrency', 8)
  const insts = instances()
  console.log(`instances configured: ${insts.map((i) => `${i.label} (${i.host})`).join(', ')}`)

  const labels: Entry[] = []
  const archiveTotal: Record<string, number> = {}
  let sampledPages = 0

  for (const inst of insts) {
    const r = await scan(inst, pages, concurrency)
    labels.push(...r.labels)
    archiveTotal[inst.label] = r.total
    sampledPages += r.pages
  }

  // Group by person, within and across the servers.
  const byName = new Map<string, Entry[]>()
  for (const e of labels) {
    const k = nameKey(e.name)
    if (!k) continue
    byName.set(k, [...(byName.get(k) ?? []), e])
  }

  console.log(`\ndistinct people across all servers: ${byName.size}`)

  const multiId = [...byName.entries()].filter(
    ([, v]) => v.every((e) => e.dialerId) && new Set(v.map((e) => `${e.instance}:${e.dialerId}`)).size > 1
  )
  console.log(`people holding more than one dialer id: ${multiId.length}`)
  for (const [k, v] of multiId.sort((a, b) => b[1].length - a[1].length)) {
    console.log(`   ${k.padEnd(24)} ${v.map((e) => `${e.instance}:${e.dialerId}`).sort().join('  ')}`)
  }

  if (insts.length > 1) {
    const onBoth = [...byName.entries()].filter(([, v]) => new Set(v.map((e) => e.instance)).size > 1)
    console.log(`\npeople appearing on BOTH servers: ${onBoth.length}`)
    for (const [k, v] of onBoth.slice(0, 20)) {
      console.log(`   ${k.padEnd(24)} ${v.map((e) => `${e.instance}:${e.dialerId ?? '?'}`).join('  ')}`)
    }
  }

  const payload: Roster = {
    scannedAt: new Date().toISOString(),
    archiveTotal,
    sampledPages,
    labels: labels.sort((a, b) => a.instance.localeCompare(b.instance) || a.label.localeCompare(b.label)),
  }
  writeFileSync(ROSTER_FILE, JSON.stringify(payload, null, 2))
  console.log(`\nroster written to ${ROSTER_FILE} (${labels.length} labels)`)
}

main().catch((e) => { console.error(e); process.exit(1) })
