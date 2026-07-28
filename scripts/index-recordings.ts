/**
 * Builds (or refreshes) the search index.
 *
 * Reads only object *names* from S3 — recordings are never downloaded — parses
 * each one and upserts it into Turso. Safe to re-run at any time: existing rows
 * are updated, so this doubles as the reconcile job that keeps the index from
 * drifting away from the bucket.
 *
 *   $env:AWS_PROFILE="reader"; npx tsx scripts/index-recordings.ts
 *   ...                                                     --recent=3
 *
 * --recent=N limits the scan to the N newest date folders per group, which is
 * enough to pick up a nightly batch without relisting the whole bucket. Run it
 * without the flag periodically so nothing can drift permanently.
 */

import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { db, ensureSchema, refreshStats, splitKey } from '../lib/db'
import { parseRecording } from '../lib/parse'

const BUCKET = process.env.S3_BUCKET ?? 'poshnee-call-recordings'
const PREFIX = process.env.S3_PREFIX ?? 'dialer/'
const BATCH = 400

const recentArg = process.argv.find((a) => a.startsWith('--recent'))
const RECENT = recentArg ? Number(recentArg.split('=')[1] ?? 3) : 0

/** Lists the immediate child "folders" of a prefix without reading objects. */
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
    for (const p of page.CommonPrefixes ?? []) if (p.Prefix) found.push(p.Prefix)
    token = page.NextContinuationToken
  } while (token)
  return found
}

/**
 * Which prefixes to walk: the whole tree by default, or just the newest date
 * folders of each group when --recent is set. Date folders are named YYYYMMDD
 * so a lexicographic sort is chronological.
 */
async function scanPrefixes(s3: S3Client): Promise<string[]> {
  if (RECENT <= 0) return [PREFIX]

  const targets: string[] = []
  for (const group of await childPrefixes(s3, PREFIX)) {
    const days = (await childPrefixes(s3, group)).sort()
    targets.push(...days.slice(-RECENT))
  }
  return targets
}

type Row = {
  group: string
  agent: string | null
  dir: string
  fn: string
  ts: number | null
  lead: number | null
  phone: number | null
  sz: number
}

/** Lookup tables keep the group and agent names out of every single row. */
class Interner {
  private cache = new Map<string, number>()
  constructor(private table: 'groups' | 'agents') {}

  async id(name: string): Promise<number> {
    const hit = this.cache.get(name)
    if (hit !== undefined) return hit

    await db().execute({
      sql: `INSERT INTO ${this.table} (name) VALUES (?) ON CONFLICT (name) DO NOTHING`,
      args: [name],
    })
    const result = await db().execute({
      sql: `SELECT id FROM ${this.table} WHERE name = ?`,
      args: [name],
    })
    const id = Number((result.rows[0] as unknown as { id: number }).id)
    this.cache.set(name, id)
    return id
  }
}

async function flush(rows: Row[], groups: Interner, agents: Interner) {
  if (rows.length === 0) return

  const args: (string | number | null)[] = []
  const tuples: string[] = []
  for (const row of rows) {
    const g = await groups.id(row.group)
    const a = row.agent ? await agents.id(row.agent) : null
    // Calendar day is stored alongside the timestamp so the dashboard can
    // group without computing strftime() over every row.
    const day = row.ts ? Number(new Date(row.ts * 1000).toISOString().slice(0, 10).replace(/-/g, '')) : null
    args.push(g, a, row.dir, row.fn, row.ts, day, row.lead, row.phone, row.sz)
    tuples.push('(?,?,?,?,?,?,?,?,?)')
  }

  await db().execute({
    sql: `INSERT INTO recordings (g, a, dir, fn, ts, day, lead, phone, sz)
          VALUES ${tuples.join(',')}
          ON CONFLICT (g, dir, fn) DO UPDATE SET
            a = excluded.a, ts = excluded.ts, day = excluded.day,
            lead = excluded.lead, phone = excluded.phone, sz = excluded.sz`,
    args,
  })
}

async function main() {
  if (!process.env.TURSO_DATABASE_URL) throw new Error('TURSO_DATABASE_URL is not set')

  await ensureSchema()

  const groups = new Interner('groups')
  const agents = new Interner('agents')
  const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1' })

  let seen = 0
  let indexed = 0
  let skipped = 0
  let batch: Row[] = []
  const started = Date.now()

  const prefixes = await scanPrefixes(s3)
  if (RECENT > 0) console.log(`scanning ${prefixes.length} recent folders (--recent=${RECENT})`)

  for (const prefix of prefixes) {
    let token: string | undefined
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token })
      )

      for (const object of page.Contents ?? []) {
        const key = object.Key
        if (!key || key.endsWith('/')) continue // folder markers
        seen++

        const parsed = parseRecording(key)
        const parts = splitKey(key)
        if (!parsed.parsed || !parts) {
          skipped++
          continue
        }

        batch.push({
          group: parts.group,
          agent: parsed.agent,
          dir: parts.dir,
          fn: parts.fn,
          ts: parsed.recordedAt ? Math.floor(new Date(parsed.recordedAt).getTime() / 1000) : null,
          lead: parsed.leadId ? Number(parsed.leadId) : null,
          phone: parsed.phone ? Number(parsed.phone) : null,
          sz: object.Size ?? 0,
        })

        if (batch.length >= BATCH) {
          await flush(batch, groups, agents)
          indexed += batch.length
          batch = []
          const rate = Math.round(indexed / ((Date.now() - started) / 1000))
          process.stdout.write(
            `\rindexed ${indexed.toLocaleString()} of ${seen.toLocaleString()} seen (${rate}/s)…`
          )
        }
      }

      token = page.NextContinuationToken
    } while (token)
  }

  await flush(batch, groups, agents)
  indexed += batch.length

  // The dashboard reads these back as one row, so they are computed here where
  // the cost does not sit in front of a page load.
  await refreshStats()

  const total = await db().execute('SELECT count(*) AS n FROM recordings')
  const elapsed = Math.round((Date.now() - started) / 1000)

  console.log(`\n\nseen:     ${seen.toLocaleString()}`)
  console.log(`indexed:  ${indexed.toLocaleString()}`)
  console.log(`skipped:  ${skipped} (filename did not match the expected pattern)`)
  console.log(`in index: ${Number((total.rows[0] as unknown as { n: number }).n).toLocaleString()}`)
  console.log(`took:     ${elapsed}s`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
