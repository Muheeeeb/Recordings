/**
 * Accounts and what each one is allowed to see.
 *
 * The owner account already existed as a single row seeded from
 * ADMIN_USERNAME / ADMIN_PASSWORD_HASH. This adds the two things a second
 * portal needs: a role, and — for QA accounts — the list of recording groups
 * that account may review.
 *
 * Both are managed from the admin UI rather than from env vars, because the
 * people who need to add a QA associate are not the people who can redeploy.
 */

import { asRole, db, normaliseUser, type Role } from './db'

const now = () => Math.floor(Date.now() / 1000)

/**
 * The role as it is right now, not as it was when the session was issued.
 *
 * The session cookie carries a role claim so the proxy can route without a
 * database round trip, but a session lasts eight hours — long enough for
 * someone to be demoted or switched off and keep working with the old claim.
 * So anything that returns an unmasked phone number asks this instead of
 * trusting the cookie. A disabled account has no role at all.
 */
export async function currentRole(username: string): Promise<Role | null> {
  const result = await db().execute({
    sql: 'SELECT role, disabled FROM users WHERE lower(username) = ? LIMIT 1',
    args: [normaliseUser(username)],
  })

  if (result.rows.length === 0) {
    // No row can still mean the env-seeded owner on a database where the users
    // table has not been written to yet.
    const seed = process.env.ADMIN_USERNAME
    return seed && normaliseUser(seed) === normaliseUser(username) ? 'admin' : null
  }

  const r = result.rows[0] as unknown as { role: string | null; disabled: number | null }
  if (Number(r.disabled ?? 0) === 1) return null
  return asRole(r.role)
}

export type UserRow = {
  username: string
  role: Role
  disabled: boolean
  updatedAt: number | null
  groups: string[]
}

export async function listUsers(): Promise<UserRow[]> {
  const [users, grants] = await Promise.all([
    db().execute(
      'SELECT username, role, disabled, updated_at FROM users ORDER BY role, lower(username)'
    ),
    db().execute(
      `SELECT ug.username AS username, g.name AS name
       FROM user_groups ug JOIN groups g ON g.id = ug.g
       ORDER BY g.name`
    ),
  ])

  const byUser = new Map<string, string[]>()
  for (const row of grants.rows as unknown as { username: string; name: string }[]) {
    const key = normaliseUser(String(row.username))
    const list = byUser.get(key) ?? []
    list.push(String(row.name))
    byUser.set(key, list)
  }

  return users.rows.map((row) => {
    const r = row as unknown as {
      username: string
      role: string | null
      disabled: number | null
      updated_at: number | null
    }
    const username = String(r.username)
    return {
      username,
      role: asRole(r.role),
      disabled: Number(r.disabled ?? 0) === 1,
      updatedAt: r.updated_at === null ? null : Number(r.updated_at),
      groups: byUser.get(normaliseUser(username)) ?? [],
    }
  })
}

/** Returns false when the username is already taken, rather than overwriting it. */
export async function createUser(
  username: string,
  passwordHash: string,
  role: Role
): Promise<boolean> {
  const result = await db().execute({
    sql: `INSERT INTO users (username, password_hash, role, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (username) DO NOTHING`,
    args: [username.trim(), passwordHash, role, now()],
  })
  return Number(result.rowsAffected ?? 0) > 0
}

/**
 * Access is withdrawn by disabling, never by deleting.
 *
 * An account that has listened to customer calls has to stay in the activity
 * log under its own name, so removing access must not remove the account.
 */
export async function setUserDisabled(username: string, disabled: boolean): Promise<void> {
  await db().execute({
    sql: 'UPDATE users SET disabled = ?, updated_at = ? WHERE lower(username) = ?',
    args: [disabled ? 1 : 0, now(), normaliseUser(username)],
  })
}

export async function setUserRole(username: string, role: Role): Promise<void> {
  await db().execute({
    sql: 'UPDATE users SET role = ?, updated_at = ? WHERE lower(username) = ?',
    args: [role, now(), normaliseUser(username)],
  })
}

/**
 * The group names this user may review.
 *
 * An empty list means nothing, not everything. A QA account is therefore
 * useless until an admin grants it something, which is the safe direction for
 * an account whose whole purpose is listening to customer calls.
 */
export async function getUserGroups(username: string): Promise<string[]> {
  const result = await db().execute({
    sql: `SELECT g.name AS name FROM user_groups ug
          JOIN groups g ON g.id = ug.g
          WHERE lower(ug.username) = ? ORDER BY g.name`,
    args: [normaliseUser(username)],
  })
  return result.rows.map((r) => String((r as unknown as { name: string }).name))
}

/**
 * Replaces the whole grant list in one transaction.
 *
 * Names that are not real groups are dropped rather than stored, so a typo or
 * a renamed folder cannot leave behind a grant that silently matches nothing
 * and looks like access the person does not have. The accepted list is
 * returned so the caller can show what was actually saved.
 */
export async function setUserGroups(username: string, groups: string[]): Promise<string[]> {
  const key = normaliseUser(username)
  const known = await db().execute('SELECT id, name FROM groups')
  const ids = new Map(
    known.rows.map((r) => {
      const row = r as unknown as { id: number; name: string }
      return [String(row.name), Number(row.id)]
    })
  )

  const wanted = [...new Set(groups)].filter((name) => ids.has(name))
  const statements: { sql: string; args: (string | number)[] }[] = [
    { sql: 'DELETE FROM user_groups WHERE lower(username) = ?', args: [key] },
  ]
  for (const name of wanted) {
    statements.push({
      sql: 'INSERT INTO user_groups (username, g) VALUES (?, ?) ON CONFLICT DO NOTHING',
      args: [key, ids.get(name)!],
    })
  }

  await db().batch(statements, 'write')
  return wanted
}
