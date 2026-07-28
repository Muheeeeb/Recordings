/**
 * Recovery tool for being locked out.
 *
 *   npx tsx --env-file=.env.local scripts/unblock.ts              clear all IP blocks
 *   npx tsx --env-file=.env.local scripts/unblock.ts --clear-question
 *
 * Clearing the question turns the second login step off until a new one is set,
 * which is the way back in if the answer is forgotten. It needs database access,
 * so it is not something a visitor to the site could reach.
 */

import { db, ensureSchema } from '../lib/db'

async function main() {
  await ensureSchema()

  const blocks = await db().execute('SELECT ip, strikes, blocked_until FROM login_attempts')
  if (blocks.rows.length === 0) {
    console.log('no IP blocks recorded')
  } else {
    for (const row of blocks.rows) {
      const r = row as unknown as { ip: string; strikes: number; blocked_until: number | null }
      const left = Number(r.blocked_until ?? 0) - Math.floor(Date.now() / 1000)
      console.log(
        `  ${r.ip}  strikes=${r.strikes}  ${left > 0 ? `blocked for ${Math.ceil(left / 60)} more min` : 'not blocked'}`
      )
    }
    await db().execute('DELETE FROM login_attempts')
    console.log(`cleared ${blocks.rows.length} entr${blocks.rows.length === 1 ? 'y' : 'ies'}`)
  }

  if (process.argv.includes('--clear-question')) {
    await db().execute(
      'UPDATE users SET security_question = NULL, security_answer_hash = NULL'
    )
    console.log('security question cleared — sign-in now asks for the password only')
  }

  const users = await db().execute(
    'SELECT username, security_question IS NOT NULL AS has_q FROM users'
  )
  for (const row of users.rows) {
    const r = row as unknown as { username: string; has_q: number }
    console.log(`account: ${r.username}   security question set: ${Number(r.has_q) === 1}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
