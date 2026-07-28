/**
 * Applies the schema: tables, then column additions, then indexes. Every step
 * is idempotent, so this is safe to run repeatedly and is how a database that
 * already exists picks up newly added columns and indexes.
 *
 *   npx tsx --env-file=.env.local scripts/migrate.ts
 */

import { db, ensureSchema } from '../lib/db'

async function main() {
  console.log('applying schema…')
  await ensureSchema()
  console.log('  done')

  const indexes = await db().execute(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'recordings' ORDER BY name`
  )
  console.log('\nindexes on recordings:')
  for (const row of indexes.rows) console.log('  ' + String((row as never)['name']))

  const cols = await db().execute('PRAGMA table_info(recordings)')
  console.log('\ncolumns:')
  console.log('  ' + cols.rows.map((r) => String((r as never)['name'])).join(', '))

  const backfilled = await db().execute(
    'SELECT count(*) AS n FROM recordings WHERE day IS NOT NULL'
  )
  console.log(`\nrows with a day value: ${Number((backfilled.rows[0] as never)['n']).toLocaleString()}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
