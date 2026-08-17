import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, readSession } from '@/lib/auth'
import { clientIp, isAllowed, parseAllowlist } from '@/lib/ip'

/**
 * Reachable without a session, but still behind the IP allowlist. /api/verify
 * is the second login step — it has no session yet and guards itself with the
 * short-lived challenge cookie.
 */
const PUBLIC_PATHS = new Set(['/login', '/api/login', '/api/verify', '/api/health'])

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

  const user = await readSession(request.cookies.get(SESSION_COOKIE)?.value)
  if (user) return NextResponse.next()

  // Unauthenticated API calls should fail rather than receive a redirect body.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.redirect(new URL('/login', request.url))
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
