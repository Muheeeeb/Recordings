import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

/**
 * Reports whether the deployment is configured correctly.
 *
 * A misconfigured environment variable surfaces to the user as a generic
 * "Server error", which says nothing about which one. This reports the shape of
 * each value — never the value itself — and actually exercises the database so
 * a bad token shows up as the driver's own message.
 *
 * It needs no session on purpose: when sign-in is the thing that is broken,
 * an endpoint behind sign-in cannot help. The IP allowlist still applies.
 */

function shape(name: string) {
  const value = process.env[name]
  if (value === undefined) return { set: false }
  return {
    set: true,
    length: value.length,
    // The usual paste mistakes: a trailing newline or a wrapping quote.
    trailingWhitespace: value !== value.trim(),
    quoted: /^["'].*["']$/.test(value),
  }
}

export async function GET() {
  const config = {
    TURSO_DATABASE_URL: shape('TURSO_DATABASE_URL'),
    TURSO_AUTH_TOKEN: shape('TURSO_AUTH_TOKEN'),
    SESSION_SECRET: shape('SESSION_SECRET'),
    AWS_ACCESS_KEY_ID: shape('AWS_ACCESS_KEY_ID'),
    AWS_SECRET_ACCESS_KEY: shape('AWS_SECRET_ACCESS_KEY'),
    ALLOWED_IPS: shape('ALLOWED_IPS'),
    GITHUB_TOKEN: shape('GITHUB_TOKEN'),
  }

  let database: { ok: boolean; error?: string; recordings?: number } = { ok: false }
  try {
    const result = await db().execute('SELECT count(*) AS n FROM recordings')
    database = { ok: true, recordings: Number((result.rows[0] as never)['n']) }
  } catch (error) {
    database = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  return NextResponse.json({ config, database }, { status: database.ok ? 200 : 503 })
}
