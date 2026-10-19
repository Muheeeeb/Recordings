/**
 * Parses VICIdial-style recording filenames into searchable fields.
 *
 * The dialer has already changed this format once — it grew an `S_` prefix and
 * a customer phone number — so nothing here depends on a field's position:
 *
 *     20260722-145445_5738740_CLOSER2-all.mp3
 *   S_20260727-160438_6256932_MAIN_4074731824-all.mp3
 *
 * The timestamp is located by matching it rather than by taking the first
 * token, and every token after it is classified by shape:
 *
 *   6-9 digits    -> lead id
 *   10-11 digits  -> phone number (a leading US country code is dropped)
 *   anything else -> agent
 */

/**
 * Two timestamp spellings are in the bucket. Most folders use a dash between
 * the date and the time; some Rockey recordings run the two together. The
 * dashless form is matched second so a 14-digit token is never mistaken for
 * some other number.
 */
const STAMP = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/
const STAMP_COMPACT = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/
const matchStamp = (token: string) => STAMP.exec(token) ?? STAMP_COMPACT.exec(token)

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
  const stampIndex = tokens.findIndex((token) => matchStamp(token) !== null)
  if (stampIndex === -1) return base

  const stamp = matchStamp(tokens[stampIndex])!
  const [, y, mo, d, h, mi, s] = stamp
  base.recordedAt = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`
  base.parsed = true

  const rest = tokens.slice(stampIndex + 1)

  // The mix type is a suffix on the final token (…_MAIN_4074731824-all), so it
  // is peeled off before the token is classified.
  if (rest.length > 0) {
    const last = rest[rest.length - 1]
    const dash = last.lastIndexOf('-')
    if (dash !== -1 && MIX.test(last.slice(dash + 1))) {
      base.mix = last.slice(dash + 1).toLowerCase()
      rest[rest.length - 1] = last.slice(0, dash)
    }
  }

  for (const token of rest) {
    if (!token) continue
    if (DIGITS.test(token)) {
      if (token.length >= 10 && token.length <= 11) {
        base.phone = token.length === 11 && token.startsWith('1') ? token.slice(1) : token
      } else if (token.length >= 6 && token.length <= 9) {
        base.leadId = token
      }
    } else if (!base.agent) {
      // The first non-numeric token is the agent; later ones are ignored so a
      // stray marker cannot overwrite it.
      base.agent = token
    }
  }

  return base
}
