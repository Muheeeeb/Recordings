/**
 * Reports the folder layout the dialer actually uses, so the incremental sync
 * can target recent folders instead of relisting the whole bucket.
 *
 *   npx tsx --env-file=.env.local scripts/inspect-dirs.ts
 */

import { db } from '../lib/db'

async function main() {
  const dirs = await db().execute(
    'SELECT dir, count(*) AS n FROM recordings GROUP BY dir ORDER BY dir'
  )
  console.log(`distinct dir values: ${dirs.rows.length}\n`)
  for (const row of dirs.rows) {
    const r = row as unknown as { dir: string; n: number }
    console.log(`  ${(r.dir || '(none)').padEnd(20)} ${String(r.n).padStart(7)}`)
  }

  const perGroup = await db().execute(`
    SELECT g.name, count(DISTINCT r.dir) AS dirs, min(r.dir) AS lo, max(r.dir) AS hi
    FROM recordings r JOIN groups g ON g.id = r.g GROUP BY g.name`)
  console.log('\nper group:')
  for (const row of perGroup.rows) {
    const r = row as unknown as { name: string; dirs: number; lo: string; hi: string }
    console.log(`  ${r.name.padEnd(24)} ${r.dirs} dirs   ${r.lo} .. ${r.hi}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
