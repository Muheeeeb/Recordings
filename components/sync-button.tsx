'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

type SyncState = {
  lastIndexed: number | null
  canTrigger: boolean
  run: { status: string; conclusion: string | null; url: string; running: boolean } | null
}

function ago(seconds: number | null): string {
  if (!seconds) return 'never'
  const mins = Math.floor((Date.now() / 1000 - seconds) / 60)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function SyncButton({ onFinished }: { onFinished: () => void }) {
  const [state, setState] = useState<SyncState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wasRunning = useRef(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/sync')
      if (!response.ok) return
      const body: SyncState = await response.json()
      setState(body)

      // Refresh the dashboard once the run that was in flight finishes.
      if (wasRunning.current && !body.run?.running) {
        wasRunning.current = false
        onFinished()
      }
      if (body.run?.running) wasRunning.current = true
    } catch {
      // A failed poll is not worth surfacing; the next one will try again.
    }
  }, [onFinished])

  // Deferred so the first fetch does not set state inside the effect body.
  useEffect(() => {
    const timer = setTimeout(load, 0)
    return () => clearTimeout(timer)
  }, [load])

  // Poll only while a run is in flight, so an idle page makes no requests.
  useEffect(() => {
    if (!state?.run?.running) return
    const timer = setInterval(load, 10_000)
    return () => clearInterval(timer)
  }, [state?.run?.running, load])

  async function start() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/sync', { method: 'POST' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(body.error ?? 'Could not start the sync')
      } else {
        wasRunning.current = true
        await load()
      }
    } catch {
      setError('Network error — please try again')
    } finally {
      setBusy(false)
    }
  }

  const running = state?.run?.running ?? false

  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-[13px] text-[var(--muted)] sm:inline">
        {running ? 'Syncing…' : `Updated ${ago(state?.lastIndexed ?? null)}`}
      </span>
      <button
        onClick={start}
        disabled={busy || running || state?.canTrigger === false}
        title={
          state?.canTrigger === false
            ? 'Set GITHUB_TOKEN to enable syncing from here'
            : 'Fetch new recordings from S3'
        }
        className="rounded-lg border border-[var(--hairline)] px-3 py-1.5 text-[13px] text-[var(--ink-2)] hover:bg-[var(--plane)] disabled:opacity-50"
      >
        {running ? '⟳ Syncing' : 'Sync now'}
      </button>
      {error && <span className="text-[12px] text-red-600 dark:text-red-400">{error}</span>}
    </div>
  )
}
