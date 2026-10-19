/**
 * Confirms every folder in the bucket maps to an intended dialer, so a newly
 * appeared folder shows up as "Other" here rather than silently in the UI.
 *
 *   npx tsx --env-file=.env.local scripts/verify-dialers.ts
 */

import { getStats } from '../lib/db'
import { dialerForGroup } from '../lib/dialers'

async function main() {
  const stats = await getStats()

  const byGroup = new Map<string, number>()
  for (const cell of stats.cells) {
    byGroup.set(cell.group, (byGroup.get(cell.group) ?? 0) + cell.count)
  }

  const byDialer = new Map<string, number>()
  console.log('folder -> dialer')
  for (const [group, count] of [...byGroup.entries()].sort()) {
    const dialer = dialerForGroup(group)
    byDialer.set(dialer, (byDialer.get(dialer) ?? 0) + count)
    const flag = dialer === 'Other' ? '  <-- UNMAPPED' : ''
    console.log(`  ${group.padEnd(24)} ${dialer.padEnd(8)} ${count.toLocaleString().padStart(10)}${flag}`)
  }

  console.log('\ndialer totals')
  for (const [dialer, count] of [...byDialer.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${dialer.padEnd(10)} ${count.toLocaleString().padStart(10)}`)
  }

  const days = [...new Set(stats.cells.map((c) => c.day))].sort()
  console.log(`\ndays covered: ${days.length}  (${days[0]} .. ${days[days.length - 1]})`)
}

main().catch((e) => { console.error(e); process.exit(1) })
