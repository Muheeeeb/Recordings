'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [step, setStep] = useState<'password' | 'challenge'>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  function done() {
    router.replace('/')
    router.refresh()
  }

  async function submitPassword(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: email, password }),
      })
      const body = await response.json().catch(() => ({}))

      if (response.ok) {
        setRemaining(null)
        if (body.step === 'challenge') {
          setQuestion(body.question)
          setStep('challenge')
        } else {
          done()
        }
      } else {
        setError(body.error ?? 'Sign in failed')
        setRemaining(typeof body.remaining === 'number' ? body.remaining : null)
      }
    } catch {
      setError('Network error — please try again')
    } finally {
      setBusy(false)
    }
  }

  async function submitAnswer(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      })
      const body = await response.json().catch(() => ({}))

      if (response.ok) {
        done()
      } else {
        setError(body.error ?? 'Verification failed')
        setRemaining(typeof body.remaining === 'number' ? body.remaining : null)
        // An expired challenge means starting over, not retrying the answer.
        if (response.status === 401 && !body.remaining) {
          setStep('password')
          setPassword('')
          setAnswer('')
        }
      }
    } catch {
      setError('Network error — please try again')
    } finally {
      setBusy(false)
    }
  }

  const field =
    'w-full rounded-lg border border-[var(--hairline)] bg-[var(--plane)] px-3 py-2 text-[var(--ink)] outline-none focus:border-[var(--series-1)]'
  const button =
    'w-full rounded-lg bg-[var(--ink)] px-4 py-2.5 font-medium text-[var(--surface)] transition-opacity hover:opacity-90 disabled:opacity-50'

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--plane)] px-4">
      <div className="w-full max-w-sm rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] p-8">
        <div className="mb-7 text-center">
          <div className="mb-3 text-3xl">🔒</div>
          <h1 className="font-semibold text-[var(--ink)]">Call Recordings</h1>
          <p className="mt-1 text-[13px] text-[var(--muted)]">
            {step === 'password' ? 'Authorized personnel only' : 'One more step'}
          </p>
        </div>

        {step === 'password' ? (
          <form onSubmit={submitPassword}>
            <label className="mb-1.5 block text-[13px] font-medium text-[var(--ink-2)]">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
              className={`${field} mb-4`}
            />

            <label className="mb-1.5 block text-[13px] font-medium text-[var(--ink-2)]">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className={`${field} mb-5`}
            />

            <Message error={error} remaining={remaining} />

            <button type="submit" disabled={busy} className={button}>
              {busy ? 'Checking…' : 'Continue'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitAnswer}>
            <label className="mb-1.5 block text-[13px] font-medium text-[var(--ink-2)]">
              Security question
            </label>
            <p className="mb-4 rounded-lg bg-[var(--plane)] px-3 py-2 text-sm text-[var(--ink)]">
              {question}
            </p>

            <label className="mb-1.5 block text-[13px] font-medium text-[var(--ink-2)]">
              Your answer
            </label>
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              autoComplete="off"
              autoFocus
              required
              className={`${field} mb-5`}
            />

            <Message error={error} remaining={remaining} />

            <button type="submit" disabled={busy} className={button}>
              {busy ? 'Verifying…' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
    </main>
  )
}

function Message({ error, remaining }: { error: string | null; remaining: number | null }) {
  if (!error) return null
  return (
    <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
      <p>{error}</p>
      {remaining !== null && remaining > 0 && (
        <p className="mt-0.5 text-[12px] opacity-80">
          {remaining} attempt{remaining === 1 ? '' : 's'} left before a temporary block.
        </p>
      )}
    </div>
  )
}
