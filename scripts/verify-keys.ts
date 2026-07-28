/**
 * End-to-end check that reconstructed S3 keys resolve to real objects.
 *
 * The index stores parts, not the full key, so a reconstruction bug would only
 * surface as a broken play button. This samples rows from every group and from
 * both ends of the date range, then HEADs each object to confirm it exists and
 * that the recorded size matches.
 *
 *   $env:AWS_PROFILE="reader"; npx tsx --env-file=.env.local scripts/verify-keys.ts
 */

import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { buildKey, db } from '../lib/db'

const BUCKET = process.env.S3_BUCKET ?? 'poshnee-call-recordings'

type Sample = { grp: string; dir: string; fn: string; sz: number }

const SELECT = `SELECT g.name AS grp, r.dir, r.fn, r.sz
                FROM recordings r JOIN groups g ON g.id = r.g`

async function rows(sql: string, args: (string | number)[]): Promise<Sample[]> {
  const result = await db().execute({ sql, args })
  return result.rows as unknown as Sample[]
}

async function main() {
  const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1' })

  const groups = await db().execute('SELECT id, name FROM groups ORDER BY id')
  const samples: Sample[] = []

  // A slice of every group, using the (g, dir, fn) unique index.
  for (const row of groups.rows) {
    const g = Number((row as never)['id'])
    samples.push(...(await rows(`${SELECT} WHERE r.g = ? LIMIT 20`, [g])))
    // Both ends of that group's date range, via the (g, ts) index.
    samples.push(...(await rows(`${SELECT} WHERE r.g = ? ORDER BY r.ts DESC LIMIT 10`, [g])))
    samples.push(...(await rows(`${SELECT} WHERE r.g = ? ORDER BY r.ts ASC LIMIT 10`, [g])))
  }

  const seen = new Set<string>()
  const unique = samples.filter((s) => {
    const key = buildKey(s.grp, s.dir, s.fn)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  let ok = 0
  let missing = 0
  let mismatched = 0
  const failures: string[] = []

  for (const s of unique) {
    const key = buildKey(s.grp, s.dir, s.fn)
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
      if (Number(head.ContentLength) !== Number(s.sz)) {
        mismatched++
        failures.push(`SIZE ${key} (index ${s.sz}, s3 ${head.ContentLength})`)
      } else {
        ok++
      }
    } catch {
      missing++
      if (failures.length < 10) failures.push(`MISSING ${key}`)
    }
  }

  console.log(`\nchecked:    ${unique.length}`)
  console.log(`resolved:   ${ok}`)
  console.log(`missing:    ${missing}`)
  console.log(`size drift: ${mismatched}`)
  if (failures.length) {
    console.log('\nfailures:')
    failures.forEach((f) => console.log('  ' + f))
  } else {
    console.log('\nevery sampled key resolved to a real object with a matching size.')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
