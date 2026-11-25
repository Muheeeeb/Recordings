/**
 * Account management — admin only.
 *
 * QA associates are created here rather than by a script, because the person
 * who needs to add one on a Monday morning is not the person who can run tsx
 * against the production database.
 *
 * Two safeguards are worth naming, because both protect against mistakes that
 * are easy to make and unpleasant to undo:
 *
 * - You cannot change your own role or switch yourself off. That is the classic
 *   way to lock everyone out of an admin UI.
 * - The last enabled admin cannot be demoted or disabled, for the same reason
 *   from the other direction.
 */

import { NextResponse } from 'next/server'
import { hashPassword } from '@/lib/auth'
import { asRole, listGroups, normaliseUser, setPassword, type Role } from '@/lib/db'
import {
  createUser,
  listUsers,
  setUserDisabled,
  setUserGroups,
  setUserRole,
} from '@/lib/users'
import { logActivity } from '@/lib/activity'
import { requireAdmin, requestOrigin } from '@/lib/guard'

/** Long enough that a guesser needs the throttle to stop them, not luck. */
const MIN_PASSWORD = 10

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status })

export async function GET() {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  const [users, groups] = await Promise.all([listUsers(), listGroups()])
  return NextResponse.json({ users, groups, you: guard.username }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function POST(request: Request) {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  let username = ''
  let password = ''
  let role: Role = 'qa'
  let groups: string[] = []
  try {
    const body = await request.json()
    username = String(body.username ?? '').trim()
    password = String(body.password ?? '')
    role = asRole(body.role)
    groups = Array.isArray(body.groups) ? body.groups.map(String) : []
  } catch {
    return bad('Invalid request')
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(username)) {
    return bad('Username must be an email address')
  }
  if (password.length < MIN_PASSWORD) {
    return bad(`Password must be at least ${MIN_PASSWORD} characters`)
  }

  const created = await createUser(username, await hashPassword(password), role)
  if (!created) return bad('That username already exists', 409)

  // Grants are only meaningful for QA; an admin already sees every group.
  const saved = role === 'qa' ? await setUserGroups(username, groups) : []

  const { ip, ua } = await requestOrigin()
  await logActivity({
    username: guard.username,
    role: guard.role,
    action: 'user_created',
    detail: `${normaliseUser(username)} as ${role}${saved.length ? ` (${saved.join(', ')})` : ''}`,
    ip,
    ua,
  })

  return NextResponse.json({ ok: true, username, role, groups: saved })
}

export async function PATCH(request: Request) {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  let username = ''
  let body: {
    role?: unknown
    disabled?: unknown
    groups?: unknown
    password?: unknown
  } = {}
  try {
    const parsed = await request.json()
    username = String(parsed.username ?? '').trim()
    body = parsed
  } catch {
    return bad('Invalid request')
  }
  if (!username) return bad('Which account?')

  const users = await listUsers()
  const target = users.find((u) => normaliseUser(u.username) === normaliseUser(username))
  if (!target) return bad('No such account', 404)

  const isSelf = normaliseUser(username) === normaliseUser(guard.username)
  const changingRole = body.role !== undefined && asRole(body.role) !== target.role
  const changingDisabled = body.disabled !== undefined && Boolean(body.disabled) !== target.disabled

  if (isSelf && (changingRole || changingDisabled)) {
    return bad('You cannot change your own role or switch your own account off', 409)
  }

  // Would this leave nobody who can administer the system?
  if (changingRole || changingDisabled) {
    const adminsLeft = users.filter(
      (u) =>
        u.role === 'admin' &&
        !u.disabled &&
        normaliseUser(u.username) !== normaliseUser(username)
    ).length
    const targetStaysAdmin =
      (body.role === undefined ? target.role : asRole(body.role)) === 'admin' &&
      !(body.disabled === undefined ? target.disabled : Boolean(body.disabled))
    if (adminsLeft === 0 && !targetStaysAdmin) {
      return bad('This is the last admin account — it cannot be demoted or disabled', 409)
    }
  }

  const changes: string[] = []

  if (changingRole) {
    const role = asRole(body.role)
    await setUserRole(username, role)
    changes.push(`role ${target.role} -> ${role}`)
    // An account promoted to admin keeps no stale grants behind it.
    if (role === 'admin') await setUserGroups(username, [])
  }

  if (changingDisabled) {
    const disabled = Boolean(body.disabled)
    await setUserDisabled(username, disabled)
    changes.push(disabled ? 'disabled' : 're-enabled')
  }

  if (Array.isArray(body.groups)) {
    const role = body.role === undefined ? target.role : asRole(body.role)
    if (role === 'qa') {
      const saved = await setUserGroups(username, body.groups.map(String))
      changes.push(`groups: ${saved.length ? saved.join(', ') : 'none'}`)
    }
  }

  if (body.password !== undefined) {
    const password = String(body.password)
    if (password.length < MIN_PASSWORD) {
      return bad(`Password must be at least ${MIN_PASSWORD} characters`)
    }
    await setPassword(username, await hashPassword(password))
    changes.push('password reset')
  }

  if (changes.length === 0) return NextResponse.json({ ok: true, changes: [] })

  const { ip, ua } = await requestOrigin()
  await logActivity({
    username: guard.username,
    role: guard.role,
    action: 'user_changed',
    detail: `${normaliseUser(username)}: ${changes.join('; ')}`,
    ip,
    ua,
  })

  return NextResponse.json({ ok: true, changes })
}
