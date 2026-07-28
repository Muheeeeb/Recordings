/**
 * Changes the login email, and optionally the password, for the single account.
 *
 *   npx tsx --env-file=.env.local scripts/set-user.ts <email> [password]
 *
 * With no account in the database yet, one is created. The password is only
 * touched when a second argument is given, so changing the email alone leaves
 * the existing password and security question in place.
 */

import { hashPassword } from '../lib/auth'
import { db, ensureSchema, normaliseUser } from '../lib/db'

async function main() {
  const email = process.argv[2]
  const password = process.argv[3]

  if (!email || !email.includes('@')) {
    console.error('Usage: npx tsx --env-file=.env.local scripts/set-user.ts <email> [password]')
    process.exit(1)
  }
  if (password && password.length < 10) {
    console.error('Password must be at least 10 characters.')
    process.exit(1)
  }

  await ensureSchema()
  const key = normaliseUser(email)

  const existing = await db().execute('SELECT id, username FROM users LIMIT 1')

  if (existing.rows.length === 0) {
    if (!password) {
      console.error('No account exists yet, so a password is required the first time.')
      process.exit(1)
    }
    await db().execute({
      sql: 'INSERT INTO users (username, password_hash, updated_at) VALUES (?, ?, ?)',
      args: [key, await hashPassword(password), Math.floor(Date.now() / 1000)],
    })
    console.log(`created account ${key}`)
  } else {
    const previous = String((existing.rows[0] as never)['username'])
    const id = Number((existing.rows[0] as never)['id'])

    if (password) {
      await db().execute({
        sql: 'UPDATE users SET username = ?, password_hash = ?, updated_at = ? WHERE id = ?',
        args: [key, await hashPassword(password), Math.floor(Date.now() / 1000), id],
      })
      console.log(`updated ${previous} -> ${key} (password changed)`)
    } else {
      await db().execute({
        sql: 'UPDATE users SET username = ?, updated_at = ? WHERE id = ?',
        args: [key, Math.floor(Date.now() / 1000), id],
      })
      console.log(`updated ${previous} -> ${key} (password unchanged)`)
    }
  }

  const check = await db().execute(
    'SELECT username, security_question IS NOT NULL AS has_q FROM users'
  )
  for (const row of check.rows) {
    const r = row as unknown as { username: string; has_q: number }
    console.log(`  account: ${r.username}   security question set: ${Number(r.has_q) === 1}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
