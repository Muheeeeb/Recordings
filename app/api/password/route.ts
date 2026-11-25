import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import {
  SESSION_COOKIE,
  createSession,
  hashPassword,
  readSession,
  sessionCookieOptions,
  verifyPassword,
} from '@/lib/auth'
import { getUser, setPassword } from '@/lib/db'

const MIN_LENGTH = 10
const FAILURE_DELAY_MS = 700

export async function POST(request: Request) {
  const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let current = ''
  let next = ''
  try {
    const body = await request.json()
    current = String(body.current ?? '')
    next = String(body.next ?? '')
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  if (next.length < MIN_LENGTH) {
    return NextResponse.json(
      { error: `New password must be at least ${MIN_LENGTH} characters` },
      { status: 400 }
    )
  }
  if (next === current) {
    return NextResponse.json({ error: 'New password must be different' }, { status: 400 })
  }

  const user = await getUser(session)
  // Knowing the current password is required, so a borrowed session alone
  // cannot lock the real owner out.
  if (!user || !(await verifyPassword(current, user.passwordHash))) {
    await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS))
    return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 })
  }

  await setPassword(session, await hashPassword(next))

  // Issue a fresh session so the change invalidates nothing the user is doing.
  // The role comes from the account as it stands, not from the old cookie.
  const response = NextResponse.json({ ok: true })
  response.cookies.set(
    SESSION_COOKIE,
    await createSession(session, user.role),
    sessionCookieOptions
  )
  return response
}
