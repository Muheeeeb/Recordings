/**
 * The QA portal's only source of rows.
 *
 * Everything it can return is defined by QaRow in lib/qa.ts, which has no field
 * for a key, a filename or a full phone number — so there is nothing here to
 * forget to strip. The masking is in the SQL, not in this handler.
 */

import { qaGroups, qaSearch } from '@/lib/qa'
import { getUserGroups } from '@/lib/users'
import { listGroups } from '@/lib/db'
import { parseSerial } from '@/lib/serials'
import { logActivity } from '@/lib/activity'
import { requireReviewer, requestOrigin } from '@/lib/guard'

const number = (raw: string | null): number | undefined => {
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

export async function GET(request: Request) {
  const guard = await requireReviewer()
  if (!guard.ok) return guard.response

  // An admin opening the QA portal sees every group, so the masking can be
  // checked against real data without granting the admin account to itself.
  const allowed =
    guard.role === 'admin' ? await listGroups() : await getUserGroups(guard.username)

  const params = new URL(request.url).searchParams
  const q = (params.get('q') ?? '').trim()

  const result = await qaSearch(
    {
      q,
      group: params.get('group') ?? undefined,
      from: number(params.get('from')),
      to: number(params.get('to')),
      limit: number(params.get('limit')),
      offset: number(params.get('offset')),
    },
    allowed
  )

  if (!result.ok) {
    if (result.reason === 'numeric-search') {
      return Response.json(
        {
          error:
            'Numbers cannot be searched here. Enter a serial such as PN-0000123, or an agent name.',
          rows: [],
          groups: await qaGroups(allowed),
        },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      )
    }
    return Response.json(
      {
        error:
          result.reason === 'no-groups'
            ? 'No recording groups have been assigned to this account yet. Ask an admin to grant access.'
            : 'You do not have access to those recordings.',
        rows: [],
        groups: result.reason === 'no-groups' ? [] : await qaGroups(allowed),
      },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    )
  }

  // Searches are logged, browsing is not: a page of the newest recordings says
  // nothing about intent, while "what did this person look for" is exactly the
  // question the log exists to answer.
  if (q) {
    const { ip, ua } = await requestOrigin()
    await logActivity({
      username: guard.username,
      role: guard.role,
      action: 'search',
      serial: parseSerial(q) ?? null,
      detail: q.slice(0, 120),
      ip,
      ua,
    })
  }

  return Response.json(
    { rows: result.rows, groups: await qaGroups(allowed) },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
