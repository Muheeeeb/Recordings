import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/guard'
import { getIndexFreshness } from '@/lib/db'

/**
 * Starts and reports on an index sync.
 *
 * The work itself runs in GitHub Actions rather than here: a full pass takes
 * several minutes and a serverless function is capped at a fraction of that.
 * This endpoint starts that workflow and reports its progress, so the button
 * in the UI reflects a real run instead of firing and hoping.
 */

const REPO = process.env.GITHUB_REPO ?? 'Muheeeeb/Recordings'
const WORKFLOW = 'sync-index.yml'
const API = 'https://api.github.com'

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  }
}

/**
 * Admin only: this triggers the indexer workflow, which is not something a
 * reviewer should be able to start.
 */
async function requireSession() {
  const guard = await requireAdmin()
  return guard.ok ? guard.username : null
}

type Run = {
  status: string
  conclusion: string | null
  created_at: string
  html_url: string
}

async function latestRun(token: string): Promise<Run | null> {
  const response = await fetch(
    `${API}/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`,
    { headers: headers(token), cache: 'no-store' }
  )
  if (!response.ok) return null
  const body = (await response.json()) as { workflow_runs?: Run[] }
  return body.workflow_runs?.[0] ?? null
}

export async function GET() {
  if (!(await requireSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const token = process.env.GITHUB_TOKEN
  const lastIndexed = await getIndexFreshness()

  if (!token) {
    // Without a token the schedule still runs; only the button is unavailable.
    return NextResponse.json({ lastIndexed, canTrigger: false, run: null })
  }

  const run = await latestRun(token)
  return NextResponse.json({
    lastIndexed,
    canTrigger: true,
    run: run
      ? {
          status: run.status,
          conclusion: run.conclusion,
          startedAt: run.created_at,
          url: run.html_url,
          running: run.status !== 'completed',
        }
      : null,
  })
}

export async function POST() {
  if (!(await requireSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const token = process.env.GITHUB_TOKEN
  if (!token) {
    return NextResponse.json(
      { error: 'Syncing from here needs GITHUB_TOKEN to be configured' },
      { status: 501 }
    )
  }

  // Starting a second run while one is in flight would just queue behind it.
  const existing = await latestRun(token)
  if (existing && existing.status !== 'completed') {
    return NextResponse.json({ ok: true, alreadyRunning: true, url: existing.html_url })
  }

  const response = await fetch(
    `${API}/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ ref: 'main', inputs: { full: 'false' } }),
    }
  )

  if (!response.ok) {
    const detail = await response.text()
    console.error('workflow dispatch failed', response.status, detail)
    return NextResponse.json(
      { error: 'Could not start the sync. Check that GITHUB_TOKEN allows actions:write.' },
      { status: 502 }
    )
  }

  return NextResponse.json({ ok: true, alreadyRunning: false })
}
