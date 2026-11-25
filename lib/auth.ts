/**
 * Session tokens and password verification.
 *
 * Everything here uses Web Crypto and jose so the same code runs in the Edge
 * middleware and in Node route handlers.
 */

import { SignJWT, jwtVerify } from 'jose'
// Type-only, so nothing from the database layer is pulled into the Edge bundle
// that runs the proxy.
import type { Role } from './db'

export const SESSION_COOKIE = 'rec_session'
/**
 * The password step issues this separate short-lived cookie instead of a
 * half-privileged session. Keeping the two in different cookies means no route
 * can accidentally treat a half-finished login as a real one.
 */
export const CHALLENGE_COOKIE = 'rec_challenge'
const SESSION_HOURS = 8
const CHALLENGE_MINUTES = 5
const PBKDF2_ITERATIONS = 210_000

function secretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters')
  }
  return new TextEncoder().encode(secret)
}

/**
 * The role travels in the token so the proxy can decide which portal a request
 * belongs to without a database round trip — the proxy runs on every request,
 * including every Range request while audio plays.
 *
 * It is a routing hint and nothing more. A session lasts eight hours, which is
 * long enough for an account to be demoted or switched off, so every handler
 * that returns an unmasked phone number re-reads the role from the database
 * (currentRole in lib/users.ts) instead of trusting this claim.
 */
export async function createSession(username: string, role: Role): Promise<string> {
  return new SignJWT({ sub: username, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setAudience('session')
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(secretKey())
}

export type SessionClaims = { username: string; role: Role }

export async function readSessionClaims(
  token: string | undefined
): Promise<SessionClaims | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      algorithms: ['HS256'],
      audience: 'session',
    })
    if (typeof payload.sub !== 'string') return null
    // A token issued before the role claim existed is read as 'admin', which is
    // what its holder already had. Only the owner account can be in that state,
    // because QA accounts did not exist before the claim did.
    return { username: payload.sub, role: payload.role === 'qa' ? 'qa' : 'admin' }
  } catch {
    return null
  }
}

export async function readSession(token: string | undefined): Promise<string | null> {
  return (await readSessionClaims(token))?.username ?? null
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_HOURS * 60 * 60,
}

export const challengeCookieOptions = {
  ...sessionCookieOptions,
  maxAge: CHALLENGE_MINUTES * 60,
}

/** Signed with a distinct audience so it can never be replayed as a session. */
export async function createChallenge(username: string): Promise<string> {
  return new SignJWT({ sub: username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setAudience('challenge')
    .setExpirationTime(`${CHALLENGE_MINUTES}m`)
    .sign(secretKey())
}

export async function readChallenge(token: string | undefined): Promise<string | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      algorithms: ['HS256'],
      audience: 'challenge',
    })
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

function toBase64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
}

async function derive(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  )
  return toBase64(bits)
}

/** Produces the `salt:hash` string stored in ADMIN_PASSWORD_HASH. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(password, salt)
  return `${toBase64(salt.buffer as ArrayBuffer)}:${hash}`
}

/** Constant-time comparison so failures do not leak timing information. */
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltPart, hashPart] = stored.split(':')
  if (!saltPart || !hashPart) return false
  const salt = Uint8Array.from(atob(saltPart), (c) => c.charCodeAt(0))
  return equal(await derive(password, salt), hashPart)
}

/**
 * Security answers are compared loosely on case and spacing — nobody should be
 * locked out for typing "Karachi " instead of "karachi" — but the value itself
 * is still salted and hashed exactly like a password.
 */
const normaliseAnswer = (answer: string) => answer.trim().toLowerCase().replace(/\s+/g, ' ')

export const hashAnswer = (answer: string) => hashPassword(normaliseAnswer(answer))

export const verifyAnswer = (answer: string, stored: string) =>
  verifyPassword(normaliseAnswer(answer), stored)
