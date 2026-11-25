'use client'

/**
 * Admin: the activity log, and the accounts that produce it.
 *
 * Two tabs rather than two pages, because the questions run together — you look
 * at what somebody did, then at what they are allowed to do.
 *
 * The serial in a log row is clickable: it resolves to the real recording,
 * number and all. That resolution is itself logged as `admin_lookup`, so the
 * audit trail covers the people reading the audit trail.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

type ActivityRow = {
  id: number
  ts: number
  username: string
  role: string | null
  action: string
  serial: number | null
  detail: string | null
  ip: string | null
}

type UserRow = {
  username: string
  role: 'admin' | 'qa'
  disabled: boolean
  updatedAt: number | null
  groups: string[]
}

type Lookup = {
  serial: number
  url: string
  details: {
    phone: string | null
    agent: string | null
    recordedAt: string | null
    leadId: string | null
    group: string | null
  } | null
}

const serialLabel = (serial: number) => `PN-${String(serial).padStart(7, '0')}`

const when = (seconds: number | null) =>
  seconds
    ? new Date(seconds * 1000).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—'

const ACTIONS = [
  'login',
  'login_failed',
  'logout',
  'search',
  'play',
  'download',
  'denied',
  'admin_lookup',
  'user_created',
  'user_changed',
]

const card = 'rounded-2xl border border-[var(--hairline)] bg-[var(--surface)]'
const control =
  'rounded-lg border border-[var(--hairline)] bg-[var(--plane)] px-3 py-2 text-[var(--ink)] outline-none focus:border-[var(--series-1)]'

export default function AdminPage() {
  const router = useRouter()
  const [tab, setTab] = useState<'activity' | 'accounts'>('activity')

  return (
    <main className="min-h-screen bg-[var(--plane)]">
      <header className="border-b border-[var(--hairline)] bg-[var(--surface)]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3.5">
          <div className="flex items-baseline gap-2.5">
            <h1 className="font-semibold text-[var(--ink)]">Admin</h1>
            <span className="text-[13px] text-[var(--muted)]">poshnee</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => router.push('/')}
              className="rounded-lg px-3 py-1.5 text-[13px] text-[var(--ink-2)] hover:bg-[var(--plane)]"
            >
              Dashboard
            </button>
            <button
              onClick={() => router.push('/qa')}
              className="rounded-lg px-3 py-1.5 text-[13px] text-[var(--ink-2)] hover:bg-[var(--plane)]"
              title="See the portal as a reviewer sees it"
            >
              QA portal
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-5 px-4 py-6">
        <div className="flex w-fit overflow-hidden rounded-lg border border-[var(--hairline)] text-[13px]">
          {(['activity', 'accounts'] as const).map((name) => (
            <button
              key={name}
              onClick={() => setTab(name)}
              className={`px-4 py-1.5 capitalize ${
                tab === name
                  ? 'bg-[var(--ink)] text-[var(--surface)]'
                  : 'bg-[var(--surface)] text-[var(--ink-2)] hover:bg-[var(--plane)]'
              }`}
            >
              {name}
            </button>
          ))}
        </div>

        {tab === 'activity' ? <ActivityTab /> : <AccountsTab />}
      </div>
    </main>
  )
}

/* -------------------------------------------------------------------- activity */

function ActivityTab() {
  const [rows, setRows] = useState<ActivityRow[]>([])
  const [summary, setSummary] = useState<{ username: string; action: string; n: number }[]>([])
  const [user, setUser] = useState('')
  const [action, setAction] = useState('')
  const [serial, setSerial] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lookup, setLookup] = useState<Lookup | null>(null)

  const load = useCallback(
    async (opts: { page?: number; append?: boolean } = {}) => {
      const next = opts.page ?? 0
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        if (user.trim()) params.set('user', user.trim())
        if (action) params.set('action', action)
        if (serial.trim()) params.set('serial', serial.trim())
        if (from) params.set('from', from)
        if (to) params.set('to', to)
        params.set('page', String(next))

        const response = await fetch(`/api/activity?${params}`, { cache: 'no-store' })
        const body = await response.json()
        if (!response.ok) {
          setError(body.error ?? 'Could not load the log')
          return
        }
        setRows((prev) => (opts.append ? [...prev, ...body.rows] : body.rows))
        setSummary(body.summary ?? [])
        setHasMore(Boolean(body.hasMore))
        setPage(next)
      } catch {
        setError('Could not reach the server')
      } finally {
        setLoading(false)
      }
    },
    [user, action, serial, from, to]
  )

  // Deferred rather than called in the effect body: load() sets the loading
  // flag synchronously, and a synchronous setState inside an effect is the
  // cascading render React warns about.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function openSerial(value: number) {
    setLookup(null)
    const response = await fetch(`/api/play?serial=${serialLabel(value)}`, { cache: 'no-store' })
    const body = await response.json()
    if (response.ok) setLookup({ serial: value, url: body.url, details: body.details })
    else setError(body.error ?? 'Could not open that recording')
  }

  const plays = summary.filter((s) => s.action === 'play')

  return (
    <>
      {plays.length > 0 && (
        <section className={`${card} p-4`}>
          <h2 className="text-[15px] font-semibold text-[var(--ink)]">
            Recordings played in this window
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {plays.map((s) => (
              <span
                key={s.username}
                className="rounded-lg border border-[var(--hairline)] bg-[var(--plane)] px-3 py-1.5 text-[13px] text-[var(--ink-2)]"
              >
                {s.username} <span className="font-medium text-[var(--ink)]">{s.n}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      <section className={`${card} p-4`}>
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <input
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="user"
            className={control}
          />
          <select value={action} onChange={(e) => setAction(e.target.value)} className={control}>
            <option value="">All actions</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <input
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            placeholder="PN-0000123"
            className={control}
          />
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={control} />
          <span className="text-[var(--muted)]">to</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={control} />
          <button
            onClick={() => void load()}
            className="rounded-lg bg-[var(--ink)] px-4 py-2 font-medium text-[var(--surface)] hover:opacity-90"
          >
            Apply
          </button>
        </div>
      </section>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      {lookup && (
        <section className={`${card} p-4`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-mono text-[15px] font-semibold text-[var(--ink)]">
                {serialLabel(lookup.serial)}
              </h2>
              <p className="mt-1 text-[13px] text-[var(--muted)]">
                {lookup.details?.phone ?? 'no number'} · {lookup.details?.agent ?? 'no agent'} ·{' '}
                {lookup.details?.group?.replace(/_/g, ' ') ?? '—'} ·{' '}
                {lookup.details?.recordedAt ?? '—'}
              </p>
            </div>
            <button
              onClick={() => setLookup(null)}
              className="text-[13px] text-[var(--muted)] hover:text-[var(--ink)]"
            >
              Close
            </button>
          </div>
          <audio src={lookup.url} controls autoPlay className="mt-3 w-full" />
        </section>
      )}

      <section className={`${card} overflow-hidden`}>
        {rows.length === 0 && !loading && (
          <p className="px-4 py-14 text-center text-sm text-[var(--muted)]">Nothing logged yet.</p>
        )}
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--hairline)] px-4 py-2.5 text-[13px] last:border-0"
          >
            <span className="w-36 shrink-0 tabular-nums text-[var(--muted)]">{when(row.ts)}</span>
            <span className="w-52 shrink-0 truncate text-[var(--ink)]">{row.username}</span>
            <span
              className={`w-24 shrink-0 ${
                row.action === 'denied' || row.action === 'login_failed'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-[var(--ink-2)]'
              }`}
            >
              {row.action}
            </span>
            <span className="w-28 shrink-0 font-mono">
              {row.serial !== null ? (
                <button
                  onClick={() => void openSerial(row.serial!)}
                  className="text-[var(--series-1)] hover:underline"
                  title="Open the real recording"
                >
                  {serialLabel(row.serial)}
                </button>
              ) : (
                <span className="text-[var(--muted)]">—</span>
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-[var(--muted)]">{row.detail ?? ''}</span>
            <span className="shrink-0 tabular-nums text-[var(--muted)]">{row.ip ?? ''}</span>
          </div>
        ))}
      </section>

      {hasMore && (
        <button
          onClick={() => void load({ page: page + 1, append: true })}
          disabled={loading}
          className="mx-auto block rounded-lg border border-[var(--hairline)] bg-[var(--surface)] px-5 py-2 text-sm text-[var(--ink-2)] hover:opacity-90 disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </>
  )
}

/* -------------------------------------------------------------------- accounts */

function AccountsTab() {
  const [users, setUsers] = useState<UserRow[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const [you, setYou] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [newUser, setNewUser] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newGroups, setNewGroups] = useState<string[]>([])

  const load = useCallback(async () => {
    const response = await fetch('/api/users', { cache: 'no-store' })
    const body = await response.json()
    if (!response.ok) {
      setError(body.error ?? 'Could not load accounts')
      return
    }
    setUsers(body.users)
    setGroups(body.groups)
    setYou(body.you)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0)
    return () => clearTimeout(timer)
  }, [load])

  async function send(method: 'POST' | 'PATCH', payload: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const response = await fetch('/api/users', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json()
      if (!response.ok) {
        setError(body.error ?? 'That did not work')
        return false
      }
      setNote(
        method === 'POST'
          ? `Created ${payload.username}`
          : `Saved: ${(body.changes ?? []).join('; ') || 'no change'}`
      )
      await load()
      return true
    } catch {
      setError('Could not reach the server')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function create() {
    const ok = await send('POST', {
      username: newUser,
      password: newPassword,
      role: 'qa',
      groups: newGroups,
    })
    if (ok) {
      setNewUser('')
      setNewPassword('')
      setNewGroups([])
    }
  }

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value]

  return (
    <>
      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}
      {note && (
        <p className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink-2)]">
          {note}
        </p>
      )}

      <section className={`${card} p-4`}>
        <h2 className="text-[15px] font-semibold text-[var(--ink)]">Add a QA associate</h2>
        <p className="mb-3 text-[13px] text-[var(--muted)]">
          They see masked numbers only, and only the groups ticked here. An account with no
          groups ticked can sign in but sees nothing.
        </p>
        <div className="flex flex-wrap gap-2 text-[13px]">
          <input
            value={newUser}
            onChange={(e) => setNewUser(e.target.value)}
            placeholder="name@poshnees.com"
            className={control}
          />
          <input
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="password (10+ characters)"
            className={control}
          />
          <button
            onClick={() => void create()}
            disabled={busy}
            className="rounded-lg bg-[var(--ink)] px-4 py-2 font-medium text-[var(--surface)] hover:opacity-90 disabled:opacity-50"
          >
            Create
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {groups.map((g) => (
            <button
              key={g}
              onClick={() => setNewGroups((cur) => toggle(cur, g))}
              className={`rounded-lg border px-3 py-1.5 text-[13px] ${
                newGroups.includes(g)
                  ? 'border-[var(--series-1)] text-[var(--series-1)]'
                  : 'border-[var(--hairline)] text-[var(--ink-2)] hover:bg-[var(--plane)]'
              }`}
            >
              {g.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      </section>

      <section className={`${card} overflow-hidden`}>
        {users.map((u) => (
          <UserCard
            // The grants are in the key so that saving them remounts this card
            // with the new list as its initial state, instead of an effect
            // copying a prop into state on every change.
            key={`${u.username}:${u.groups.join(',')}`}
            user={u}
            groups={groups}
            isYou={u.username.toLowerCase() === you.toLowerCase()}
            busy={busy}
            onSave={(payload) => send('PATCH', { username: u.username, ...payload })}
          />
        ))}
      </section>
    </>
  )
}

function UserCard({
  user,
  groups,
  isYou,
  busy,
  onSave,
}: {
  user: UserRow
  groups: string[]
  isYou: boolean
  busy: boolean
  onSave: (payload: Record<string, unknown>) => Promise<boolean>
}) {
  const [selected, setSelected] = useState<string[]>(user.groups)
  const [password, setPassword] = useState('')

  const dirty =
    selected.length !== user.groups.length || selected.some((g) => !user.groups.includes(g))

  return (
    <div className="border-b border-[var(--hairline)] px-4 py-3.5 last:border-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[15px] font-medium text-[var(--ink)]">{user.username}</span>
        <span className="rounded-md bg-[var(--plane)] px-2 py-0.5 text-[12px] text-[var(--ink-2)]">
          {user.role}
        </span>
        {user.disabled && (
          <span className="rounded-md bg-red-50 px-2 py-0.5 text-[12px] text-red-700 dark:bg-red-950/40 dark:text-red-300">
            disabled
          </span>
        )}
        {isYou && <span className="text-[12px] text-[var(--muted)]">you</span>}

        <div className="ml-auto flex items-center gap-2">
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="new password"
            className={`${control} w-44 text-[13px]`}
          />
          <button
            onClick={async () => {
              if (await onSave({ password })) setPassword('')
            }}
            disabled={busy || password.length < 10}
            className="rounded-lg border border-[var(--hairline)] px-3 py-1.5 text-[13px] text-[var(--ink-2)] hover:bg-[var(--plane)] disabled:opacity-40"
          >
            Reset
          </button>
          {!isYou && (
            <button
              onClick={() => void onSave({ disabled: !user.disabled })}
              disabled={busy}
              className="rounded-lg border border-[var(--hairline)] px-3 py-1.5 text-[13px] text-[var(--ink-2)] hover:bg-[var(--plane)] disabled:opacity-40"
            >
              {user.disabled ? 'Enable' : 'Disable'}
            </button>
          )}
        </div>
      </div>

      {user.role === 'qa' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {groups.map((g) => (
            <button
              key={g}
              onClick={() => setSelected((cur) => (cur.includes(g) ? cur.filter((v) => v !== g) : [...cur, g]))}
              className={`rounded-lg border px-3 py-1 text-[13px] ${
                selected.includes(g)
                  ? 'border-[var(--series-1)] text-[var(--series-1)]'
                  : 'border-[var(--hairline)] text-[var(--muted)] hover:bg-[var(--plane)]'
              }`}
            >
              {g.replace(/_/g, ' ')}
            </button>
          ))}
          {dirty && (
            <button
              onClick={() => void onSave({ groups: selected })}
              disabled={busy}
              className="rounded-lg bg-[var(--ink)] px-3 py-1 text-[13px] font-medium text-[var(--surface)] hover:opacity-90 disabled:opacity-50"
            >
              Save groups
            </button>
          )}
        </div>
      )}
    </div>
  )
}
