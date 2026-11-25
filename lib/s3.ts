import { S3Client } from '@aws-sdk/client-s3'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { readAwsProfile } from './aws-profile'

export const BUCKET = process.env.S3_BUCKET ?? 'poshnee-call-recordings'
export const PREFIX = process.env.S3_PREFIX ?? 'dialer/'

/** Playback links are short-lived: a leaked URL stops working within minutes. */
const URL_TTL_SECONDS = 300

let cached: S3Client | null = null

/**
 * Read-only credentials for serving recordings.
 *
 * Explicit keys win, because that is how Vercel supplies them. Locally it then
 * looks for a named profile — `reader` unless S3_READ_PROFILE says otherwise —
 * rather than letting the SDK walk its own credential chain.
 *
 * That last part is the whole point, and an earlier comment here had it wrong.
 * The chain ends at the `default` profile, and on the machine this is developed
 * on `default` is `dialer-uploader`: the upload-only key given to the dialer
 * vendor. Inheriting it meant every playback failed with AccessDenied and a
 * misleading comment to read while working out why.
 */
export function s3Client() {
  if (cached) return cached

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  const credentials =
    accessKeyId && secretAccessKey
      ? { accessKeyId, secretAccessKey }
      : (readAwsProfile(process.env.S3_READ_PROFILE ?? 'reader') ?? undefined)

  cached = new S3Client({
    region: process.env.AWS_REGION ?? 'ap-south-1',
    ...(credentials ? { credentials } : {}),
  })
  return cached
}

export async function presignRecording(key: string, download = false): Promise<string> {
  // Defence in depth: never sign anything outside the dialer prefix.
  if (!key.startsWith(PREFIX)) {
    throw new Error('Refusing to sign a key outside the recordings prefix')
  }

  const filename = key.split('/').pop() ?? 'recording.mp3'
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ...(download
      ? { ResponseContentDisposition: `attachment; filename="${filename}"` }
      : {}),
  })

  return getSignedUrl(s3Client(), command, { expiresIn: URL_TTL_SECONDS })
}
