/**
 * Audio for the QA portal, streamed through the app.
 *
 * This endpoint exists because /api/play cannot be used by QA. That one hands
 * the browser a presigned S3 URL, and the URL contains the object key, and the
 * key contains the customer's phone number — so the number would be sitting in
 * the network tab whatever the page chose to display. On top of that a
 * presigned URL is a download link by construction.
 *
 * So the bytes come through here instead. The browser is given a serial, never
 * a key; the response carries no filename; and the only thing the network tab
 * shows is `?s=PN-0000123`.
 *
 * Range requests are honoured because without them an <audio> element cannot
 * seek, and a reviewer who has to listen to a twenty-minute call from the start
 * every time will not use the portal.
 *
 * What this does not do is make the audio undownloadable. Anyone who can hear a
 * recording can capture it — from the network tab, or by recording the output.
 * What it does is keep the phone number out of the browser entirely and make
 * every listen attributable, which is the part that actually protects the
 * number.
 */

import { GetObjectCommand } from '@aws-sdk/client-s3'
import { BUCKET, s3Client } from '@/lib/s3'
import { buildKey, listGroups } from '@/lib/db'
import { qaResolve } from '@/lib/qa'
import { getUserGroups } from '@/lib/users'
import { parseSerial } from '@/lib/serials'
import { logActivity, shouldLogPlay } from '@/lib/activity'
import { requireReviewer, requestOrigin } from '@/lib/guard'

/** Playback must never be served from a shared cache. */
const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  // Inline with no filename. A filename here would reintroduce the number.
  'Content-Disposition': 'inline',
  'Accept-Ranges': 'bytes',
  // The response is audio; nothing should try to sniff it into something else.
  'X-Content-Type-Options': 'nosniff',
}

function deny(status: number, error: string) {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function GET(request: Request) {
  const guard = await requireReviewer()
  if (!guard.ok) return guard.response

  const serial = parseSerial(new URL(request.url).searchParams.get('s') ?? '')
  if (serial === null) return deny(400, 'Missing or malformed serial')

  // An admin may open the QA portal to check what it exposes, so an admin is
  // allowed every group. A QA account gets exactly its grants, and an account
  // with none gets nothing.
  const allowed = guard.role === 'admin' ? await listGroups() : await getUserGroups(guard.username)

  const ref = await qaResolve(serial, allowed)
  if (!ref) {
    // Not found and not permitted are answered identically on purpose: a
    // distinguishable 403 would tell a reviewer which serials exist outside
    // their grants.
    const { ip, ua } = await requestOrigin()
    await logActivity({
      username: guard.username,
      role: guard.role,
      action: 'denied',
      serial,
      detail: 'stream: unknown serial or group not granted',
      ip,
      ua,
    })
    return deny(404, 'Not found')
  }

  const key = buildKey(ref.group, ref.dir, ref.fn)
  const range = request.headers.get('range') ?? undefined

  try {
    const object = await s3Client().send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key, ...(range ? { Range: range } : {}) })
    )

    if (!object.Body) return deny(502, 'Could not read the recording')

    // One row per listening session, not per Range request: a single play
    // produces many of these, and the opening chunk is the one that means
    // somebody pressed play.
    const isStart = !range || /^bytes=0-/.test(range)
    if (isStart && (await shouldLogPlay(guard.username, serial))) {
      const { ip, ua } = await requestOrigin()
      await logActivity({
        username: guard.username,
        role: guard.role,
        action: 'play',
        serial,
        detail: ref.group,
        ip,
        ua,
      })
    }

    const headers = new Headers(PRIVATE_HEADERS)
    headers.set('Content-Type', object.ContentType ?? 'audio/mpeg')
    if (object.ContentLength !== undefined) {
      headers.set('Content-Length', String(object.ContentLength))
    }
    if (object.ContentRange) headers.set('Content-Range', object.ContentRange)

    return new Response(object.Body.transformToWebStream(), {
      // 206 only when S3 actually served a partial response, rather than
      // whenever a Range header was present.
      status: object.ContentRange ? 206 : 200,
      headers,
    })
  } catch (error) {
    const name = (error as { name?: string })?.name
    if (name === 'NoSuchKey' || name === 'NotFound') return deny(404, 'Not found')
    if (name === 'InvalidRange') return deny(416, 'Requested range not satisfiable')
    console.error('qa stream failed', name, error)
    return deny(500, 'Could not play the recording')
  }
}

/**
 * Some players probe with HEAD before streaming. Answered by asking S3 for the
 * first byte rather than the whole object, so a probe does not pull megabytes.
 */
export async function HEAD(request: Request) {
  const guard = await requireReviewer()
  if (!guard.ok) return new Response(null, { status: guard.response.status })

  const serial = parseSerial(new URL(request.url).searchParams.get('s') ?? '')
  if (serial === null) return new Response(null, { status: 400 })

  const allowed = guard.role === 'admin' ? await listGroups() : await getUserGroups(guard.username)
  const ref = await qaResolve(serial, allowed)
  if (!ref) return new Response(null, { status: 404 })

  try {
    const object = await s3Client().send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: buildKey(ref.group, ref.dir, ref.fn),
        Range: 'bytes=0-0',
      })
    )
    const headers = new Headers(PRIVATE_HEADERS)
    headers.set('Content-Type', object.ContentType ?? 'audio/mpeg')
    // ContentRange on a one-byte request looks like "bytes 0-0/5758464"; the
    // total after the slash is the length the player is asking for.
    const total = /\/(\d+)$/.exec(object.ContentRange ?? '')?.[1]
    if (total) headers.set('Content-Length', total)
    return new Response(null, { status: 200, headers })
  } catch {
    return new Response(null, { status: 404 })
  }
}
