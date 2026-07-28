import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { SESSION_COOKIE, hashAnswer, readSession, verifyPassword } from '@/lib/auth'
import { getSecurityChallenge, getUser, setSecurityChallenge } from '@/lib/db'

const MIN_ANSWER = 3

/** Reports whether a question is configured (never the answer). */
export async function GET() {
  const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const challenge = await getSecurityChallenge(session)
  return NextResponse.json({ configured: challenge !== null, question: challenge?.question ?? null })
}

export async function POST(request: Request) {
  const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let question = ''
  let answer = ''
  let password = ''
  try {
    const body = await request.json()
    question = String(body.question ?? '').trim()
    answer = String(body.answer ?? '').trim()
    password = String(body.password ?? '')
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  if (question.length < 5) {
    return NextResponse.json({ error: 'Please write a longer question' }, { status: 400 })
  }
  if (answer.length < MIN_ANSWER) {
    return NextResponse.json(
      { error: `The answer must be at least ${MIN_ANSWER} characters` },
      { status: 400 }
    )
  }

  // Changing the second factor requires the first one, so a borrowed session
  // cannot quietly replace the question with one the attacker knows.
  const user = await getUser(session)
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    await new Promise((resolve) => setTimeout(resolve, 700))
    return NextResponse.json({ error: 'Password is incorrect' }, { status: 401 })
  }

  await setSecurityChallenge(session, question, await hashAnswer(answer))
  return NextResponse.json({ ok: true })
}
