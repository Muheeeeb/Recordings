'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DayChart, GroupChart, StatTile, bytes, compact, formatDay } from '@/components/charts'
import { SettingsDialog } from '@/components/settings-dialog'
import { SyncButton } from '@/components/sync-button'

type Row = {
  key: string
  group_name: string | null
  recorded_at: number | null
  lead_id: number | null
  phone: number | null
  agent: string | null
  size_bytes: number | null
}

type Stats = {
  total: number
  bytes: number
  days: number
  agents: number
  firstDay: number | null
  lastDay: number | null
  perDay: { day: number; count: number; bytes: number }[]
  perGroup: { name: string; count: number; bytes: number }[]
  perAgent: { name: string; count: number }[]
}

const GROUPS = [
  'Closers_ACA',
  'Closers_Medicare',
  'Main_ACA_Fronter',
  'Main_Medicare_Fronter',
]

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

function formatPhone(value: number | null) {
  if (!value) return null
  const digits = String(value)
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  return digits
}

export default function SearchPage() {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [group, setGroup] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const [stats, setStats] = useState<Stats | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [playing, setPlaying] = useState<string | null>(null)
  const [playUrl, setPlayUrl] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  /**
   * Takes its filters as arguments rather than reading state, so the effect
   * below can depend on the filter values alone — closing over state would
   * make the callback identity change on every keystroke and re-fire it.
   */
  const runSearch = useCallback(
    async (opts: {
      q: string
      group: string
      from: string
      to: string
      page: number
      append: boolean
    }) => {
      setLoading(true)
      setError(null)

      try {
        // Built inside the try so a malformed call cannot escape as an
        // unhandled rejection and strand the loading flag.
        const params = new URLSearchParams()
        const term = (opts.q ?? '').trim()
        if (term) params.set('q', term)
        if (opts.group) params.set('group', opts.group)
        if (opts.from) params.set('from', opts.from)
        if (opts.to) params.set('to', opts.to)
        params.set('page', String(opts.page ?? 0))

        const response = await fetch(`/api/search?${params}`)
        if (response.status === 401) {
          router.replace('/login')
          return
        }
        if (!response.ok) throw new Error('failed')
        const body = await response.json()
        setRows((prev) => (opts.append ? [...prev, ...body.rows] : body.rows))
        setHasMore(body.hasMore)
        setPage(body.page)
      } catch {
        setError('Search failed — please try again')
      } finally {
        setLoading(false)
      }
    },
    [router]
  )

  // Runs on first load and whenever a filter changes. The text query is not a
  // dependency: that one is submitted explicitly so it does not fire per key.
  //
  // The search is deferred rather than called in the effect body: a date input
  // emits a change per edited digit, so this coalesces the partial values into
  // one request — and keeps the effect free of a synchronous setState.
  useEffect(() => {
    const timer = setTimeout(() => {
      void runSearch({ q, group, from, to, page: 0, append: false })
    }, 150)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, from, to])

  const loadStats = useCallback(() => {
    fetch('/api/stats')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => s && setStats(s))
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  // Called when a sync finishes, so the dashboard and results pick up the new
  // recordings without a manual reload.
  const afterSync = useCallback(() => {
    loadStats()
    void runSearch({ q, group, from, to, page: 0, append: false })
  }, [loadStats, runSearch, q, group, from, to])

  async function play(key: string) {
    if (playing === key) {
      setPlaying(null)
      setPlayUrl(null)
      return
    }
    setPlaying(key)
    setPlayUrl(null)
    const response = await fetch(`/api/play?key=${encodeURIComponent(key)}`)
    if (!response.ok) {
      setError('Could not load that recording')
      setPlaying(null)
      return
    }
    setPlayUrl((await response.json()).url)
  }

  async function download(key: string) {
    const response = await fetch(`/api/play?key=${encodeURIComponent(key)}&download=1`)
    if (!response.ok) return
    window.location.href = (await response.json()).url
  }

  async function signOut() {
    await fetch('/api/login', { method: 'DELETE' })
    router.replace('/login')
  }

  const card = 'rounded-2xl border border-[var(--hairline)] bg-[var(--surface)]'
  const control =
    'rounded-lg border border-[var(--hairline)] bg-[var(--plane)] px-3 py-2 text-[var(--ink)] outline-none focus:border-[var(--series-1)]'

  const range =
    stats?.firstDay && stats?.lastDay
      ? `${formatDay(stats.firstDay)} – ${formatDay(stats.lastDay)}`
      : undefined

  return (
    <main className="min-h-screen bg-[var(--plane)]">
      <header className="border-b border-[var(--hairline)] bg-[var(--surface)]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3.5">
          <div className="flex items-baseline gap-2.5">
            <h1 className="font-semibold text-[var(--ink)]">Call Recordings</h1>
            <span className="text-[13px] text-[var(--muted)]">poshnee</span>
          </div>
          <div className="flex items-center gap-1">
            <SyncButton onFinished={afterSync} />
            <button
              onClick={() => setShowSettings(true)}
              className="rounded-lg px-3 py-1.5 text-[13px] text-[var(--ink-2)] hover:bg-[var(--plane)]"
            >
              Settings
            </button>
            <button
              onClick={signOut}
              className="rounded-lg px-3 py-1.5 text-[13px] text-[var(--ink-2)] hover:bg-[var(--plane)]"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-5 px-4 py-6">
        {/* Dashboard ------------------------------------------------------ */}
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Total recordings"
            value={stats ? stats.total.toLocaleString() : '—'}
            sub={range}
            hero
          />
          <StatTile
            label="Storage used"
            value={stats ? bytes(stats.bytes) : '—'}
            sub={stats && stats.total ? `${Math.round(stats.bytes / stats.total / 1024)} KB average` : undefined}
          />
          <StatTile
            label="Busiest day"
            value={
              stats && stats.perDay.length
                ? compact(Math.max(...stats.perDay.map((d) => d.count)))
                : '—'
            }
            sub={
              stats && stats.perDay.length
                ? formatDay(stats.perDay.reduce((a, b) => (b.count > a.count ? b : a)).day)
                : undefined
            }
          />
          <StatTile
            label="Daily average"
            value={stats && stats.days ? compact(Math.round(stats.total / stats.days)) : '—'}
            sub={stats ? `across ${stats.days} days` : undefined}
          />
        </section>

        <section className="grid gap-5 lg:grid-cols-3">
          <div className={`${card} p-5 lg:col-span-2`}>
            <h2 className="text-[15px] font-semibold text-[var(--ink)]">Recordings per day</h2>
            <p className="mb-5 text-[13px] text-[var(--muted)]">By call date</p>
            <DayChart data={stats?.perDay ?? []} />
          </div>

          <div className={`${card} p-5`}>
            <h2 className="text-[15px] font-semibold text-[var(--ink)]">By group</h2>
            <p className="mb-5 text-[13px] text-[var(--muted)]">Recording count</p>
            <GroupChart data={stats?.perGroup ?? []} />
          </div>
        </section>

        {/* Search --------------------------------------------------------- */}
        <section className={`${card} p-4`}>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void runSearch({ q, group, from, to, page: 0, append: false })
            }}
          >
            <div className="flex gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Enter a full lead ID or phone number, or an agent name…"
                className={`${control} flex-1`}
              />
              <button
                type="submit"
                className="rounded-lg bg-[var(--ink)] px-5 py-2 font-medium text-[var(--surface)] hover:opacity-90"
              >
                Search
              </button>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
              <select
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                className={control}
              >
                <option value="">All groups</option>
                {GROUPS.map((g) => (
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
              <button
                type="button"
                onClick={() => {
                  setQ('')
                  setGroup('')
                  setFrom('')
                  setTo('')
                  // Clearing only the text box would not change any effect
                  // dependency, so search again explicitly.
                  void runSearch({ q: '', group: '', from: '', to: '', page: 0, append: false })
                }}
                className="text-[var(--muted)] hover:text-[var(--ink)]"
              >
                Clear
              </button>
            </div>
          </form>
        </section>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}

        <section className={`${card} overflow-hidden`}>
          {rows.length === 0 && !loading && (
            <p className="px-4 py-14 text-center text-sm text-[var(--muted)]">
              No recordings match those filters.
            </p>
          )}

          {rows.map((row) => (
            <div
              key={row.key}
              className="border-b border-[var(--hairline)] last:border-0"
            >
              <div className="flex items-center gap-3 px-4 py-3">
                <button
                  onClick={() => play(row.key)}
                  aria-label={playing === row.key ? 'Stop' : 'Play'}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] text-white transition-opacity hover:opacity-85"
                  style={{ background: 'var(--series-1)' }}
                >
                  {playing === row.key ? '■' : '▶'}
                </button>

                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-medium tabular-nums text-[var(--ink)]">
                    {formatPhone(row.phone) ?? row.lead_id ?? '—'}
                    <span className="ml-2 text-[13px] font-normal text-[var(--muted)]">
                      {row.agent} · {row.group_name?.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <div className="text-[13px] text-[var(--muted)]">
                    {formatTime(row.recorded_at)} ·{' '}
                    {row.size_bytes ? bytes(row.size_bytes) : '—'}
                    {row.phone && row.lead_id ? ` · lead ${row.lead_id}` : ''}
                  </div>
                </div>

                <button
                  onClick={() => download(row.key)}
                  className="shrink-0 rounded-lg border border-[var(--hairline)] px-3 py-1.5 text-[13px] text-[var(--ink-2)] hover:bg-[var(--plane)]"
                >
                  Download
                </button>
              </div>

              {playing === row.key && (
                <div className="px-4 pb-3">
                  {playUrl ? (
                    <audio src={playUrl} controls autoPlay className="w-full" />
                  ) : (
                    <p className="py-2 text-[13px] text-[var(--muted)]">Loading audio…</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </section>

        {hasMore && (
          <button
            onClick={() => runSearch({ q, group, from, to, page: page + 1, append: true })}
            disabled={loading}
            className="mx-auto block rounded-lg border border-[var(--hairline)] bg-[var(--surface)] px-5 py-2 text-sm text-[var(--ink-2)] hover:opacity-90 disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>

      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
    </main>
  )
}
