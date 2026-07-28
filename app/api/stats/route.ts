import { NextResponse } from 'next/server'
import { getStats } from '@/lib/db'

export async function GET() {
  try {
    const stats = await getStats()
    return NextResponse.json(stats)
  } catch (error) {
    console.error('stats failed', error)
    return NextResponse.json({ error: 'Could not load stats' }, { status: 500 })
  }
}
