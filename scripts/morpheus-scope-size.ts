/**
 * What the agreed pull scope actually weighs.
 *
 * Scope: every Closer and Closer2 recording, plus the XFER calls only from the
 * self-verifier campaign. Nothing from Fronter.
 *
 * The measurement is done in SECONDS OF AUDIO, not bytes, because the vendor
 * changed the recording format on 19 Nov — the same call is M4A at ~5 KB/s up
 * to 18 Nov and raw WAV at ~32 KB/s after. Seconds are format-independent, so
 * one measurement projects the cost under either format and the comparison
 * does not quietly mix the two eras.
 *
 *   npx tsx --env-file=.env.local scripts/morpheus-scope-size.ts [--pages=600]
 */

import {
  PAGE, exactCount, fetchPage, instances, isCloserCampaign, isTransfer, isVerifierCampaign,
  type Instance, type RecordingRow,
} from '../lib/morpheus'

/** Bytes per second of audio, measured from the recordings themselves. */
const RATE = { m4a: 5.1 * 1024, wav: 32.0 * 1024 }

/** S3 Standard, ap-south-1 (Mumbai), per GB-month. */
const S3_GB_MONTH = 0.025
/** PUT requests, per 1,000. */
const S3_PUT_1K = 0.005

const GB = 1024 ** 3

const arg = (name: string, fallback: number) => {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? Number(m.split('=')[1]) : fallback
}

type Bucket = { label: string; n: number; secs: number }

const add = (b: Bucket, r: RecordingRow) => {
  b.n++
  b.secs += r.duration_sec ?? 0
}

async function measure(inst: Instance, pages: number) {
  const total = await exactCount(inst)
  const step = Math.max(PAGE, Math.floor(total / pages))
  const offsets = Array.from({ length: pages }, (_, i) => i * step).filter((o) => o < total)

  const sample: RecordingRow[] = []
  const queue = [...offsets]
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let off = queue.shift(); off !== undefined; off = queue.shift()) {
        sample.push(...(await fetchPage(inst, '', off)))
      }
    })
  )
  return { total, sample }
}

async function main() {
  const pages = arg('pages', 600)
  const inst = instances()[0]
  const { total, sample } = await measure(inst, pages)

  // How many days the archive covers, so a daily rate can be derived.
  const days = new Set(sample.map((r) => (r.created_at ?? '').slice(0, 10)).filter(Boolean))
  const activeDays = days.size
  const scale = total / sample.length

  console.log(`${inst.label}: ${total.toLocaleString()} recordings, sampled ${sample.length.toLocaleString()} (1 in ${scale.toFixed(0)})`)
  console.log(`archive covers ${activeDays} day(s) with calls\n`)

  // ---- the scope ---------------------------------------------------------
  const closers: Bucket = { label: 'Closer + Closer2 (everything)', n: 0, secs: 0 }
  const verifierXfer: Bucket = { label: 'Self-Verifier, XFER only', n: 0, secs: 0 }
  const verifierAll: Bucket = { label: '  (self-verifier, all of it)', n: 0, secs: 0 }
  const fronter: Bucket = { label: '  (Fronter — excluded)', n: 0, secs: 0 }
  const other: Bucket = { label: '  (everything else — excluded)', n: 0, secs: 0 }

  for (const r of sample) {
    if ((r.file_size ?? 0) <= 0) continue // a row with no audio is nothing to pull
    const c = (r.campaign ?? '').trim()
    if (isCloserCampaign(c)) add(closers, r)
    else if (isVerifierCampaign(c)) {
      add(verifierAll, r)
      if (isTransfer(r.segment)) add(verifierXfer, r)
    } else if (/^fronter$/i.test(c)) add(fronter, r)
    else add(other, r)
  }

  const row = (b: Bucket) => {
    const perDayRecs = (b.n * scale) / activeDays
    const perDaySecs = (b.secs * scale) / activeDays
    const avgLen = b.n ? b.secs / b.n : 0
    const m4aMonth = (perDaySecs * 30 * RATE.m4a) / GB
    const wavMonth = (perDaySecs * 30 * RATE.wav) / GB
    console.log(
      `${b.label.padEnd(32)} ${Math.round(perDayRecs).toLocaleString().padStart(7)}/day  ` +
        `avg ${avgLen.toFixed(0).padStart(4)}s   M4A ${m4aMonth.toFixed(0).padStart(5)} GB/mo   WAV ${wavMonth.toFixed(0).padStart(5)} GB/mo`
    )
    return { perDayRecs, m4aMonth, wavMonth }
  }

  const closerNames = new Map<string, number>()
  for (const r of sample) if (isCloserCampaign(r.campaign)) {
    const k = (r.campaign ?? '').trim()
    closerNames.set(k, (closerNames.get(k) ?? 0) + 1)
  }

  console.log('IN SCOPE')
  const a = row(closers)
  for (const [k, n] of [...closerNames].sort((x, y) => y[1] - x[1])) {
    console.log(`     ${k.padEnd(27)} ${Math.round((n * scale) / activeDays).toLocaleString().padStart(6)}/day`)
  }
  const b = row(verifierXfer)

  console.log('\nFOR COMPARISON (not pulled)')
  row(verifierAll)
  row(fronter)
  row(other)

  // ---- the bill ----------------------------------------------------------
  const recsDay = a.perDayRecs + b.perDayRecs
  const m4a = a.m4aMonth + b.m4aMonth
  const wav = a.wavMonth + b.wavMonth
  const putMonth = ((recsDay * 30) / 1000) * S3_PUT_1K

  console.log(`\n${'='.repeat(72)}`)
  console.log(`SCOPE TOTAL: ${Math.round(recsDay).toLocaleString()} recordings a day, ${Math.round(recsDay * 30).toLocaleString()} a month\n`)
  console.log('format   added per month   month 1    month 6    month 12   uploads/mo')
  for (const [name, gbMonth] of [['M4A', m4a], ['WAV', wav]] as const) {
    const m1 = gbMonth * S3_GB_MONTH
    const m6 = gbMonth * 6 * S3_GB_MONTH
    const m12 = gbMonth * 12 * S3_GB_MONTH
    console.log(
      `${name.padEnd(8)} ${gbMonth.toFixed(0).padStart(11)} GB   ` +
        `${('$' + m1.toFixed(0)).padStart(7)}   ${('$' + m6.toFixed(0)).padStart(7)}   ${('$' + m12.toFixed(0)).padStart(8)}   ${('$' + putMonth.toFixed(0)).padStart(9)}`
    )
  }
  console.log('\n(month N = what the stored total costs that month; storage accumulates,')
  console.log(' uploads are a flat monthly charge. WAV / M4A = ' + (wav / m4a).toFixed(1) + 'x.)')

  const everythingSecs = (sample.filter((r) => (r.file_size ?? 0) > 0).reduce((s, r) => s + (r.duration_sec ?? 0), 0) * scale) / activeDays
  const everythingWav = (everythingSecs * 30 * RATE.wav) / GB
  console.log(`\nAgainst pulling everything: ${everythingWav.toFixed(0)} GB/mo on WAV — the scope is ${((wav / everythingWav) * 100).toFixed(1)}% of that.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
