/**
 * Wider net than scripts/find.ts: substring matches against the phone, the lead
 * id and the raw filename, so a number that sits in an unexpected position or
 * carries a country code still turns up.
 *
 *   npx tsx --env-file=.env.local scripts/find-loose.ts 2515550171
 */

import { db } from '../lib/db'

const term = process.argv[2]

async function main() {
  if (!term) {
    console.error('Usage: npx tsx --env-file=.env.local scripts/find-loose.ts <number>')
    process.exit(1)
  }
  const digits = term.replace(/\D/g, '')

  const probes: { label: string; sql: string; args: unknown[] }[] = [
    {
      label: `exact phone = ${digits}`,
      sql: 'SELECT count(*) AS n FROM recordings WHERE phone = ?',
      args: [Number(digits)],
    },
    {
      label: `exact lead = ${digits}`,
      sql: 'SELECT count(*) AS n FROM recordings WHERE lead = ?',
      args: [Number(digits)],
    },
    {
      label: `phone with a 1 country code (1${digits})`,
      sql: 'SELECT count(*) AS n FROM recordings WHERE phone = ?',
      args: [Number('1' + digits)],
    },
    {
      label: `filename contains ${digits}`,
      sql: 'SELECT count(*) AS n FROM recordings WHERE fn LIKE ?',
      args: [`%${digits}%`],
    },
    {
      label: `last 7 digits of the number (${digits.slice(-7)}) as a lead id`,
      sql: 'SELECT count(*) AS n FROM recordings WHERE lead = ?',
      args: [Number(digits.slice(-7))],
    },
  ]

  for (const probe of probes) {
    const r = await db().execute({ sql: probe.sql, args: probe.args as never })
    const n = Number((r.rows[0] as never)['n'])
    console.log(`${n > 0 ? 'FOUND' : '  --  '}  ${probe.label}: ${n}`)
  }

  // Show whatever the filename probe turned up, since that is the widest net.
  const hits = await db().execute({
    sql: `SELECT g.name AS grp, r.dir, r.fn, r.ts, r.lead, r.phone
          FROM recordings r JOIN groups g ON g.id = r.g
          WHERE r.fn LIKE ? ORDER BY r.ts DESC LIMIT 10`,
    args: [`%${digits}%`],
  })
  if (hits.rows.length > 0) {
    console.log('\nmatches:')
    for (const row of hits.rows) {
      const r = row as unknown as { grp: string; dir: string; fn: string; lead: number; phone: number }
      console.log(`  dialer/${r.grp}/${r.dir}/${r.fn}`)
      console.log(`     lead=${r.lead ?? '—'} phone=${r.phone ?? '—'}`)
    }
  }

  const totals = await db().execute(
    'SELECT count(*) AS total, sum(phone IS NOT NULL) AS with_phone, max(day) AS newest FROM recordings'
  )
  const t = totals.rows[0] as unknown as { total: number; with_phone: number; newest: number }
  console.log(
    `\nindex holds ${Number(t.total).toLocaleString()} recordings, ` +
      `${Number(t.with_phone).toLocaleString()} with a phone number, newest call day ${t.newest}`
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
