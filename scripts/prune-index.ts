/**
 * Removes index rows whose recordings no longer exist in S3.
 *
 * The indexer only ever inserts, so a lifecycle rule that expires recordings
 * leaves the index claiming they are still there — the dashboard overcounts and
 * a search can return a row whose Play button then fails.
 *
 * Pruning works at date-folder granularity because that is how recordings
 * actually disappear: a whole day ages out at once. Comparing folders needs one
 * cheap delimiter listing per group rather than a walk over millions of keys.
 *
 *   npx tsx --env-file=.env.local scripts/prune-index.ts          (dry run)
 *   npx tsx --env-file=.env.local scripts/prune-index.ts --apply
 *
 * Needs AWS credentials: $env:AWS_PROFILE="reader"
 */

import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { db, ensureSchema, refreshStats } from '../lib/db'

const BUCKET = process.env.S3_BUCKET ?? 'poshnee-call-recordings'
const PREFIX = process.env.S3_PREFIX ?? 'dialer/'
const APPLY = process.argv.includes('--apply')

/** Immediate child "folders" of a prefix, without listing any objects. */
async function childPrefixes(s3: S3Client, prefix: string): Promise<string[]> {
  const found: string[] = []
  let token: string | undefined
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        Delimiter: '/',
        ContinuationToken: token,
      })
    )
    for (const p of page.CommonPrefixes ?? []) {
      if (p.Prefix) found.push(p.Prefix.slice(prefix.length).replace(/\/$/, ''))
    }
    token = page.NextContinuationToken
  } while (token)
  return found
}

async function main() {
  await ensureSchema()
  const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1' })

  const groups = await db().execute('SELECT id, name FROM groups ORDER BY name')
  let totalRows = 0
  const plan: { group: string; gid: number; dir: string; rows: number }[] = []

  for (const row of groups.rows) {
    const g = row as unknown as { id: number; name: string }
    const live = new Set(await childPrefixes(s3, `${PREFIX}${g.name}/`))

    const indexed = await db().execute({
      sql: 'SELECT dir, count(*) AS n FROM recordings WHERE g = ? GROUP BY dir ORDER BY dir',
      args: [g.id],
    })

    let keep = 0
    let drop = 0
    let flat = 0
    for (const r of indexed.rows) {
      const entry = r as unknown as { dir: string; n: number }
      const rows = Number(entry.n)

      // KTN and Rockey write recordings straight into the group with no date
      // folder, so there is no folder to compare and a prefix listing finds
      // nothing. Treating that as "gone" would delete every row they have.
      // Flat groups can only be pruned by checking objects individually, which
      // this pass deliberately does not do.
      if (entry.dir === '') {
        flat += rows
        continue
      }

      if (live.has(entry.dir)) {
        keep += rows
      } else {
        drop += rows
        plan.push({ group: g.name, gid: Number(g.id), dir: entry.dir, rows })
      }
    }
    if (flat > 0) keep += flat
    totalRows += drop
    const layout = flat > 0 ? 'flat  ' : 'dated '
    console.log(
      `${g.name.padEnd(24)} ${layout} folders ${String(live.size).padStart(4)}   ` +
        `keep ${keep.toLocaleString().padStart(10)}   remove ${drop.toLocaleString().padStart(10)}`
    )
  }

  if (plan.length === 0) {
    console.log('\nNothing to prune — every indexed folder still exists in S3.')
    return
  }

  console.log(
    `\n${plan.length} folder(s) no longer in S3, covering ${totalRows.toLocaleString()} rows.`
  )

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to delete them.')
    console.log('Note: each removed row counts against the database write quota.')
    return
  }

  let done = 0
  for (const item of plan) {
    await db().execute({
      sql: 'DELETE FROM recordings WHERE g = ? AND dir = ?',
      args: [item.gid, item.dir],
    })
    done += item.rows
    process.stdout.write(`\rremoved ${done.toLocaleString()} of ${totalRows.toLocaleString()}…`)
  }

  await refreshStats()
  const left = await db().execute('SELECT count(*) AS n FROM recordings')
  console.log(`\n\nindex now holds ${Number((left.rows[0] as never)['n']).toLocaleString()} recordings`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
