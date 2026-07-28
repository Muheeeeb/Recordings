/**
 * Counts recordings per calendar day so we can tell a one-off bulk import
 * apart from a sustained daily upload rate. Index sizing depends on the
 * ongoing rate, not the current total.
 *
 *   $env:AWS_PROFILE="reader"; npx tsx scripts/daily-volume.ts
 */

import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { parseRecording } from '../lib/parse'

const BUCKET = process.env.S3_BUCKET ?? 'poshnee-call-recordings'
const PREFIX = process.env.S3_PREFIX ?? 'dialer/'

async function main() {
  const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1' })

  // Calls grouped by the day they were recorded, and by the day they landed
  // in S3 — a bulk import shows many recorded days on a single upload day.
  const recorded = new Map<string, { count: number; bytes: number }>()
  const uploaded = new Map<string, number>()

  let token: string | undefined
  let scanned = 0

  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token })
    )

    for (const object of page.Contents ?? []) {
      const key = object.Key
      if (!key || key.endsWith('/')) continue
      scanned++

      const r = parseRecording(key)
      if (r.parsed && r.recordedAt) {
        const day = r.recordedAt.slice(0, 10)
        const entry = recorded.get(day) ?? { count: 0, bytes: 0 }
        entry.count++
        entry.bytes += object.Size ?? 0
        recorded.set(day, entry)
      }

      if (object.LastModified) {
        const day = object.LastModified.toISOString().slice(0, 10)
        uploaded.set(day, (uploaded.get(day) ?? 0) + 1)
      }
    }

    token = page.NextContinuationToken
    process.stdout.write(`\rscanned ${scanned}…`)
  } while (token)

  console.log('\n\nRECORDED ON (from filename)')
  for (const [day, s] of [...recorded.entries()].sort()) {
    const mb = (s.bytes / 1024 ** 2).toFixed(0)
    console.log(`  ${day}   ${String(s.count).padStart(7)} calls   ${mb.padStart(6)} MB`)
  }

  console.log('\nUPLOADED ON (S3 LastModified)')
  for (const [day, count] of [...uploaded.entries()].sort()) {
    console.log(`  ${day}   ${String(count).padStart(7)} files`)
  }

  const days = [...recorded.values()]
  const avg = days.reduce((a, b) => a + b.count, 0) / Math.max(days.length, 1)
  console.log(`\naverage per recorded day: ${Math.round(avg).toLocaleString()}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
