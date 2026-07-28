/**
 * Exercises the block escalation without waiting out a real block: the first
 * block's expiry is rolled back so the second round of failures lands as a
 * repeat offence.
 *
 *   npx tsx --env-file=.env.local scripts/test-throttle.ts
 */

import { checkThrottle, clearFailures, db, ensureSchema, recordFailure } from '../lib/db'

const IP = '203.0.113.99' // TEST-NET-3, never a real client

async function state() {
  const r = await db().execute({
    sql: 'SELECT fails, strikes, blocked_until FROM login_attempts WHERE ip = ?',
    args: [IP],
  })
  const row = r.rows[0] as unknown as { fails: number; strikes: number; blocked_until: number } | undefined
  if (!row) return 'no row'
  const left = Number(row.blocked_until ?? 0) - Math.floor(Date.now() / 1000)
  return `fails=${row.fails} strikes=${row.strikes} blockedFor=${left > 0 ? Math.round(left / 60) + 'min' : 'not blocked'}`
}

async function main() {
  await ensureSchema()
  await clearFailures(IP)

  console.log('ROUND 1 — first offence should give the short block')
  for (let i = 1; i <= 3; i++) {
    const r = await recordFailure(IP)
    console.log(`  fail ${i}: blocked=${r.blocked} retryAfter=${Math.round(r.retryAfter / 60)}min remaining=${r.remaining}`)
  }
  console.log('  state:', await state())

  // Pretend the 5 minutes elapsed, leaving the strike on record.
  await db().execute({
    sql: 'UPDATE login_attempts SET blocked_until = ? WHERE ip = ?',
    args: [Math.floor(Date.now() / 1000) - 1, IP],
  })
  console.log('\n  (block expired)', await state())
  console.log('  checkThrottle says blocked:', (await checkThrottle(IP)).blocked)

  console.log('\nROUND 2 — repeat offence should give the long block')
  for (let i = 1; i <= 3; i++) {
    const r = await recordFailure(IP)
    console.log(`  fail ${i}: blocked=${r.blocked} retryAfter=${Math.round(r.retryAfter / 60)}min remaining=${r.remaining}`)
  }
  console.log('  state:', await state())

  await clearFailures(IP)
  console.log('\ncleaned up test ip:', await state())
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
