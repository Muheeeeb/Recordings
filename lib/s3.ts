import { S3Client } from '@aws-sdk/client-s3'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export const BUCKET = process.env.S3_BUCKET ?? 'poshnee-call-recordings'
export const PREFIX = process.env.S3_PREFIX ?? 'dialer/'

/** Playback links are short-lived: a leaked URL stops working within minutes. */
const URL_TTL_SECONDS = 300

let cached: S3Client | null = null

/**
 * Explicit keys are used when present (that is how Vercel supplies them).
 * Otherwise the SDK falls back to its own credential chain, which picks up the
 * local `reader` profile — so the same code works in both places.
 */
export function s3Client() {
  if (cached) return cached

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY

  cached = new S3Client({
    region: process.env.AWS_REGION ?? 'ap-south-1',
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
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
