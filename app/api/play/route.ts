import { NextResponse } from 'next/server'
import { recordingExists } from '@/lib/db'
import { presignRecording } from '@/lib/s3'
import { SESSION_COOKIE, readSession } from '@/lib/auth'
import { cookies } from 'next/headers'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const key = url.searchParams.get('key')
  const download = url.searchParams.get('download') === '1'

  if (!key) {
    return NextResponse.json({ error: 'Missing key' }, { status: 400 })
  }

  // The middleware already gates this route; re-checking here means a future
  // matcher change cannot silently expose recordings.
  const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Only keys we indexed can be signed, so the endpoint cannot be used to
  // probe for arbitrary objects.
  if (!(await recordingExists(key))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  try {
    const signed = await presignRecording(key, download)
    const who = session
    console.info(`[audit] ${who} ${download ? 'download' : 'play'} ${key}`)
    return NextResponse.json({ url: signed })
  } catch (error) {
    console.error('presign failed', error)
    return NextResponse.json({ error: 'Could not prepare playback' }, { status: 500 })
  }
}
