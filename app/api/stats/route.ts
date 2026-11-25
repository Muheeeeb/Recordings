import { NextResponse } from 'next/server'
import { getStats } from '@/lib/db'
import { requireAdmin } from '@/lib/guard'

export async function GET() {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  try {
    const stats = await getStats()
    return NextResponse.json(stats)
  } catch (error) {
    console.error('stats failed', error)
    return NextResponse.json({ error: 'Could not load stats' }, { status: 500 })
  }
}
