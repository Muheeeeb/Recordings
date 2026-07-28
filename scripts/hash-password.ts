/**
 * Turns a plaintext password into the salted hash stored in
 * ADMIN_PASSWORD_HASH. The plaintext never touches the repo or the server.
 *
 *   npx tsx scripts/hash-password.ts "the-password"
 */

import { hashPassword } from '../lib/auth'

const password = process.argv[2]

if (!password) {
  console.error('Usage: npx tsx scripts/hash-password.ts "<password>"')
  process.exit(1)
}

if (password.length < 12) {
  console.error('Please choose a password of at least 12 characters.')
  process.exit(1)
}

hashPassword(password).then((hash) => {
  console.log('\nAdd this to your environment as ADMIN_PASSWORD_HASH:\n')
  console.log(hash)
  console.log()
})
