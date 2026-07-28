import { NextResponse } from 'next/server'
import {
  CHALLENGE_COOKIE,
  SESSION_COOKIE,
  challengeCookieOptions,
  createChallenge,
  createSession,
  sessionCookieOptions,
  verifyPassword,
} from '@/lib/auth'
import { checkThrottle, clearFailures, getSecurityChallenge, getUser, recordFailure } from '@/lib/db'
import { clientIp } from '@/lib/ip'

/** Evens out the response time so a missing user is not detectable. */
const FAILURE_DELAY_MS = 700

function blockedResponse(retryAfter: number) {
  const minutes = Math.ceil(retryAfter / 60)
  return NextResponse.json(
    {
      error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      retryAfter,
    },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } }
  )
}

export async function POST(request: Request) {
  const ip = clientIp(request.headers)

  let username = ''
  let password = ''
  try {
    const body = await request.json()
    username = String(body.username ?? '')
    password = String(body.password ?? '')
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  try {
    const throttle = await checkThrottle(ip)
    if (throttle.blocked) return blockedResponse(throttle.retryAfter)

    const user = await getUser(username)
    const ok = user !== null && (await verifyPassword(password, user.passwordHash))

    if (!ok) {
      const after = await recordFailure(ip)
      await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS))
      if (after.blocked) return blockedResponse(after.retryAfter)
      return NextResponse.json(
        {
          // Deliberately vague about which half was wrong, but the remaining
          // count is shown so a legitimate user is not surprised by a block.
          error: 'Incorrect email or password',
          remaining: after.remaining,
        },
        { status: 401 }
      )
    }

    const challenge = await getSecurityChallenge(user!.username)

    // Without a configured question there is nothing to ask, so the password
    // alone completes the login. The UI prompts the owner to set one.
    if (!challenge) {
      await clearFailures(ip)
      const response = NextResponse.json({ ok: true, step: 'done', securityQuestionSet: false })
      response.cookies.set(SESSION_COOKIE, await createSession(user!.username), sessionCookieOptions)
      return response
    }

    // Password verified but the login is not finished: hand back only the
    // short-lived challenge cookie, which grants no access by itself.
    const response = NextResponse.json({
      ok: true,
      step: 'challenge',
      question: challenge.question,
    })
    response.cookies.set(
      CHALLENGE_COOKIE,
      await createChallenge(user!.username),
      challengeCookieOptions
    )
    return response
  } catch (error) {
    console.error('login failed', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true })
  response.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions, maxAge: 0 })
  response.cookies.set(CHALLENGE_COOKIE, '', { ...challengeCookieOptions, maxAge: 0 })
  return response
}
