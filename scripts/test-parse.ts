/**
 * Sanity check for the filename parser across every format the dialer has used.
 *
 *   npx tsx scripts/test-parse.ts
 */

import { parseRecording } from '../lib/parse'

const cases: { key: string; expect: Partial<Record<'leadId' | 'phone' | 'agent' | 'mix', string>> }[] = [
  // Current format: S_ prefix and the customer phone number.
  {
    key: 'dialer/Main_ACA_Fronter/20260727/S_20260727-160438_6256932_MAIN_4074731824-all.mp3',
    expect: { leadId: '6256932', phone: '4074731824', agent: 'MAIN', mix: 'all' },
  },
  // Original format, still present for everything indexed before the change.
  {
    key: 'dialer/Closers_ACA/20260722/20260722-145445_5738740_CLOSER2-all.mp3',
    expect: { leadId: '5738740', agent: 'CLOSER2', mix: 'all' },
  },
  // A phone number carrying the US country code.
  {
    key: 'dialer/Main_ACA_Fronter/20260727/S_20260727-160438_6256932_MAIN2_14074731824-all.mp3',
    expect: { leadId: '6256932', phone: '4074731824', agent: 'MAIN2', mix: 'all' },
  },
  // Other mix types and extensions VICIdial emits.
  {
    key: 'dialer/Main_Medicare_Fronter/20260726/20260726-235959_6026630_AGENT12-in.wav',
    expect: { leadId: '6026630', agent: 'AGENT12', mix: 'in' },
  },
  // No mix suffix at all.
  {
    key: 'dialer/Closers_ACA/20260726/20260726-090000_6026631_CLOSER2.mp3',
    expect: { leadId: '6026631', agent: 'CLOSER2' },
  },
  // Phone number but no lead id.
  {
    key: 'dialer/Closers_Medicare/20260726/S_20260726-113000_CLOSER7_3055559876-all.mp3',
    expect: { phone: '3055559876', agent: 'CLOSER7', mix: 'all' },
  },
]

let failures = 0

for (const { key, expect } of cases) {
  const r = parseRecording(key)
  const problems: string[] = []

  if (!r.parsed) problems.push('did not parse')
  for (const [field, want] of Object.entries(expect)) {
    const got = r[field as 'leadId' | 'phone' | 'agent' | 'mix']
    if (got !== want) problems.push(`${field}: expected ${want}, got ${got}`)
  }

  const name = key.split('/').pop()
  if (problems.length === 0) {
    console.log(`ok    ${name}`)
    console.log(`        lead=${r.leadId ?? '—'} phone=${r.phone ?? '—'} agent=${r.agent ?? '—'} mix=${r.mix ?? '—'}`)
  } else {
    failures++
    console.log(`FAIL  ${name}`)
    problems.forEach((p) => console.log(`        ${p}`))
  }
}

// A filename with no timestamp should be reported as unparsed rather than
// guessed at, so the indexer can skip it and say so.
const junk = parseRecording('dialer/Closers_ACA/test.txt')
if (junk.parsed) {
  failures++
  console.log('FAIL  test.txt was treated as a recording')
} else {
  console.log('ok    test.txt correctly rejected')
}

console.log(failures === 0 ? '\nall cases passed' : `\n${failures} case(s) failed`)
process.exit(failures === 0 ? 0 : 1)
