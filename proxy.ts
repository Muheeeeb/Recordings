import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, readSessionClaims } from '@/lib/auth'
import { clientIp, isAllowed, parseAllowlist } from '@/lib/ip'

/**
 * Reachable without a session, but still behind the IP allowlist. /api/verify
 * is the second login step — it has no session yet and guards itself with the
 * short-lived challenge cookie.
 */
const PUBLIC_PATHS = new Set(['/login', '/api/login', '/api/verify', '/api/health'])

/**
 * Everything a QA session may reach, as an allowlist rather than a list of
 * things it may not.
 *
 * Fail-closed matters more here than anywhere else in the app: a new admin
 * route added next month must be unreachable by QA by default, and with a
 * denylist it would be reachable until somebody remembered to add it. The cost
 * is that a new QA route has to be added here, which is the direction of error
 * we want — a QA feature that 403s is a bug report, a QA account that can read
 * phone numbers is an incident.
 *
 * Note that this is routing, not authorisation. Next's own guidance is not to
 * rely on the proxy for access control, so each handler re-checks the role
 * against the database.
 */
const QA_PREFIXES = [
  '/qa',
  '/api/qa/',
  // Signing out, identifying itself, and changing its own password.
  '/api/whoami',
  '/api/password',
  '/api/security-question',
]

const qaMayReach = (pathname: string) =>
  pathname === '/qa' || QA_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))

export async function proxy(request: NextRequest) {
  const allowlist = parseAllowlist(process.env.ALLOWED_IPS)
  const ip = clientIp(request.headers)

  // Blocked addresses get a 404 rather than a 403 so a scanner cannot tell
  // that anything is hosted here.
  if (!isAllowed(ip, allowlist)) {
    return new NextResponse('Not Found', { status: 404 })
  }

  const { pathname } = request.nextUrl
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next()

  const claims = await readSessionClaims(request.cookies.get(SESSION_COOKIE)?.value)

  if (!claims) {
    // Unauthenticated API calls should fail rather than receive a redirect body.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.redirect(new URL('/login', request.url))
  }

  if (claims.role === 'qa' && !qaMayReach(pathname)) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    // A QA associate who opens the root or a bookmarked admin page lands on
    // their own portal instead of a dead end.
    return NextResponse.redirect(new URL('/qa', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
