/**
 * Dry run over the real bucket: lists every object under the prefix, parses
 * each name and reports coverage. No database and no downloads — this exists
 * to prove the parser handles the live data before we build the index.
 *
 *   $env:AWS_PROFILE="reader"; npx tsx scripts/validate-parse.ts
 */

import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { parseRecording } from '../lib/parse'

const BUCKET = process.env.S3_BUCKET ?? 'poshnee-call-recordings'
const PREFIX = process.env.S3_PREFIX ?? 'dialer/'

type Stats = { count: number; bytes: number }

function bump(map: Map<string, Stats>, key: string, bytes: number) {
  const entry = map.get(key) ?? { count: 0, bytes: 0 }
  entry.count++
  entry.bytes += bytes
  map.set(key, entry)
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(2) + ' GB'

async function main() {
  const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1' })

  const groups = new Map<string, Stats>()
  const agents = new Map<string, Stats>()
  const leadLengths = new Map<number, number>()
  const unparsed: string[] = []

  let token: string | undefined
  let objects = 0
  let markers = 0
  let bytes = 0
  let withPhone = 0
  let withLead = 0
  let minDate = ''
  let maxDate = ''

  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token })
    )

    for (const object of page.Contents ?? []) {
      const key = object.Key
      if (!key) continue
      if (key.endsWith('/')) {
        markers++
        continue
      }

      const size = object.Size ?? 0
      objects++
      bytes += size

      const r = parseRecording(key)
      if (!r.parsed) {
        if (unparsed.length < 10) unparsed.push(key)
        continue
      }

      if (r.group) bump(groups, r.group, size)
      if (r.agent) bump(agents, r.agent, size)
      if (r.leadId) {
        withLead++
        leadLengths.set(r.leadId.length, (leadLengths.get(r.leadId.length) ?? 0) + 1)
      }
      if (r.phone) withPhone++
      if (r.recordedAt) {
        if (!minDate || r.recordedAt < minDate) minDate = r.recordedAt
        if (!maxDate || r.recordedAt > maxDate) maxDate = r.recordedAt
      }
    }

    token = page.NextContinuationToken
    process.stdout.write(`\rscanned ${objects} objects…`)
  } while (token)

  const parsed = objects - unparsed.length
  console.log('\n')
  console.log('TOTALS')
  console.log(`  recordings      ${objects.toLocaleString()}`)
  console.log(`  folder markers  ${markers}`)
  console.log(`  total size      ${gb(bytes)}`)
  console.log(`  average size    ${Math.round(bytes / Math.max(objects, 1) / 1024)} KB`)
  console.log(`  date range      ${minDate.slice(0, 10)} .. ${maxDate.slice(0, 10)}`)
  console.log('')
  console.log('PARSING')
  console.log(`  parsed          ${parsed.toLocaleString()} (${((parsed / objects) * 100).toFixed(2)}%)`)
  console.log(`  with lead id    ${withLead.toLocaleString()}`)
  console.log(`  with phone      ${withPhone.toLocaleString()}`)
  console.log(`  lead id lengths ${[...leadLengths.entries()].map(([l, c]) => `${l} digits: ${c}`).join(', ')}`)
  if (unparsed.length) {
    console.log(`  UNPARSED samples:`)
    unparsed.forEach((k) => console.log(`    ${k}`))
  }
  console.log('')
  console.log('BY GROUP')
  for (const [name, s] of [...groups.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${name.padEnd(24)} ${String(s.count).padStart(7)} files  ${gb(s.bytes).padStart(9)}`)
  }
  console.log('')
  console.log(`AGENTS (${agents.size} distinct)`)
  for (const [name, s] of [...agents.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 15)) {
    console.log(`  ${name.padEnd(24)} ${String(s.count).padStart(7)} files`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
