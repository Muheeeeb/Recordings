import { NextResponse } from 'next/server'
import { searchRecordings } from '@/lib/db'
import { requireAdmin } from '@/lib/guard'

/** Timestamps are stored as unix seconds to keep rows small. */
function toUnix(value: string | null, endOfDay = false): number | undefined {
  if (!value) return undefined
  const date = new Date(endOfDay ? `${value}T23:59:59Z` : `${value}T00:00:00Z`)
  const ms = date.getTime()
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000)
}

export async function GET(request: Request) {
  // Admin only. This returns full phone numbers and S3 keys, which is the
  // whole reason the QA portal has its own search in app/api/qa/search.
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  const params = new URL(request.url).searchParams
  const page = Math.max(0, Number(params.get('page') ?? 0) || 0)
  const limit = 50

  try {
    const rows = await searchRecordings({
      q: params.get('q') || undefined,
      group: params.get('group') || undefined,
      dialer: params.get('dialer') || undefined,
      from: toUnix(params.get('from')),
      to: toUnix(params.get('to'), true),
      limit,
      offset: page * limit,
    })

    return NextResponse.json({ rows, page, hasMore: rows.length === limit })
  } catch (error) {
    console.error('search failed', error)
    return NextResponse.json({ error: 'Search failed' }, { status: 500 })
  }
}
