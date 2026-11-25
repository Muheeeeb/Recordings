/**
 * Is a Morpheus -> S3 pull possible right now, on either server?
 *
 * The API lists hundreds of thousands of recordings with a real file_size on
 * each, but listing a recording and being able to fetch its audio are two
 * different things: on poshnee2 every download answers 410 "recording file no
 * longer available", including for a recording four seconds old that has
 * already finalized. That is not retention and not permissions — a missing
 * scope returns an explicit 403 naming it — so the files are not reachable
 * through the download endpoint at all.
 *
 * Run this before building or restarting a pull, and again after the vendor
 * says storage is fixed. It fails loudly while the audio is unreachable
 * instead of letting a puller write nothing for an hour.
 *
 *   npx tsx --env-file=.env.local scripts/morpheus-pull-check.ts
 */

import { type Instance, exactCount, fetchPage, instances } from '../lib/morpheus'

const SAMPLE = 10

async function check(inst: Instance): Promise<boolean> {
  console.log(`\n${inst.label}  (${inst.host})`)

  const total = await exactCount(inst)
  if (total < 0) {
    console.log('   cannot list recordings — check the API key for this server')
    return false
  }
  console.log(`   listed recordings: ${total.toLocaleString()}`)

  const recs = await fetchPage(inst, '', 0)
  const sizeable = recs.filter((r) => (r.file_size ?? 0) > 20_000)
  console.log(`   newest page: ${recs.length} rows, ${sizeable.length} claiming audio over 20 KB`)
  if (sizeable.length === 0) {
    console.log('   nothing with audio on the newest page — cannot judge')
    return false
  }

  let ok = 0
  let youngestFailure = Infinity
  const failures = new Map<string, number>()
  for (const r of sizeable.slice(0, SAMPLE)) {
    const res = await fetch(`https://${inst.host}${r.download_url}`, { headers: inst.headers })
    if (res.ok) { ok++; continue }
    const age = (Date.now() - new Date(r.created_at.replace(' ', 'T').replace(/\+00$/, 'Z')).getTime()) / 1000
    if (age < youngestFailure) youngestFailure = age
    const why = `${res.status} ${(await res.text()).trim().slice(0, 60)}`
    failures.set(why, (failures.get(why) ?? 0) + 1)
  }

  const tried = Math.min(SAMPLE, sizeable.length)
  console.log(`   downloadable: ${ok} of ${tried}`)
  for (const [why, n] of failures) console.log(`      ${n}x  ${why}`)

  if (ok === 0) {
    if (Number.isFinite(youngestFailure)) {
      console.log(`   the youngest failure was ${youngestFailure.toFixed(0)}s old — so nothing expired; the file is simply not served`)
    }
    console.log('   PULL NOT POSSIBLE on this server.')
    return false
  }
  console.log('   pull is possible on this server.')
  return true
}

async function main() {
  const insts = instances()
  console.log(`checking ${insts.length} server(s): ${insts.map((i) => i.label).join(', ')}`)

  const results: boolean[] = []
  for (const inst of insts) results.push(await check(inst))

  const usable = results.filter(Boolean).length
  console.log(`\n${usable} of ${insts.length} server(s) can serve audio.`)
  if (usable === 0) {
    console.log('A 403 would mean the API key lacks permission; 410 means the audio')
    console.log('is not reachable through the API, which only the vendor can fix.')
    process.exit(1)
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1) })
