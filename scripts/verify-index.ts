/**
 * Post-index sanity check: confirms the data landed correctly, measures real
 * query latency, and reports how much of the free tier the index actually
 * uses so the growth projection can be checked against reality.
 *
 *   npx tsx --env-file=.env.local scripts/verify-index.ts
 */

import { db, searchRecordings } from '../lib/db'

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now()
  const result = await fn()
  const ms = Date.now() - started
  const count = Array.isArray(result) ? result.length : ''
  console.log(`  ${label.padEnd(42)} ${String(ms).padStart(5)} ms   ${count}`)
  return result
}

async function main() {
  const total = await db().execute('SELECT count(*) AS n FROM recordings')
  console.log(`\ntotal rows: ${Number((total.rows[0] as never)['n']).toLocaleString()}`)

  console.log('\nBY GROUP')
  const groups = await db().execute(`
    SELECT g.name, count(*) AS n, sum(r.sz) AS bytes
    FROM recordings r JOIN groups g ON g.id = r.g
    GROUP BY g.name ORDER BY n DESC`)
  for (const row of groups.rows) {
    const r = row as unknown as { name: string; n: number; bytes: number }
    const gb = (Number(r.bytes) / 1024 ** 3).toFixed(2)
    console.log(`  ${r.name.padEnd(24)} ${String(r.n).padStart(7)}   ${gb} GB`)
  }

  console.log('\nAGENTS')
  const agents = await db().execute(`
    SELECT a.name, count(*) AS n FROM recordings r
    JOIN agents a ON a.id = r.a GROUP BY a.name ORDER BY n DESC`)
  for (const row of agents.rows) {
    const r = row as unknown as { name: string; n: number }
    console.log(`  ${r.name.padEnd(24)} ${String(r.n).padStart(7)}`)
  }

  // Pick a real lead id so the lookup measures an actual hit, not a miss.
  const sample = await db().execute('SELECT lead FROM recordings WHERE lead IS NOT NULL LIMIT 1')
  const lead = Number((sample.rows[0] as never)['lead'])

  console.log('\nQUERY LATENCY')
  await timed('newest 50 (no filters)', () => searchRecordings({}))
  await timed(`lead id lookup (${lead})`, () => searchRecordings({ q: String(lead) }))
  await timed('group filter + newest 50', () => searchRecordings({ group: 'Closers_ACA' }))
  await timed('agent name search (CLOSER2)', () => searchRecordings({ q: 'CLOSER2' }))
  await timed('deep page (offset 100000)', () => searchRecordings({ offset: 100_000 }))

  console.log('\nSTORAGE')
  const size = await db().execute(
    `SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()`
  )
  const bytes = Number((size.rows[0] as never)['bytes'])
  const perRow = bytes / Number((total.rows[0] as never)['n'])
  console.log(`  index size      ${(bytes / 1024 ** 2).toFixed(1)} MB`)
  console.log(`  bytes per row   ${perRow.toFixed(0)}`)
  console.log(`  rows per 5 GB   ${Math.floor((5 * 1024 ** 3) / perRow).toLocaleString()}`)
  console.log(`  days per 5 GB   ${Math.floor((5 * 1024 ** 3) / perRow / 45_000).toLocaleString()} at 45k/day`)

  const sampleRow = await searchRecordings({ group: 'Closers_ACA', limit: 1 })
  console.log('\nSAMPLE ROW')
  console.log(' ', JSON.stringify(sampleRow[0], null, 2).replace(/\n/g, '\n  '))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
