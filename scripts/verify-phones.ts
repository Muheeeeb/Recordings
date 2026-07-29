/**
 * Confirms the new filename format landed in the index: phone numbers should
 * now be populated for the recordings that carry one.
 *
 *   npx tsx --env-file=.env.local scripts/verify-phones.ts
 */

import { db, searchRecordings } from '../lib/db'

async function main() {
  const totals = await db().execute(`
    SELECT count(*) AS total,
           sum(phone IS NOT NULL) AS with_phone,
           sum(lead IS NOT NULL)  AS with_lead,
           max(day) AS newest
    FROM recordings`)
  const t = totals.rows[0] as unknown as {
    total: number
    with_phone: number
    with_lead: number
    newest: number
  }
  console.log(`total recordings : ${Number(t.total).toLocaleString()}`)
  console.log(`with a phone     : ${Number(t.with_phone).toLocaleString()}`)
  console.log(`with a lead id   : ${Number(t.with_lead).toLocaleString()}`)
  console.log(`newest call day  : ${t.newest}`)

  const perDay = await db().execute(
    'SELECT day, count(*) AS n FROM recordings GROUP BY day ORDER BY day DESC LIMIT 4'
  )
  console.log('\nnewest days:')
  for (const row of perDay.rows) {
    const r = row as unknown as { day: number; n: number }
    console.log(`  ${r.day}  ${Number(r.n).toLocaleString()}`)
  }

  // Pick a real phone number from the index and search for it the way the UI
  // does, to prove the end-to-end path works.
  const sample = await db().execute(
    'SELECT phone FROM recordings WHERE phone IS NOT NULL LIMIT 1'
  )
  if (sample.rows.length === 0) {
    console.log('\nno phone numbers indexed — the new format did not land')
    process.exit(1)
  }
  const phone = String((sample.rows[0] as never)['phone'])

  const started = Date.now()
  const hits = await searchRecordings({ q: phone })
  console.log(`\nsearching for phone ${phone}`)
  console.log(`  ${hits.length} result(s) in ${Date.now() - started}ms`)
  for (const hit of hits.slice(0, 3)) {
    console.log(`  ${hit.key.split('/').pop()}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
