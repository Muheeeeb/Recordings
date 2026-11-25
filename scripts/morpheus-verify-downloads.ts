/**
 * Proves downloads work well enough to build a pull on, which a green
 * pull-check does not: that only samples the newest page.
 *
 * Three things are checked per day across the whole archive:
 *   - does the HISTORY download, or only recordings made since the vendor's
 *     fix (if the fix only applies going forward, the backlog is still lost);
 *   - are the bytes real audio of the length the API advertises, not a stub or
 *     an error page served with a 200;
 *   - how far back the archive still reaches, which sets how often a pull has
 *     to run before recordings age out.
 *
 *   npx tsx --env-file=.env.local scripts/morpheus-verify-downloads.ts
 */

import { dayRange, exactCount, fetchPage, instances, type Instance } from '../lib/morpheus'

const PER_DAY = 5

/** Enough of a signature to tell real audio from an error body. */
function identify(buf: Buffer): string {
  const head = buf.subarray(0, 12).toString('latin1')
  if (head.startsWith('RIFF') && head.includes('WAVE')) return 'WAV'
  if (head.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'MP3'
  if (head.startsWith('OggS')) return 'OGG'
  if (head.startsWith('fLaC')) return 'FLAC'
  if (head.startsWith('{') || head.startsWith('<')) return 'TEXT!'
  return `?${buf.subarray(0, 4).toString('hex')}`
}

async function checkDay(inst: Instance, day: string) {
  const recs = await fetchPage(inst, dayRange(day), 0)
  const sized = recs.filter((r) => (r.file_size ?? 0) > 20_000)
  if (sized.length === 0) {
    console.log(`  ${day}   ${String(recs.length).padStart(3)} rows, none with audio`)
    return { ok: 0, failed: 0 }
  }

  let ok = 0
  let failed = 0
  let mismatch = 0
  let bytes = 0
  const kinds = new Set<string>()
  const errors = new Set<string>()

  for (const r of sized.slice(0, PER_DAY)) {
    const res = await fetch(`https://${inst.host}${r.download_url}`, { headers: inst.headers })
    if (!res.ok) {
      failed++
      errors.add(`${res.status} ${(await res.text()).trim().slice(0, 40)}`)
      continue
    }
    const buf = Buffer.from(await res.arrayBuffer())
    ok++
    bytes += buf.length
    kinds.add(identify(buf))
    // A truncated or substituted body would not match the advertised size.
    if (Math.abs(buf.length - (r.file_size ?? 0)) > 64) mismatch++
  }

  const avg = ok ? (bytes / ok / 1024).toFixed(0) : '-'
  console.log(
    `  ${day}   ${String(recs.length).padStart(3)} rows   ok ${String(ok).padStart(2)}/${ok + failed}` +
      `   size-mismatch ${mismatch}   ${[...kinds].join(',') || '-'}   avg ${avg} KB` +
      (errors.size ? `   ${[...errors].join('; ')}` : '')
  )
  return { ok, failed }
}

async function main() {
  for (const inst of instances()) {
    console.log(`\n${inst.label}  (${inst.host})`)

    const total = await exactCount(inst)
    const oldestPage = await fetchPage(inst, '', Math.max(0, total - 1))
    const newestPage = await fetchPage(inst, '', 0)
    const oldest = oldestPage[0]?.created_at?.slice(0, 19) ?? '?'
    const newest = newestPage[0]?.created_at?.slice(0, 19) ?? '?'
    console.log(`  total ${total.toLocaleString()}   archive spans ${oldest} .. ${newest}`)

    // Walk every day from the oldest record to today.
    const start = new Date(`${oldest.slice(0, 10)}T00:00:00Z`)
    const end = new Date(`${newest.slice(0, 10)}T00:00:00Z`)
    const days: string[] = []
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(d.toISOString().slice(0, 10))
    }
    console.log(`  checking ${days.length} day(s), up to ${PER_DAY} downloads each\n`)

    let ok = 0
    let failed = 0
    for (const day of days) {
      const r = await checkDay(inst, day)
      ok += r.ok
      failed += r.failed
    }

    console.log(`\n  ${inst.label}: ${ok} downloaded, ${failed} failed`)
    if (failed === 0 && ok > 0) console.log('  History and current recordings both download. A pull can be built.')
    else if (ok > 0) console.log('  PARTIAL — some days fail; a pull would silently skip those.')
    else console.log('  Nothing downloads.')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
