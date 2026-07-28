/**
 * Diagnoses a failing sign-in against the database, without going through HTTP.
 *
 *   npx tsx --env-file=.env.local scripts/debug-login.ts <email> <password>
 */

import { verifyPassword } from '../lib/auth'
import { checkThrottle, db, getUser } from '../lib/db'

async function main() {
  const email = process.argv[2]
  const password = process.argv[3]

  const rows = await db().execute(
    'SELECT id, username, length(password_hash) AS hash_len, security_question IS NOT NULL AS has_q FROM users'
  )
  console.log(`accounts in database: ${rows.rows.length}`)
  for (const row of rows.rows) {
    const r = row as unknown as { id: number; username: string; hash_len: number; has_q: number }
    console.log(`  id=${r.id}  username="${r.username}"  hashLen=${r.hash_len}  question=${Number(r.has_q) === 1}`)
  }

  const blocks = await db().execute('SELECT ip, fails, strikes, blocked_until FROM login_attempts')
  console.log(`\nthrottle rows: ${blocks.rows.length}`)
  for (const row of blocks.rows) {
    const r = row as unknown as { ip: string; fails: number; strikes: number; blocked_until: number }
    const left = Number(r.blocked_until ?? 0) - Math.floor(Date.now() / 1000)
    console.log(`  ${r.ip}  fails=${r.fails} strikes=${r.strikes} ${left > 0 ? `blocked ${Math.ceil(left / 60)}min` : 'not blocked'}`)
  }

  if (!email || !password) return

  console.log(`\nlooking up "${email}"`)
  const user = await getUser(email)
  if (!user) {
    console.log('  getUser returned null — the lookup did not match any row')
    return
  }
  console.log(`  matched "${user.username}"`)
  console.log(`  password verifies: ${await verifyPassword(password, user.passwordHash)}`)
  console.log(`  throttle: ${JSON.stringify(await checkThrottle('::1'))}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
