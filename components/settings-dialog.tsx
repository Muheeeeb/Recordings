'use client'

import { useEffect, useState } from 'react'

type Tab = 'password' | 'security'

const field =
  'w-full rounded-lg border border-[var(--hairline)] bg-[var(--plane)] px-3 py-2 text-[var(--ink)] outline-none focus:border-[var(--series-1)]'
const label = 'mb-1.5 block text-[13px] font-medium text-[var(--ink-2)]'

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('password')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] p-6 shadow-xl"
      >
        <div className="mb-5 flex gap-1 rounded-lg bg-[var(--plane)] p-1">
          {(['password', 'security'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                tab === t
                  ? 'bg-[var(--surface)] text-[var(--ink)] shadow-sm'
                  : 'text-[var(--muted)] hover:text-[var(--ink-2)]'
              }`}
            >
              {t === 'password' ? 'Password' : 'Security question'}
            </button>
          ))}
        </div>

        {tab === 'password' ? <PasswordTab onClose={onClose} /> : <SecurityTab onClose={onClose} />}
      </div>
    </div>
  )
}

function Actions({
  onClose,
  busy,
  submitLabel,
}: {
  onClose: () => void
  busy: boolean
  submitLabel: string
}) {
  return (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={onClose}
        className="flex-1 rounded-lg border border-[var(--hairline)] px-4 py-2 text-sm text-[var(--ink-2)] hover:bg-[var(--plane)]"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={busy}
        className="flex-1 rounded-lg bg-[var(--ink)] px-4 py-2 text-sm font-medium text-[var(--surface)] disabled:opacity-50"
      >
        {busy ? 'Saving…' : submitLabel}
      </button>
    </div>
  )
}

function Feedback({ error, done }: { error: string | null; done: string | null }) {
  if (done) {
    return (
      <p className="mb-4 text-sm" style={{ color: 'var(--good)' }}>
        {done}
      </p>
    )
  }
  if (!error) return null
  return (
    <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
      {error}
    </p>
  )
}

function PasswordTab({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (next !== confirm) {
      setError('The new passwords do not match')
      return
    }
    setBusy(true)
    try {
      const response = await fetch('/api/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current, next }),
      })
      if (response.ok) {
        setDone('Password updated.')
        setTimeout(onClose, 1200)
      } else {
        setError((await response.json().catch(() => ({}))).error ?? 'Could not change the password')
      }
    } catch {
      setError('Network error — please try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="mb-5 text-[13px] text-[var(--muted)]">
        At least 10 characters. You stay signed in afterwards.
      </p>

      <label className={label}>Current password</label>
      <input
        type="password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        autoComplete="current-password"
        required
        className={`${field} mb-4`}
      />

      <label className={label}>New password</label>
      <input
        type="password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        autoComplete="new-password"
        required
        minLength={10}
        className={`${field} mb-4`}
      />

      <label className={label}>Confirm new password</label>
      <input
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
        required
        className={`${field} mb-5`}
      />

      <Feedback error={error} done={done} />
      <Actions onClose={onClose} busy={busy} submitLabel="Update" />
    </form>
  )
}

function SecurityTab({ onClose }: { onClose: () => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [existing, setExisting] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/security-question')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (!b) return
        setConfigured(b.configured)
        setExisting(b.question)
        if (b.question) setQuestion(b.question)
      })
      .catch(() => {})
  }, [])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const response = await fetch('/api/security-question', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, answer, password }),
      })
      if (response.ok) {
        setDone('Security question saved. It will be asked at your next sign-in.')
        setConfigured(true)
        setExisting(question)
        setAnswer('')
        setPassword('')
      } else {
        setError((await response.json().catch(() => ({}))).error ?? 'Could not save')
      }
    } catch {
      setError('Network error — please try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="mb-4 text-[13px] text-[var(--muted)]">
        Asked after your password at every sign-in. The answer ignores capitals and extra
        spaces, and is stored hashed — it is never shown again.
      </p>

      {configured === false && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          No security question is set yet, so sign-in currently asks for the password only.
        </p>
      )}
      {configured && existing && (
        <p className="mb-4 text-[13px] text-[var(--ink-2)]">
          Current question: <span className="text-[var(--ink)]">{existing}</span>
        </p>
      )}

      <label className={label}>Question</label>
      <input
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="e.g. What was the name of my first pet?"
        required
        minLength={5}
        className={`${field} mb-4`}
      />

      <label className={label}>Answer</label>
      <input
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        autoComplete="off"
        required
        minLength={3}
        className={`${field} mb-4`}
      />

      <label className={label}>Confirm with your password</label>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        required
        className={`${field} mb-5`}
      />

      <Feedback error={error} done={done} />
      <Actions onClose={onClose} busy={busy} submitLabel="Save" />
    </form>
  )
}
