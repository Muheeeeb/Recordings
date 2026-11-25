import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { SESSION_COOKIE, readSession } from '@/lib/auth'
import { currentRole, getUserGroups } from '@/lib/users'
import { clientIp, isAllowed, parseAllowlist } from '@/lib/ip'

/**
 * Reports the address the allowlist actually sees, so it can be set from a
 * measurement instead of a guess. Getting ALLOWED_IPS wrong makes every route
 * return 404 with no explanation, and a dynamic or IPv6 address is an easy way
 * to get it wrong.
 */
export async function GET(request: Request) {
  const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // The live role, not the cookie's claim, so the UI shows what the account can
  // actually do right now.
  const role = await currentRole(session)
  const groups = role === 'qa' ? await getUserGroups(session) : null

  const ip = clientIp(request.headers)
  const allowlist = parseAllowlist(process.env.ALLOWED_IPS)
  const ipv6 = ip !== null && ip.includes(':')

  return NextResponse.json({
    username: session,
    role,
    groups,
    yourIp: ip,
    isIPv6: ipv6,
    allowlist,
    allowlistActive: allowlist.length > 0,
    wouldBeAllowed: isAllowed(ip, allowlist),
    // The check is IPv4-only, so an IPv6 client is refused even when its IPv4
    // address is listed.
    warning: ipv6
      ? 'Your browser is connecting over IPv6. Add this address to ALLOWED_IPS as well, or force IPv4.'
      : null,
  })
}
