import { NextResponse } from 'next/server'
import { recordingExists } from '@/lib/db'
import { presignRecording } from '@/lib/s3'
import { logActivity } from '@/lib/activity'
import { requireAdmin, requestOrigin } from '@/lib/guard'
import { parseSerial, resolveSerial } from '@/lib/serials'
import { buildKey } from '@/lib/db'
import { parseRecording } from '@/lib/parse'

/**
 * Presigned playback and download links — admin only.
 *
 * This endpoint is closed to QA accounts, and not merely hidden from their UI.
 * A presigned URL contains the object key, the key contains the customer's
 * phone number, and the URL is a download link whether or not the page offers
 * one. QA audio goes through /api/qa/stream instead, which sends bytes and no
 * key.
 *
 * It also accepts `?serial=PN-0000123`, which is how the admin opens the real
 * recording behind a serial written on a QA report.
 */
export async function GET(request: Request) {
  const guard = await requireAdmin()
  if (!guard.ok) {
    // Worth recording: a QA session reaching here means either a stale
    // bookmark or someone trying the admin endpoint by hand.
    const { ip, ua } = await requestOrigin()
    await logActivity({
      username: 'unknown',
      action: 'denied',
      detail: `play: ${guard.response.status === 403 ? 'not an admin' : 'no session'}`,
      ip,
      ua,
    })
    return guard.response
  }

  const url = new URL(request.url)
  const download = url.searchParams.get('download') === '1'
  const serialParam = url.searchParams.get('serial')

  let key = url.searchParams.get('key')
  let serial: number | null = null

  if (serialParam) {
    serial = parseSerial(serialParam)
    if (serial === null) {
      return NextResponse.json({ error: 'Malformed serial' }, { status: 400 })
    }
    const ref = await resolveSerial(serial)
    if (!ref) return NextResponse.json({ error: 'No recording for that serial' }, { status: 404 })
    key = buildKey(ref.group, ref.dir, ref.fn)
  }

  if (!key) {
    return NextResponse.json({ error: 'Missing key' }, { status: 400 })
  }

  // Only keys we indexed can be signed, so the endpoint cannot be used to
  // probe for arbitrary objects.
  if (!(await recordingExists(key))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  try {
    const signed = await presignRecording(key, download)
    const { ip, ua } = await requestOrigin()
    await logActivity({
      username: guard.username,
      role: guard.role,
      action: download ? 'download' : serialParam ? 'admin_lookup' : 'play',
      serial,
      // The key is not written to the log: the log is exported and pasted far
      // more often than a dashboard is, and the key carries the number.
      detail: key.split('/')[1] ?? null,
      ip,
      ua,
    })
    // When the admin arrived via a serial — off a QA report, say — they want to
    // know which call it is, not just hear it. The filename already carries the
    // number, the agent and the timestamp, so the existing parser answers this
    // without another query.
    const details = serial === null ? null : parseRecording(key)

    return NextResponse.json({ url: signed, serial, details })
  } catch (error) {
    console.error('presign failed', error)
    return NextResponse.json({ error: 'Could not prepare playback' }, { status: 500 })
  }
}
