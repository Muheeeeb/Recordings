/**
 * Pulls Morpheus recordings into S3.
 *
 * Scope: every ACA-CLOSER and Med-Closer recording, and every self-verifier
 * recording. Fronter, the bots campaign and blank-campaign rows are skipped —
 * Fronter alone is about 70,000 calls a day and nobody needs it archived.
 *
 * Keys follow lib/morpheus-key.ts, which names files so the dashboard's
 * existing parser reads them like any other dialer's. No folders need creating
 * first: in S3 a folder is only a prefix on the key, so it appears when the
 * first object lands.
 *
 * Idempotency without a database: the destination prefixes are listed first
 * and the Morpheus recording id, which is part of every key, says what is
 * already there. If listing is denied — the upload-only credential cannot list
 * — it falls back to a local state file. Either way a re-run uploads nothing
 * twice, so the job is safe to run on a schedule and safe to retry.
 *
 * Every upload is checked: S3 returns the object's MD5 as the ETag on a
 * single-part PUT, so it is compared against the MD5 of the bytes that were
 * sent. A silently truncated upload fails here rather than becoming a
 * recording that will not play months later.
 *
 *   npx tsx --env-file=.env.local scripts/morpheus-pull.ts --days=3
 *   npx tsx --env-file=.env.local scripts/morpheus-pull.ts --from=2026-11-06 --to=2026-11-24
 *   npx tsx --env-file=.env.local scripts/morpheus-pull.ts --days=3 --dry-run
 *
 * Credentials: listing uses AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (the
 * reader). Uploading uses S3_UPLOAD_ACCESS_KEY_ID/S3_UPLOAD_SECRET_ACCESS_KEY
 * (the Morpheus uploader) when set, otherwise the same chain. Keeping them
 * apart means the job that writes recordings cannot read anything else, and
 * the credential that can read cannot overwrite.
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import {
  PAGE, dayRange, exactCount, fetchPage, instances,
  isCloserCampaign, isVerifierCampaign, type Instance, type RecordingRow,
} from '../lib/morpheus'
import { buildKey, extensionFor, folderForCampaign } from '../lib/morpheus-key'

const BUCKET = process.env.S3_BUCKET ?? 'poshnee-call-recordings'
const PREFIX = process.env.S3_PREFIX ?? 'dialer/'
const REGION = process.env.AWS_REGION ?? 'ap-south-1'
const STATE_FILE = 'morpheus-uploaded.txt'

const flag = (name: string) => process.argv.includes(`--${name}`)
const arg = (name: string, fallback?: string) => {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? m.split('=').slice(1).join('=') : fallback
}

const DRY = flag('dry-run')
// Archive recordings the dialer has not re-encoded to M4A yet. Off by default:
// a WAV is ~4x the bytes of the same call. See isWav.
const ALLOW_WAV = flag('allow-wav')
const CONCURRENCY = Number(arg('concurrency', '6'))
/** Recordings shorter than this are dial noise, not conversations. 0 keeps all. */
const MIN_SECONDS = Number(arg('min-seconds', '0'))

/**
 * Credentials, chosen by name rather than left to the SDK.
 *
 * The default profile on this machine is dialer-uploader — the credential that
 * was handed to the recordings vendor. The SDK's default chain would pick it up
 * silently, so a job that writes our own archive would end up running as the
 * vendor. Both credentials are therefore named explicitly, and a write refuses
 * to start if it resolves to the machine default.
 */
const READ_PROFILE = process.env.S3_READ_PROFILE ?? 'reader'
const WRITE_PROFILE = process.env.S3_UPLOAD_PROFILE ?? 'morpheus'

function readProfile(name: string): { accessKeyId: string; secretAccessKey: string } | null {
  const file = join(homedir(), '.aws', 'credentials')
  if (!existsSync(file)) return null
  let section = ''
  const found: Record<string, string> = {}
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[(.+)\]$/.exec(line)
    if (header) { section = header[1].trim(); continue }
    if (section !== name) continue
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (kv) found[kv[1].toLowerCase()] = kv[2].trim()
  }
  const accessKeyId = found['aws_access_key_id']
  const secretAccessKey = found['aws_secret_access_key']
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null
}

type Cred = { accessKeyId: string; secretAccessKey: string; source: string }

function credentialFor(kind: 'read' | 'write'): Cred | null {
  const envId = kind === 'write' ? process.env.S3_UPLOAD_ACCESS_KEY_ID : process.env.AWS_ACCESS_KEY_ID
  const envSecret = kind === 'write' ? process.env.S3_UPLOAD_SECRET_ACCESS_KEY : process.env.AWS_SECRET_ACCESS_KEY
  if (envId && envSecret) return { accessKeyId: envId, secretAccessKey: envSecret, source: 'environment' }
  const name = kind === 'write' ? WRITE_PROFILE : READ_PROFILE
  const p = readProfile(name)
  return p ? { ...p, source: `profile "${name}"` } : null
}

/** What this run will use, for the banner. Never prints a secret. */
export function credentialSummary() {
  const describe = (c: Cred | null) => (c ? `${c.source}  (…${c.accessKeyId.slice(-4)})` : 'SDK default chain')
  return { read: describe(credentialFor('read')), write: describe(credentialFor('write')) }
}

function client(kind: 'read' | 'write') {
  const cred = credentialFor(kind)
  if (kind === 'write') {
    if (!cred) {
      throw new Error(
        `No upload credential. Add a "${WRITE_PROFILE}" profile to ~/.aws/credentials, ` +
          'or set S3_UPLOAD_ACCESS_KEY_ID and S3_UPLOAD_SECRET_ACCESS_KEY.'
      )
    }
    const machineDefault = readProfile('default')
    if (machineDefault && machineDefault.accessKeyId === cred.accessKeyId) {
      throw new Error(
        'Refusing to upload: this credential is the machine default, which on this ' +
          "machine is the vendor's dialer-uploader key. Point S3_UPLOAD_PROFILE at a " +
          'dedicated uploader instead.'
      )
    }
  }
  return new S3Client({
    region: REGION,
    ...(cred ? { credentials: { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey } } : {}),
  })
}

/** In scope, and worth the bytes. */
function inScope(r: RecordingRow): boolean {
  if (!isCloserCampaign(r.campaign) && !isVerifierCampaign(r.campaign)) return false
  if ((r.file_size ?? 0) <= 0) return false
  if ((r.duration_sec ?? 0) < MIN_SECONDS) return false
  return folderForCampaign(r.campaign) !== null
}

/**
 * The recording ids already in S3. Returns null if the credential cannot list,
 * so the caller knows to use the state file instead of assuming nothing exists
 * — assuming an empty bucket would re-upload everything on every run.
 */
async function idsInS3(s3: S3Client, folders: string[]): Promise<Set<string> | null> {
  const ids = new Set<string>()
  for (const folder of folders) {
    let token: string | undefined
    do {
      try {
        const res = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${PREFIX}${folder}/`, ContinuationToken: token })
        )
        for (const o of res.Contents ?? []) {
          // …_SEG_<32 hex>.ext — the Morpheus id, dashes stripped.
          const m = /_([0-9a-f]{32})\.[a-z0-9]+$/i.exec(o.Key ?? '')
          if (m) ids.add(m[1].toLowerCase())
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined
      } catch (e) {
        // Narrowed rather than typed as any: an SDK error reports its kind on
        // `name`, an older one on `Code`, and neither is on the Error type.
        const err = e as { name?: string; Code?: string; message?: string }
        const code = err?.name ?? err?.Code ?? ''
        if (/AccessDenied/i.test(code) || /AccessDenied/i.test(String(err?.message))) return null
        throw e
      }
    } while (token)
  }
  return ids
}

function idsFromState(): Set<string> {
  if (!existsSync(STATE_FILE)) return new Set()
  return new Set(
    readFileSync(STATE_FILE, 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean)
  )
}

type Result = { uploaded: number; skipped: number; failed: number; bytes: number; pending: number }

/**
 * The dialer records to uncompressed WAV and re-encodes to M4A roughly a day
 * and a half later. The vendor's words: "This is by design. If you want M4A
 * recording format, pull recordings after 24 hours in Basic plan." Measured on
 * 25 Nov 2026, recordings created 23 Nov up to 21:45 had become M4A while
 * 23:59 was still WAV, so the real lag is nearer 30 hours than 24.
 *
 * A WAV is about 4x the bytes of the same call as M4A, so there is no reason
 * to archive one: it stays on the dialer and a later run takes the M4A. With a
 * 7-day window every day gets six more chances before it leaves the window,
 * which is ample for a lag measured in hours. This is a wait, not a loss.
 */
function isWav(b: Buffer): boolean {
  return b.length >= 12 &&
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WAVE'
}

async function pullDay(
  inst: Instance,
  day: string,
  have: Set<string>,
  s3w: S3Client,
  seen: Set<string>
): Promise<Result> {
  const dayTotal = await exactCount(inst, dayRange(day))
  if (dayTotal <= 0) {
    console.log(`  ${day}   no calls`)
    return { uploaded: 0, skipped: 0, failed: 0, bytes: 0, pending: 0 }
  }

  // Find what this day holds before downloading anything.
  const wanted: RecordingRow[] = []
  const offsets: number[] = []
  for (let o = 0; o < dayTotal; o += PAGE) offsets.push(o)
  const listQueue = [...offsets]
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let off = listQueue.shift(); off !== undefined; off = listQueue.shift()) {
        for (const r of await fetchPage(inst, dayRange(day), off)) if (inScope(r)) wanted.push(r)
      }
    })
  )

  const todo = wanted.filter((r) => {
    const id = r.id.replace(/-/g, '').toLowerCase()
    if (have.has(id) || seen.has(id)) return false
    seen.add(id)
    return true
  })
  const already = wanted.length - todo.length

  if (todo.length === 0) {
    console.log(`  ${day}   ${String(dayTotal).padStart(7)} calls   in scope ${String(wanted.length).padStart(5)}   already in S3 ${already}   nothing to do`)
    return { uploaded: 0, skipped: already, failed: 0, bytes: 0, pending: 0 }
  }

  let uploaded = 0
  let failed = 0
  let pending = 0
  let bytes = 0
  const problems: string[] = []

  // A dry run reports from the listing and downloads nothing. Fetching the
  // audio just to throw it away would move tens of gigabytes to answer a
  // question the metadata already answers, and file_size is the real size.
  if (DRY) {
    const wouldBytes = todo.reduce((s, r) => s + (r.file_size ?? 0), 0)
    console.log(
      `  ${day}   ${String(dayTotal).padStart(7)} calls   in scope ${String(todo.length + already).padStart(5)}   ` +
        `skipped ${String(already).padStart(5)}   would upload ${String(todo.length).padStart(5)}   ${(wouldBytes / 1024 ** 2).toFixed(0).padStart(6)} MB`
    )
    for (const r of todo.slice(0, 2)) {
      const key = buildKey(r, { prefix: PREFIX, ext: extensionFor(r.file_size && r.file_size / Math.max(1, r.duration_sec ?? 1) > 20000 ? 'audio/wav' : 'audio/mp4') })
      console.log(`              ${key}`)
    }
    return { uploaded: todo.length, skipped: already, failed: 0, bytes: wouldBytes, pending: 0 }
  }

  const queue = [...todo]
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let r = queue.shift(); r !== undefined; r = queue.shift()) {
        try {
          const res = await fetch(`https://${inst.host}${r.download_url}`, { headers: inst.headers })
          if (!res.ok) {
            failed++
            if (problems.length < 5) problems.push(`${r.id.slice(0, 8)} download ${res.status}`)
            continue
          }
          const body = Buffer.from(await res.arrayBuffer())

          // Not converted yet - leave it on the dialer rather than paying 4x
          // the storage for the same call. See isWav above.
          if (!ALLOW_WAV && isWav(body)) {
            pending++
            continue
          }

          const ext = extensionFor(res.headers.get('content-type'))
          const key = buildKey(r, { prefix: PREFIX, ext })
          if (!key) { failed++; continue }

          const md5 = createHash('md5').update(body).digest('hex')
          const put = await s3w.send(
            new PutObjectCommand({
              Bucket: BUCKET,
              Key: key,
              Body: body,
              ContentType: res.headers.get('content-type') ?? 'application/octet-stream',
              // Kept on the object so a recording can be traced back to the
              // API record without re-deriving it from the filename.
              Metadata: {
                'morpheus-id': r.id,
                'morpheus-campaign': String(r.campaign ?? ''),
                'morpheus-segment': String(r.segment ?? ''),
                'morpheus-agent': String(r.agent ?? ''),
                'morpheus-call-uuid': String(r.call_uuid ?? ''),
                'duration-sec': String(r.duration_sec ?? ''),
              },
            })
          )

          // A single-part PUT returns the body's MD5 as the ETag. If it does
          // not match, what landed in S3 is not what was downloaded.
          const etag = (put.ETag ?? '').replace(/"/g, '').toLowerCase()
          if (etag && etag !== md5) {
            failed++
            if (problems.length < 5) problems.push(`${r.id.slice(0, 8)} ETag mismatch`)
            continue
          }

          appendFileSync(STATE_FILE, `${r.id.replace(/-/g, '').toLowerCase()}\n`)
          uploaded++
          bytes += body.length
        } catch (e) {
          const err = e as { message?: string }
          failed++
          if (problems.length < 5) problems.push(`${r.id.slice(0, 8)} ${(err?.message ?? e)?.toString().slice(0, 60)}`)
        }
      }
    })
  )

  console.log(
    `  ${day}   ${String(dayTotal).padStart(7)} calls   in scope ${String(wanted.length).padStart(5)}   ` +
      `skipped ${String(already).padStart(5)}   ${DRY ? 'would upload' : 'uploaded'} ${String(uploaded).padStart(5)}   ` +
      `${(bytes / 1024 ** 2).toFixed(0).padStart(6)} MB${pending ? `   not yet M4A ${pending}` : ''}${failed ? `   FAILED ${failed}` : ''}`
  )
  for (const p of problems) console.log(`              ${p}`)

  return { uploaded, skipped: already, failed, bytes, pending }
}

async function main() {
  const inst = instances()[0]
  const folders = ['Morpheus_ACA_Closer', 'Morpheus_Med_Closer', 'Morpheus_Self_Verifier', 'Morpheus_Closer_Other']

  // Which days to pull.
  const days: string[] = []
  const from = arg('from')
  const to = arg('to')
  if (from) {
    const end = new Date(`${to ?? from}T00:00:00Z`)
    for (let d = new Date(`${from}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(d.toISOString().slice(0, 10))
    }
  } else {
    // The last N days including today, newest first so a run that is cut short
    // has still captured the most recent calls.
    const n = Number(arg('days', '3'))
    const today = new Date()
    for (let i = 0; i < n; i++) {
      const d = new Date(today)
      d.setUTCDate(d.getUTCDate() - i)
      days.push(d.toISOString().slice(0, 10))
    }
  }

  console.log(`${inst.label} (${inst.host}) -> s3://${BUCKET}/${PREFIX}`)
  console.log(`days: ${days.join(', ')}`)
  console.log(`scope: closers + self-verifier${MIN_SECONDS ? `, at least ${MIN_SECONDS}s` : ''}${DRY ? '   [DRY RUN — nothing is uploaded]' : ''}\n`)
  const cred = credentialSummary()
  console.log(`credentials: read ${cred.read}   write ${cred.write}`)
  console.log(`bucket:      ${BUCKET}  prefix ${PREFIX}  region ${REGION}
`)

  // What is already there.
  const listed = await idsInS3(client('read'), folders)
  let have: Set<string>
  if (listed) {
    console.log(`already in S3: ${listed.size.toLocaleString()} recordings (from listing the bucket)\n`)
    have = listed
  } else {
    have = idsFromState()
    console.log(`cannot list the bucket with this credential; using ${STATE_FILE}: ${have.size.toLocaleString()} recordings\n`)
  }

  const s3w = client('write')
  const seen = new Set<string>()
  const totals: Result = { uploaded: 0, skipped: 0, failed: 0, bytes: 0, pending: 0 }

  for (const day of days) {
    const r = await pullDay(inst, day, have, s3w, seen)
    totals.uploaded += r.uploaded
    totals.skipped += r.skipped
    totals.failed += r.failed
    totals.pending += r.pending
    totals.bytes += r.bytes
  }

  console.log(`\n${DRY ? 'WOULD UPLOAD' : 'UPLOADED'}: ${totals.uploaded.toLocaleString()} recordings, ${(totals.bytes / 1024 ** 3).toFixed(2)} GB`)
  console.log(`already present: ${totals.skipped.toLocaleString()}`)
  if (totals.pending) {
    console.log(
      `still WAV on the dialer, left for a later run: ${totals.pending.toLocaleString()}` +
        `  (pass --allow-wav to archive them as WAV anyway)`
    )
  }
  if (totals.failed) {
    console.log(`FAILED: ${totals.failed}`)
    process.exit(1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
