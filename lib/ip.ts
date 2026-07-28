/**
 * IPv4 allowlist matching for the edge middleware.
 *
 * Kept dependency-free so it can run in the Edge runtime, where node:net
 * and the usual CIDR packages are unavailable.
 */

function toInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << 8) | octet
  }
  return value >>> 0
}

/** Strips the ::ffff: prefix Vercel uses for IPv4-mapped IPv6 addresses. */
function normalise(ip: string): string {
  const trimmed = ip.trim()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed)
  return mapped ? mapped[1] : trimmed
}

export function ipMatches(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.trim().split('/')
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false

  const target = toInt(normalise(ip))
  const base = toInt(range)
  if (target === null || base === null) return false

  if (bits === 0) return true
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return (target & mask) === (base & mask)
}

export function isAllowed(ip: string | null, allowlist: string[]): boolean {
  // An empty allowlist disables IP filtering entirely (local development).
  if (allowlist.length === 0) return true
  if (!ip) return false
  return allowlist.some((cidr) => ipMatches(ip, cidr))
}

/**
 * Vercel overwrites x-forwarded-for at the edge, so the leftmost entry is the
 * real client and cannot be spoofed by the caller.
 */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]
    if (first) return normalise(first)
  }
  const real = headers.get('x-real-ip')
  return real ? normalise(real) : null
}

export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}
