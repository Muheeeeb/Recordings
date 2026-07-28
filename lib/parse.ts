/**
 * Parses VICIdial-style recording filenames into searchable fields.
 *
 * Fields are identified by SHAPE, not by position, so the parser keeps
 * working when the dialer starts adding the customer phone number.
 *
 *   20260726-004021_6026629_CLOSER2-all.mp3
 *   YYYYMMDD-HHMMSS_<numbers...>_<agent>-<mix>.<ext>
 *
 * Numeric tokens are classified as:
 *   6-9 digits   -> lead id
 *   10-11 digits -> phone number (11 digits are normalised down from a
 *                   leading US country code)
 */

const STAMP = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/
const DIGITS = /^\d+$/
const MIX = /^(all|in|out|both|mix)$/i

export type Recording = {
  key: string
  group: string | null
  recordedAt: string | null
  leadId: string | null
  phone: string | null
  agent: string | null
  mix: string | null
  ext: string
  parsed: boolean
}

export function groupFromKey(key: string): string | null {
  // dialer/<Group>/.../file.mp3
  const parts = key.split('/')
  return parts.length > 2 && parts[0] === 'dialer' ? parts[1] : null
}

export function parseRecording(key: string): Recording {
  const name = key.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  const stem = dot === -1 ? name : name.slice(0, dot)
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()

  const base: Recording = {
    key,
    group: groupFromKey(key),
    recordedAt: null,
    leadId: null,
    phone: null,
    agent: null,
    mix: null,
    ext,
    parsed: false,
  }

  const tokens = stem.split('_')
  const stamp = STAMP.exec(tokens[0] ?? '')
  if (!stamp) return base

  const [, y, mo, d, h, mi, s] = stamp
  base.recordedAt = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`
  base.parsed = true

  // The agent lives in the final token, usually suffixed with the mix type
  // (CLOSER2-all). Split on the last dash only if that tail looks like a mix.
  const last = tokens[tokens.length - 1]
  if (last && tokens.length > 1) {
    const dash = last.lastIndexOf('-')
    if (dash !== -1 && MIX.test(last.slice(dash + 1))) {
      base.agent = last.slice(0, dash)
      base.mix = last.slice(dash + 1).toLowerCase()
    } else {
      base.agent = last
    }
  }

  // Everything between the timestamp and the agent is numeric metadata.
  for (const token of tokens.slice(1, -1)) {
    if (!DIGITS.test(token)) continue
    if (token.length >= 10 && token.length <= 11) {
      base.phone = token.length === 11 && token.startsWith('1') ? token.slice(1) : token
    } else if (token.length >= 6 && token.length <= 9) {
      base.leadId = token
    }
  }

  return base
}
