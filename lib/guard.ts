/**
 * The per-handler half of access control.
 *
 * The proxy decides which portal a path belongs to. This decides whether the
 * caller is really allowed, and it is the half that matters, for two reasons:
 *
 * - Next's own guidance is that a matcher change or a refactor can silently
 *   remove proxy coverage, so authorisation belongs in the handler.
 * - The role in the session cookie is eight hours old at worst. Someone
 *   demoted or switched off this morning still holds a token that says
 *   otherwise, so the role is re-read from the database here.
 *
 * One database round trip per request is the price. It is a single indexed
 * lookup, and the alternative is a window during which a withdrawn account
 * still works.
 */

import { NextResponse } from 'next/server'
import { cookies, headers } from 'next/headers'
import { SESSION_COOKIE, readSessionClaims } from '@/lib/auth'
import { currentRole } from '@/lib/users'
import { clientIp } from '@/lib/ip'
import type { Role } from '@/lib/db'

export type Guard =
  | { ok: true; username: string; role: Role }
  | { ok: false; response: NextResponse }

const unauthorized = () =>
  NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

const forbidden = () => NextResponse.json({ error: 'Forbidden' }, { status: 403 })

/**
 * Establishes who is calling and that they currently hold one of `allow`.
 *
 * A session whose account has been disabled or deleted resolves to no role at
 * all and is treated as unauthenticated, so the stale cookie stops working
 * immediately rather than at expiry.
 */
export async function requireRole(allow: Role[]): Promise<Guard> {
  const claims = await readSessionClaims((await cookies()).get(SESSION_COOKIE)?.value)
  if (!claims) return { ok: false, response: unauthorized() }

  const role = await currentRole(claims.username)
  if (!role) return { ok: false, response: unauthorized() }
  if (!allow.includes(role)) return { ok: false, response: forbidden() }

  return { ok: true, username: claims.username, role }
}

export const requireAdmin = () => requireRole(['admin'])

/** QA routes are open to admins too, so masking can be checked from the inside. */
export const requireReviewer = () => requireRole(['admin', 'qa'])

/** Where the request came from, for the activity log. */
export async function requestOrigin(): Promise<{ ip: string | null; ua: string | null }> {
  const h = await headers()
  return { ip: clientIp(h), ua: h.get('user-agent') }
}
