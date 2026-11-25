/**
 * Command-line search over the index — the same query the website runs, usable
 * when the site itself is unavailable.
 *
 *   npx tsx --env-file=.env.local scripts/find.ts 2515550171
 *   npx tsx --env-file=.env.local scripts/find.ts 2515550171 --download
 *
 * --download needs AWS credentials for the reader profile:
 *   $env:AWS_PROFILE="reader"
 */

import { writeFile } from 'node:fs/promises'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { db } from '../lib/db'
import { s3Client, BUCKET } from '../lib/s3'

const term = process.argv[2]
const download = process.argv.includes('--download')

function whenFrom(ts: number | null) {
  if (!ts) return 'unknown time'
  return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

async function main() {
  if (!term) {
    console.error('Usage: npx tsx --env-file=.env.local scripts/find.ts <number> [--download]')
    process.exit(1)
  }

  const digits = term.replace(/\D/g, '')

  // Matched against both columns: older recordings only carry a lead id, newer
  // ones also carry the customer number.
  const result = await db().execute({
    sql: `SELECT g.name AS grp, a.name AS agent, r.dir, r.fn, r.ts, r.lead, r.phone, r.sz
          FROM recordings r
          JOIN groups g ON g.id = r.g
          LEFT JOIN agents a ON a.id = r.a
          WHERE r.phone = ? OR r.lead = ?
          ORDER BY r.ts DESC`,
    args: [Number(digits), Number(digits)],
  })

  if (result.rows.length === 0) {
    console.log(`No recordings found for ${term}.`)
    console.log('Checked both the customer phone number and the lead id.')
    return
  }

  console.log(`${result.rows.length} recording(s) for ${term}:\n`)

  const keys: string[] = []
  for (const row of result.rows) {
    const r = row as unknown as {
      grp: string
      agent: string | null
      dir: string
      fn: string
      ts: number | null
      lead: number | null
      phone: number | null
      sz: number | null
    }
    const key = `dialer/${r.grp}/${r.dir}/${r.fn}`
    keys.push(key)
    const mb = ((Number(r.sz) || 0) / 1024 / 1024).toFixed(2)
    console.log(`  ${whenFrom(r.ts)}   ${r.grp.replace(/_/g, ' ')}   agent ${r.agent ?? '—'}`)
    console.log(`     lead ${r.lead ?? '—'}   phone ${r.phone ?? '—'}   ${mb} MB`)
    console.log(`     ${key}`)
    console.log()
  }

  if (!download) {
    console.log('Re-run with --download to save these locally.')
    return
  }

  const s3 = s3Client()
  for (const key of keys) {
    const name = key.split('/').pop()!
    const body = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    const bytes = await body.Body!.transformToByteArray()
    await writeFile(name, bytes)
    console.log(`saved ${name} (${(bytes.length / 1024 / 1024).toFixed(2)} MB)`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
