/**
 * Recomputes the dashboard rollup without reindexing from S3. Useful after a
 * change to what the rollup contains.
 *
 *   npx tsx --env-file=.env.local scripts/refresh-stats.ts
 */

import { ensureSchema, refreshStats } from '../lib/db'

async function main() {
  await ensureSchema()

  const started = Date.now()
  const stats = await refreshStats()
  console.log(`recomputed in ${Date.now() - started}ms`)
  console.log(`  ${stats.cells.length} day/group cells`)
  console.log(`  ${stats.perAgent.length} agents`)

  const days = [...new Set(stats.cells.map((c) => c.day))].sort()
  const groups = [...new Set(stats.cells.map((c) => c.group))].sort()

  console.log(`\nper day, per group:`)
  console.log('  day        ' + groups.map((g) => g.replace(/_/g, ' ').padStart(16)).join(''))
  for (const day of days) {
    const row = groups.map((g) => {
      const cell = stats.cells.find((c) => c.day === day && c.group === g)
      return String(cell?.count ?? 0).padStart(16)
    })
    console.log(`  ${day}` + row.join(''))
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
