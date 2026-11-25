/**
 * The activity log — admin only.
 *
 * Answers "who listened to what" over a date range, and summarises how much
 * each person did. Rows hold serials, never phone numbers or S3 keys, so this
 * response is safe to export; resolving a serial to the real call is a separate,
 * separately logged step through /api/play?serial=…
 */

import { NextResponse } from 'next/server'
import { activitySummary, listActivity } from '@/lib/activity'
import { parseSerial } from '@/lib/serials'
import { requireAdmin } from '@/lib/guard'

/** `2026-11-25` to unix seconds; end of day when asked for the upper bound. */
function toUnix(value: string | null, endOfDay = false): number | undefined {
  if (!value) return undefined
  const ms = new Date(endOfDay ? `${value}T23:59:59Z` : `${value}T00:00:00Z`).getTime()
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000)
}

export async function GET(request: Request) {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  const params = new URL(request.url).searchParams
  const page = Math.max(0, Number(params.get('page') ?? 0) || 0)
  const limit = 100

  const from = toUnix(params.get('from'))
  const to = toUnix(params.get('to'), true)
  const serialTerm = params.get('serial')

  try {
    const rows = await listActivity({
      username: params.get('user') || undefined,
      action: params.get('action') || undefined,
      serial: serialTerm ? (parseSerial(serialTerm) ?? undefined) : undefined,
      from,
      to,
      limit,
      offset: page * limit,
    })

    // The summary covers the same window the rows do, defaulting to the last
    // seven days so the page is useful before any filter is set.
    const week = 7 * 24 * 60 * 60
    const nowSec = Math.floor(Date.now() / 1000)
    const summary = await activitySummary(from ?? nowSec - week, to ?? nowSec)

    return NextResponse.json(
      { rows, summary, page, hasMore: rows.length === limit },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (error) {
    console.error('activity read failed', error)
    return NextResponse.json({ error: 'Could not load the activity log' }, { status: 500 })
  }
}
