/**
 * Sanity check for the filename parser against the format the dialer sends
 * today and the variations expected once customer numbers are added.
 *
 *   npx tsx scripts/test-parse.ts
 */

import { parseRecording } from '../lib/parse'

const samples = [
  'dialer/Closers_ACA/20260726-004021_6026629_CLOSER2-all.mp3',
  'dialer/Closers_ACA/20260726-004021_6026629_3055551234_CLOSER2-all.mp3',
  'dialer/Main_ACA_Fronter/20260726-004021_6026629_13055551234_FRONT9-all.mp3',
  'dialer/Closers_Medicare/20260726-113000_3055559876_CLOSER7-all.mp3',
  'dialer/Main_Medicare_Fronter/20260726-235959_6026630_AGENT12-in.wav',
  'dialer/Closers_ACA/20260726-090000_6026631_CLOSER2.mp3',
  'dialer/Closers_ACA/2026/07/26/20260726-004021_6026629_CLOSER2-all.mp3',
]

const pad = (s: string | null, n: number) => String(s ?? '—').padEnd(n)

console.log(
  pad('GROUP', 22) + pad('RECORDED AT', 22) + pad('LEAD ID', 10) + pad('PHONE', 12) + pad('AGENT', 9) + 'MIX'
)
console.log('-'.repeat(88))

for (const key of samples) {
  const r = parseRecording(key)
  if (!r.parsed) {
    console.log('UNPARSED: ' + key)
    continue
  }
  console.log(
    pad(r.group, 22) + pad(r.recordedAt, 22) + pad(r.leadId, 10) + pad(r.phone, 12) + pad(r.agent, 9) + (r.mix ?? '—')
  )
}
