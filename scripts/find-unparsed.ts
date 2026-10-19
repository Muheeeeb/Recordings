/**
 * Samples keys from each group and reports the ones the parser rejects, so a
 * filename format the dialer changed without telling us is identifiable rather
 * than just a number in the skipped count.
 *
 *   $env:AWS_PROFILE="reader"; npx tsx scripts/find-unparsed.ts
 */

import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { parseRecording } from '../lib/parse'

const BUCKET = process.env.S3_BUCKET ?? 'poshnee-call-recordings'
const GROUPS = ['Rockey_Dialer', 'KTN_Group', 'Main_ACA_Fronter', 'Closers_ACA']
const SAMPLE = 8000

async function main() {
  const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1' })

  for (const group of GROUPS) {
    let token: string | undefined
    let seen = 0
    let bad = 0
    const samples: string[] = []

    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: `dialer/${group}/`,
          ContinuationToken: token,
        })
      )
      for (const o of page.Contents ?? []) {
        const key = o.Key
        if (!key || key.endsWith('/')) continue
        seen++
        if (!parseRecording(key).parsed) {
          bad++
          if (samples.length < 5) samples.push(key.split('/').pop()!)
        }
      }
      token = page.NextContinuationToken
    } while (token && seen < SAMPLE)

    console.log(`${group.padEnd(24)} sampled ${seen}  unparsed ${bad}`)
    samples.forEach((s) => console.log(`    ${s}`))
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
