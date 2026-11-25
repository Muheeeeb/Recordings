'use client'

/**
 * The QA portal.
 *
 * What is deliberately absent: there is no download button, no filename, and no
 * full phone number anywhere on this page — not hidden by CSS, not fetched and
 * then not rendered. The API this page talks to cannot return any of those
 * things (see lib/qa.ts), so the page cannot leak them by mistake.
 *
 * Audio plays from /api/qa/stream?s=<serial>. That is the whole URL a reviewer
 * can see in the network tab, which is the point: a presigned S3 link would
 * have carried the customer's number inside the key.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

type Row = {
  serial: number
  group: string
  agent: string | null
  recordedAt: number | null
  leadId: number | null
  phoneLast4: string | null
  sizeBytes: number | null
}

const serialLabel = (serial: number) => `PN-${String(serial).padStart(7, '0')}`

function formatTime(seconds: number | null) {
  if (!seconds) return '—'
  return new Date(seconds * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })
}

function formatSize(value: number | null) {
  if (!value) return '—'
  const mb = value / 1024 ** 2
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(value / 1024)} KB`
}

export default function QaPortal() {
  const router = useRouter()

  const [rows, setRows] = useState<Row[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const [group, setGroup] = useState('')
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState<number | null>(null)
  const [copied, setCopied] = useState<number | null>(null)

  const limit = 50

  const load = useCallback(
    async (opts: { append?: boolean; page?: number } = {}) => {
      const nextPage = opts.page ?? 0
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        if (q.trim()) params.set('q', q.trim())
        if (group) params.set('group', group)
        if (from) params.set('from', String(Math.floor(new Date(`${from}T00:00:00Z`).getTime() / 1000)))
        if (to) params.set('to', String(Math.floor(new Date(`${to}T23:59:59Z`).getTime() / 1000)))
        params.set('limit', String(limit))
        params.set('offset', String(nextPage * limit))

        const response = await fetch(`/api/qa/search?${params}`, { cache: 'no-store' })
        if (response.status === 401) {
          router.replace('/login')
          return
        }
        const body = await response.json()

        if (Array.isArray(body.groups)) setGroups(body.groups)
        if (!response.ok) {
          setError(body.error ?? 'Could not load recordings')
          if (!opts.append) setRows([])
          setHasMore(false)
          return
        }

        const incoming = (body.rows ?? []) as Row[]
        setRows((prev) => (opts.append ? [...prev, ...incoming] : incoming))
        setHasMore(incoming.length === limit)
        setPage(nextPage)
      } catch {
        setError('Could not reach the server')
      } finally {
        setLoading(false)
      }
    },
    [q, group, from, to, router]
  )

  // Only on mount: afterwards the filters are applied by the Search button, so
  // typing does not fire a request per keystroke.
  //
  // Deferred rather than called in the effect body because load() sets the
  // loading flag synchronously, and a synchronous setState inside an effect
  // causes the cascading render React now warns about.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function signOut() {
    await fetch('/api/login', { method: 'DELETE' })
    router.replace('/login')
  }

  async function copySerial(serial: number) {
    try {
      await navigator.clipboard.writeText(serialLabel(serial))
      setCopied(serial)
      setTimeout(() => setCopied((c) => (c === serial ? null : c)), 1500)
    } catch {
      // Clipboard access can be refused; the serial is on screen to type.
    }
  }

  const card = 'rounded-2xl border border-[var(--hairline)] bg-[var(--surface)]'
  const control =
    'rounded-lg border border-[var(--hairline)] bg-[var(--plane)] px-3 py-2 text-[var(--ink)] outline-none focus:border-[var(--series-1)]'

  return (
    <main className="min-h-screen bg-[var(--plane)]">
      <header className="border-b border-[var(--hairline)] bg-[var(--surface)]">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3.5">
          <div className="flex items-baseline gap-2.5">
            <h1 className="font-semibold text-[var(--ink)]">Recording Review</h1>
            <span className="text-[13px] text-[var(--muted)]">QA</span>
          </div>
          <button
            onClick={signOut}
            className="rounded-lg px-3 py-1.5 text-[13px] text-[var(--ink-2)] hover:bg-[var(--plane)]"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-5xl space-y-5 px-4 py-6">
        <p className="rounded-xl border border-[var(--hairline)] bg-[var(--surface)] px-4 py-3 text-[13px] text-[var(--muted)]">
          Customer numbers are masked to the last four digits. Refer to a call by its
          serial — for example <span className="font-mono text-[var(--ink-2)]">PN-0000123</span> —
          when writing it up. Playback is recorded against your account.
        </p>

        <section className={`${card} p-4`}>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <select
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              className={control}
            >
              <option value="">All my groups</option>
              {groups.map((g) => (
                <option key={g} value={g}>
                  {g.replace(/_/g, ' ')}
                </option>
              ))}
            </select>

            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className={control}
            />
            <span className="text-[var(--muted)]">to</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className={control}
            />
          </div>

          <div className="mt-3 flex gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void load()
              }}
              placeholder="Agent name, or a serial such as PN-0000123"
              className={`${control} flex-1`}
            />
            <button
              onClick={() => void load()}
              className="rounded-lg bg-[var(--ink)] px-5 py-2 font-medium text-[var(--surface)] hover:opacity-90"
            >
              Search
            </button>
          </div>
        </section>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}

        <section className={`${card} overflow-hidden`}>
          {rows.length === 0 && !loading && !error && (
            <p className="px-4 py-14 text-center text-sm text-[var(--muted)]">
              No recordings match those filters.
            </p>
          )}

          {rows.map((row) => (
            <div key={row.serial} className="border-b border-[var(--hairline)] last:border-0">
              <div className="flex items-center gap-3 px-4 py-3">
                <button
                  onClick={() => setPlaying((cur) => (cur === row.serial ? null : row.serial))}
                  aria-label={playing === row.serial ? 'Stop' : 'Play'}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] text-white transition-opacity hover:opacity-85"
                  style={{ background: 'var(--series-1)' }}
                >
                  {playing === row.serial ? '■' : '▶'}
                </button>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void copySerial(row.serial)}
                      title="Copy serial"
                      className="font-mono text-[15px] font-medium text-[var(--ink)] hover:text-[var(--series-1)]"
                    >
                      {serialLabel(row.serial)}
                    </button>
                    {copied === row.serial && (
                      <span className="text-[12px] text-[var(--series-1)]">copied</span>
                    )}
                    <span className="text-[13px] tabular-nums text-[var(--muted)]">
                      ···· {row.phoneLast4 ?? '????'}
                    </span>
                  </div>
                  <div className="truncate text-[13px] text-[var(--muted)]">
                    {row.agent ?? 'no agent'} · {row.group.replace(/_/g, ' ')} ·{' '}
                    {formatTime(row.recordedAt)} · {formatSize(row.sizeBytes)}
                  </div>
                </div>
              </div>

              {playing === row.serial && (
                <div className="px-4 pb-3">
                  <audio
                    src={`/api/qa/stream?s=${serialLabel(row.serial)}`}
                    controls
                    autoPlay
                    // Hides the browser's own download item. It is a courtesy,
                    // not a control: the real protection is that this URL
                    // contains no number and every fetch of it is logged.
                    controlsList="nodownload"
                    onContextMenu={(e) => e.preventDefault()}
                    className="w-full"
                  />
                </div>
              )}
            </div>
          ))}
        </section>

        {hasMore && (
          <button
            onClick={() => void load({ append: true, page: page + 1 })}
            disabled={loading}
            className="mx-auto block rounded-lg border border-[var(--hairline)] bg-[var(--surface)] px-5 py-2 text-sm text-[var(--ink-2)] hover:opacity-90 disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </main>
  )
}
