'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DayChart, StatTile, bytes, compact, formatDay } from '@/components/charts'
import { DialerBreakdown } from '@/components/dialer-breakdown'
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

type StatCell = {
  day: number
  group: string
  dialer: string
  count: number
  bytes: number
}
type Stats = {
  cells: StatCell[]
  perAgent: { name: string; count: number }[]
}

/** YYYY-MM-DD from a date input to the YYYYMMDD integer the grid is keyed by. */
function toDayNumber(value: string): number | null {
  if (!value) return null
  const n = Number(value.replace(/-/g, ''))
  return Number.isFinite(n) ? n : null
}

/** YYYYMMDD back to the YYYY-MM-DD a date input expects. */
function toDateInput(day: number): string {
  const s = String(day)
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

/** Shifts a YYYYMMDD day by a number of days, via a real date so months wrap. */
function shiftDay(day: number, delta: number): number {
  const d = new Date(`${toDateInput(day)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return Number(d.toISOString().slice(0, 10).replace(/-/g, ''))
}

/**
 * Everything on the dashboard comes from the day/group/dialer grid, so applying
 * a date range, a dialer or a group is a filter over a few dozen rows rather
 * than another trip to the database.
 */
function summarise(
  cells: StatCell[],
  dialer: string,
  group: string,
  from: string,
  to: string
) {
  const lo = toDayNumber(from)
  const hi = toDayNumber(to)
  const matching = cells.filter(
    (c) =>
      (!dialer || c.dialer === dialer) &&
      (!group || c.group === group) &&
      (lo === null || c.day >= lo) &&
      (hi === null || c.day <= hi)
  )

  const byDay = new Map<number, { count: number; bytes: number }>()
  const byGroup = new Map<string, { count: number; bytes: number }>()
  const byDialer = new Map<string, { count: number; bytes: number }>()
  let total = 0
  let bytes = 0

  const bump = (
    map: Map<string | number, { count: number; bytes: number }>,
    key: string | number,
    cell: StatCell
  ) => {
    const entry = map.get(key) ?? { count: 0, bytes: 0 }
    entry.count += cell.count
    entry.bytes += cell.bytes
    map.set(key, entry)
  }

  for (const cell of matching) {
    total += cell.count
    bytes += cell.bytes
    bump(byDay as never, cell.day, cell)
    bump(byGroup as never, cell.group, cell)
    bump(byDialer as never, cell.dialer, cell)
  }

  const perDay = [...byDay.entries()]
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => a.day - b.day)
  const rank = (m: Map<string, { count: number; bytes: number }>) =>
    [...m.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count)

  return {
    total,
    bytes,
    perDay,
    perGroup: rank(byGroup),
    perDialer: rank(byDialer),
    days: perDay.length,
    firstDay: perDay[0]?.day ?? null,
    lastDay: perDay[perDay.length - 1]?.day ?? null,
    busiest: perDay.reduce<{ day: number; count: number } | null>(
      (best, d) => (!best || d.count > best.count ? d : best),
      null
    ),
  }
}

/**
 * Dialers and folders both come from the data rather than a fixed list: the KTN
 * and Rockey folders appeared in the bucket on their own, and a hardcoded list
 * would have hidden them.
 */
function dialersIn(cells: StatCell[]): string[] {
  const order = ['CCS', 'KTN', 'Rockey']
  const present = [...new Set(cells.map((c) => c.dialer))]
  return [
    ...order.filter((d) => present.includes(d)),
    ...present.filter((d) => !order.includes(d)).sort(),
  ]
}

function groupsIn(cells: StatCell[], dialer: string): string[] {
  return [
    ...new Set(cells.filter((c) => !dialer || c.dialer === dialer).map((c) => c.group)),
  ].sort()
}

/** Default window: the most recent month of data that actually exists. */
const DEFAULT_WINDOW_DAYS = 30

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
  const [dialer, setDialer] = useState('')
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
      dialer: string
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
        if (opts.dialer) params.set('dialer', opts.dialer)
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
      void runSearch({ q, dialer, group, from, to, page: 0, append: false })
    }, 150)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialer, group, from, to])

  const loadStats = useCallback(() => {
    fetch('/api/stats')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => s && setStats(s))
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  // The bucket now holds months of recordings, so showing everything by default
  // buries the current picture. The window is anchored to the newest day that
  // actually has data rather than to today, because uploads arrive a day or two
  // late and anchoring on today would open on a partly empty range.
  const defaultsApplied = useRef(false)
  useEffect(() => {
    if (defaultsApplied.current || !stats || stats.cells.length === 0) return
    defaultsApplied.current = true
    const newest = Math.max(...stats.cells.map((c) => c.day))
    setFrom(toDateInput(shiftDay(newest, -(DEFAULT_WINDOW_DAYS - 1))))
    setTo(toDateInput(newest))
  }, [stats])

  // Called when a sync finishes, so the dashboard and results pick up the new
  // recordings without a manual reload.
  const afterSync = useCallback(() => {
    loadStats()
    void runSearch({ q, dialer, group, from, to, page: 0, append: false })
  }, [loadStats, runSearch, q, dialer, group, from, to])

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

  // Recomputed as the filters change; the grid it reads is only a few dozen
  // rows, so this is cheaper than asking the server again.
  const view = stats ? summarise(stats.cells, dialer, group, from, to) : null
  const availableDialers = stats ? dialersIn(stats.cells) : []
  const availableGroups = stats ? groupsIn(stats.cells, dialer) : []
  const groupDialerOf = (name: string) =>
    stats?.cells.find((c) => c.group === name)?.dialer ?? ''
  const newestDay = stats && stats.cells.length
    ? Math.max(...stats.cells.map((c) => c.day))
    : null

  /** Range presets are anchored to the newest day with data, not to today. */
  function applyRange(days: number | null) {
    if (days === null || newestDay === null) {
      setFrom('')
      setTo('')
      return
    }
    setFrom(toDateInput(shiftDay(newestDay, -(days - 1))))
    setTo(toDateInput(newestDay))
  }

  const activeRangeDays =
    newestDay && to === toDateInput(newestDay) && from
      ? Math.round(
          (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000
        ) + 1
      : null

  const range =
    view?.firstDay && view?.lastDay
      ? view.firstDay === view.lastDay
        ? formatDay(view.firstDay)
        : `${formatDay(view.firstDay)} – ${formatDay(view.lastDay)}`
      : undefined

  const filtered = Boolean(dialer || group || from || to)

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
        {/* Filters — placed above everything they control ---------------- */}
        <section className={`${card} p-4`}>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <select
              value={dialer}
              onChange={(e) => {
                setDialer(e.target.value)
                // The chosen folder may not belong to the new dialer, which
                // would silently return nothing.
                setGroup('')
              }}
              className={control}
            >
              <option value="">All dialers</option>
              {availableDialers.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>

            <select value={group} onChange={(e) => setGroup(e.target.value)} className={control}>
              <option value="">{dialer ? `All ${dialer} folders` : 'All folders'}</option>
              {availableGroups.map((g) => (
                <option key={g} value={g}>{g.replace(/_/g, ' ')}</option>
              ))}
            </select>

            <span className="mx-1 h-5 w-px bg-[var(--hairline)]" />

            <div className="flex overflow-hidden rounded-lg border border-[var(--hairline)]">
              {[
                { label: '7 days', days: 7 },
                { label: '30 days', days: 30 },
                { label: 'All', days: null },
              ].map((preset) => {
                const on =
                  preset.days === null ? !from && !to : activeRangeDays === preset.days
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => applyRange(preset.days)}
                    className={`px-3 py-1.5 ${
                      on
                        ? 'bg-[var(--ink)] text-[var(--surface)]'
                        : 'text-[var(--ink-2)] hover:bg-[var(--plane)]'
                    }`}
                  >
                    {preset.label}
                  </button>
                )
              })}
            </div>

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

            {filtered && (
              <button
                type="button"
                onClick={() => {
                  setQ('')
                  setDialer('')
                  setGroup('')
                  applyRange(DEFAULT_WINDOW_DAYS)
                }}
                className="text-[var(--muted)] hover:text-[var(--ink)]"
              >
                Reset
              </button>
            )}

            <span className="ml-auto text-[var(--muted)]">
              {dialer || 'All dialers'}
              {group ? ` · ${group.replace(/_/g, ' ')}` : ''}
              {range ? ` · ${range}` : ''}
            </span>
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Recordings"
            value={view ? view.total.toLocaleString() : '—'}
            sub={range}
            hero
          />
          <StatTile
            label="Storage"
            value={view ? bytes(view.bytes) : '—'}
            sub={
              view && view.total
                ? `${Math.round(view.bytes / view.total / 1024)} KB average`
                : undefined
            }
          />
          <StatTile
            label="Busiest day"
            value={view?.busiest ? compact(view.busiest.count) : '—'}
            sub={view?.busiest ? formatDay(view.busiest.day) : undefined}
          />
          <StatTile
            label="Daily average"
            value={view && view.days ? compact(Math.round(view.total / view.days)) : '—'}
            sub={view ? `across ${view.days} day${view.days === 1 ? '' : 's'}` : undefined}
          />
        </section>

        <section className="grid gap-5 lg:grid-cols-3">
          <div className={`${card} p-5 lg:col-span-2`}>
            <h2 className="text-[15px] font-semibold text-[var(--ink)]">Recordings per day</h2>
            <p className="mb-5 text-[13px] text-[var(--muted)]">
              {group ? group.replace(/_/g, ' ') : dialer || 'All dialers'} · click a bar to filter
            </p>
            <DayChart
              data={view?.perDay ?? []}
              selected={from && from === to ? toDayNumber(from) : null}
              onSelect={(day) => {
                const iso = toDateInput(day)
                // Deselecting a day returns to the default window rather than
                // to all-time: dropping someone into every day on record is a
                // jarring place to land from a single-day view.
                if (from === iso && to === iso) {
                  applyRange(DEFAULT_WINDOW_DAYS)
                } else {
                  setFrom(iso)
                  setTo(iso)
                }
              }}
            />
          </div>

          <div className={`${card} p-5`}>
            <h2 className="text-[15px] font-semibold text-[var(--ink)]">Dialers</h2>
            <p className="mb-5 text-[13px] text-[var(--muted)]">
              {range ?? 'All dates'} · click to filter
            </p>
            <DialerBreakdown
              dialers={view?.perDialer ?? []}
              groups={view?.perGroup ?? []}
              groupDialer={groupDialerOf}
              activeDialer={dialer}
              activeGroup={group}
              onPickDialer={(d) => {
                setDialer(d)
                setGroup('')
              }}
              onPickGroup={setGroup}
            />
          </div>
        </section>

        {/* Search --------------------------------------------------------- */}
        <section className={`${card} p-4`}>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void runSearch({ q, dialer, group, from, to, page: 0, append: false })
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
            onClick={() => runSearch({ q, dialer, group, from, to, page: page + 1, append: true })}
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
