/**
 * Trims the activity log to its retention window.
 *
 *   npx tsx --env-file=.env.local scripts/prune-activity.ts            # report
 *   npx tsx --env-file=.env.local scripts/prune-activity.ts --apply
 *   npx tsx --env-file=.env.local scripts/prune-activity.ts --apply --keep-days=180
 *
 * Every play, search and sign-in writes a row, so without this the table grows
 * for as long as the system runs. A year is long enough to settle a dispute
 * about a call and short enough that the table stays small.
 *
 * Reports by default and deletes only with --apply, because this is the one
 * script here that destroys an audit trail.
 */

import { db } from '../lib/db'
import { pruneActivity } from '../lib/activity'

const flag = (name: string) => process.argv.includes(`--${name}`)
const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback

async function main() {
  const keepDays = Number(arg('keep-days', '365'))
  if (!Number.isInteger(keepDays) || keepDays < 1) {
    console.error('--keep-days must be a positive whole number of days')
    process.exit(1)
  }

  const cutoff = Math.floor(Date.now() / 1000) - keepDays * 24 * 60 * 60
  const [total, older] = await Promise.all([
    db().execute('SELECT count(*) AS n FROM activity'),
    db().execute({ sql: 'SELECT count(*) AS n FROM activity WHERE ts < ?', args: [cutoff] }),
  ])

  const n = Number((total.rows[0] as unknown as { n: number }).n)
  const stale = Number((older.rows[0] as unknown as { n: number }).n)

  console.log(`activity rows:      ${n.toLocaleString()}`)
  console.log(`older than ${keepDays}d:  ${stale.toLocaleString()}`)
  console.log(`cutoff:             ${new Date(cutoff * 1000).toISOString().slice(0, 10)}`)

  if (!flag('apply')) {
    console.log(`\nnothing deleted — pass --apply to remove those ${stale.toLocaleString()} rows`)
    return
  }
  if (stale === 0) {
    console.log('\nnothing to delete')
    return
  }

  const removed = await pruneActivity(keepDays)
  console.log(`\ndeleted ${removed.toLocaleString()} rows`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
