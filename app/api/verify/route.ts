import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import {
  CHALLENGE_COOKIE,
  SESSION_COOKIE,
  challengeCookieOptions,
  createSession,
  readChallenge,
  sessionCookieOptions,
  verifyAnswer,
} from '@/lib/auth'
import { checkThrottle, clearFailures, getSecurityChallenge, recordFailure } from '@/lib/db'
import { currentRole } from '@/lib/users'
import { logActivity } from '@/lib/activity'
import { clientIp } from '@/lib/ip'

const FAILURE_DELAY_MS = 700

/** Second login step: verifies the security answer and issues the session. */
export async function POST(request: Request) {
  const ip = clientIp(request.headers)

  const username = await readChallenge((await cookies()).get(CHALLENGE_COOKIE)?.value)
  if (!username) {
    return NextResponse.json({ error: 'Your login expired — please sign in again' }, { status: 401 })
  }

  let answer = ''
  try {
    answer = String((await request.json()).answer ?? '')
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  try {
    // The same counter as the password step, so this cannot be used to sidestep
    // the limit by guessing answers instead of passwords.
    const throttle = await checkThrottle(ip)
    if (throttle.blocked) {
      const minutes = Math.ceil(throttle.retryAfter / 60)
      return NextResponse.json(
        { error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` },
        { status: 429 }
      )
    }

    const challenge = await getSecurityChallenge(username)
    if (!challenge) {
      return NextResponse.json({ error: 'No security question is set' }, { status: 400 })
    }

    if (!(await verifyAnswer(answer, challenge.answerHash))) {
      const after = await recordFailure(ip)
      await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS))
      if (after.blocked) {
        const minutes = Math.ceil(after.retryAfter / 60)
        return NextResponse.json(
          { error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` },
          { status: 429 }
        )
      }
      return NextResponse.json(
        { error: 'Incorrect answer', remaining: after.remaining },
        { status: 401 }
      )
    }

    await clearFailures(ip)

    // The role is read here rather than carried from the password step: the
    // challenge cookie holds only a username, and an account disabled between
    // the two steps must not complete the login.
    const role = await currentRole(username)
    if (!role) {
      return NextResponse.json({ error: 'This account is no longer active' }, { status: 403 })
    }

    await logActivity({
      username,
      role,
      action: 'login',
      ip,
      ua: request.headers.get('user-agent'),
    })

    const response = NextResponse.json({ ok: true, role })
    response.cookies.set(SESSION_COOKIE, await createSession(username, role), sessionCookieOptions)
    response.cookies.set(CHALLENGE_COOKIE, '', { ...challengeCookieOptions, maxAge: 0 })
    return response
  } catch (error) {
    console.error('verify failed', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
