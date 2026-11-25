import { NextResponse } from 'next/server'
import {
  CHALLENGE_COOKIE,
  SESSION_COOKIE,
  challengeCookieOptions,
  createChallenge,
  createSession,
  readSessionClaims,
  sessionCookieOptions,
  verifyPassword,
} from '@/lib/auth'
import { cookies } from 'next/headers'
import { checkThrottle, clearFailures, getSecurityChallenge, getUser, recordFailure } from '@/lib/db'
import { logActivity } from '@/lib/activity'
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
    // A disabled account fails exactly like a wrong password, and takes the
    // same throttling path. Telling the holder that the account exists but has
    // been switched off is information they do not need.
    const ok =
      user !== null && !user.disabled && (await verifyPassword(password, user.passwordHash))

    if (!ok) {
      await logActivity({
        username: username.slice(0, 120),
        action: 'login_failed',
        detail: user === null ? 'no such account' : user.disabled ? 'account disabled' : 'bad password',
        ip,
        ua: request.headers.get('user-agent'),
      })
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
      await logActivity({
        username: user!.username,
        role: user!.role,
        action: 'login',
        detail: 'password only (no security question set)',
        ip,
        ua: request.headers.get('user-agent'),
      })
      const response = NextResponse.json({
        ok: true,
        step: 'done',
        securityQuestionSet: false,
        role: user!.role,
      })
      response.cookies.set(
        SESSION_COOKIE,
        await createSession(user!.username, user!.role),
        sessionCookieOptions
      )
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

export async function DELETE(request: Request) {
  // Logged before the cookie is cleared, so the log shows who signed out
  // rather than an anonymous event.
  const claims = await readSessionClaims((await cookies()).get(SESSION_COOKIE)?.value)
  if (claims) {
    await logActivity({
      username: claims.username,
      role: claims.role,
      action: 'logout',
      ip: clientIp(request.headers),
      ua: request.headers.get('user-agent'),
    })
  }

  const response = NextResponse.json({ ok: true })
  response.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions, maxAge: 0 })
  response.cookies.set(CHALLENGE_COOKIE, '', { ...challengeCookieOptions, maxAge: 0 })
  return response
}
