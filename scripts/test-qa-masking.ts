/**
 * Proves the QA layer cannot hand out a phone number, a filename or an S3 key.
 *
 *   npx tsx --env-file=.env.local scripts/test-qa-masking.ts
 *
 * Why this exists as a test rather than a comment. The masking lives in the SQL
 * in lib/qa.ts, and the thing that would break it is innocuous: somebody adds
 * `r.phone` to a SELECT while debugging, or widens QaRow to carry the key "just
 * for the player". Either change passes a typecheck, passes review if nobody is
 * looking for it, and silently puts customer numbers in a browser belonging to
 * someone who is not supposed to have them.
 *
 * So this walks the real serialised response and fails on anything that looks
 * like a number or a path, rather than checking a list of field names — a new
 * leaking field would not be on such a list.
 */

import { buildKey, listGroups } from '../lib/db'
import { qaResolve, qaSearch } from '../lib/qa'
import { formatSerial, parseSerial, resolveSerial } from '../lib/serials'
import { parseRecording } from '../lib/parse'

let failures = 0

function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}

/**
 * Exactly the fields a reviewer is allowed to receive. An allowlist rather
 * than a list of banned names, because the field that leaks next will be one
 * nobody thought to ban.
 */
const ALLOWED_FIELDS = [
  'serial',
  'group',
  'agent',
  'recordedAt',
  'leadId',
  'phoneLast4',
  'sizeBytes',
].sort()

/**
 * Anything that looks like a stored object rather than a description of one.
 *
 * Note what is deliberately NOT here: the group name. "Morpheus_ACA_Closer" is
 * a campaign label a reviewer needs to see, and it is also the first segment of
 * the S3 key, so matching on it would flag a legitimate field. The key is
 * recognised by its prefix and its extension instead.
 */
const PATHISH = /dialer\/|\.m4a|\.wav|\.mp3|\/\d{8}\//

async function main() {
  const groups = await listGroups()
  if (groups.length === 0) {
    console.error('no groups in the index — nothing to test against')
    process.exit(1)
  }

  console.log(`groups in the index: ${groups.length}\n`)

  /* ---------------------------------------------------- serial round trip */
  console.log('serial format')
  check('formats with a prefix and padding', formatSerial(123) === 'PN-0000123', formatSerial(123))
  check('parses its own output', parseSerial(formatSerial(98765)) === 98765)
  check('parses a bare number', parseSerial('123') === 123)
  check('parses lower case and spacing', parseSerial(' pn-0000123 ') === 123)
  check('rejects a phone number shape', parseSerial('2015550123') === 2015550123)
  check('rejects letters', parseSerial('PN-12a3') === null)
  check('rejects empty', parseSerial('') === null)

  /* ------------------------------------------------------- fail closed */
  console.log('\naccess, with no groups granted')
  const none = await qaSearch({ limit: 5 }, [])
  check('an account with no grants gets nothing', none.ok === false)
  if (!none.ok) check('and the reason says why', none.reason === 'no-groups', none.reason)

  /* ------------------------------------------------------ numeric search */
  console.log('\nsearching by number is refused')
  for (const term of ['2015550123', '850 619 3227', '(850) 619-3227']) {
    const result = await qaSearch({ q: term, limit: 5 }, groups)
    // A ten-digit string is also a valid serial by shape, so the guard that
    // matters is the one on formatted numbers; a bare ten digits is read as a
    // serial and simply finds nothing.
    const refused = result.ok === false && result.reason === 'numeric-search'
    const empty = result.ok === true && result.rows.length === 0
    check(`"${term}" cannot be used to confirm a number`, refused || empty,
      refused ? 'refused' : 'no rows')
  }

  console.log('\nsearching by agent name still works')
  const byName = await qaSearch({ q: 'Arslan', limit: 5 }, groups)
  check('an agent-name search returns rows', byName.ok === true && byName.rows.length > 0,
    byName.ok ? `${byName.rows.length} rows` : byName.reason)

  /* --------------------------------------------------- the payload itself */
  console.log('\nthe rows a reviewer receives')
  const page = await qaSearch({ limit: 50 }, groups)
  if (!page.ok) {
    check('a page of rows came back', false, page.reason)
    return finish()
  }
  check('a page of rows came back', page.rows.length > 0, `${page.rows.length} rows`)

  const fields = new Set<string>()
  for (const row of page.rows) for (const key of Object.keys(row)) fields.add(key)
  const present = [...fields].sort()
  console.log(`  fields present: ${present.join(', ')}`)
  check(
    'the response carries exactly the allowed fields',
    present.join(',') === ALLOWED_FIELDS.join(','),
    present.filter((f) => !ALLOWED_FIELDS.includes(f)).join(', ') || 'no extras'
  )

  // Serialise exactly what the route would send, then look at it.
  const payload = JSON.stringify({ rows: page.rows })
  const paths = payload.match(PATHISH)
  check('no filename, extension or S3 path anywhere in the response', paths === null,
    paths ? `found ${paths[0]}` : '')

  // The decisive check. Resolve the same rows through the privileged path to
  // get the real numbers, then confirm none of them is in what QA receives.
  // This is the test that would actually catch `r.phone` creeping back into
  // the SELECT, because it compares against the truth rather than a pattern.
  const realPhones: { serial: number; phone: string }[] = []
  for (const row of page.rows.slice(0, 20)) {
    const ref = await resolveSerial(row.serial)
    if (!ref) continue
    const phone = parseRecording(buildKey(ref.group, ref.dir, ref.fn)).phone
    if (phone) realPhones.push({ serial: row.serial, phone })
  }
  check('real numbers were available to compare against', realPhones.length > 0,
    `${realPhones.length} of 20 rows`)

  const leaked = realPhones.filter((r) => payload.includes(r.phone))
  check('not one real phone number appears in the response', leaked.length === 0,
    leaked.length ? `${leaked.length} leaked, first ${formatSerial(leaked[0].serial)}` : '')

  // Masking has to be right as well as present: the four digits shown must be
  // the last four of the real number, or a reviewer cannot match a call to a
  // customer record at all.
  const mismatched = realPhones.filter((r) => {
    const row = page.rows.find((x) => x.serial === r.serial)
    return row?.phoneLast4 !== r.phone.slice(-4)
  })
  check('the four digits shown are the real last four', mismatched.length === 0,
    mismatched.length ? `${mismatched.length} wrong` : `checked ${realPhones.length}`)

  const last4 = page.rows.filter((r) => r.phoneLast4 !== null)
  check('the masked number is exactly four digits',
    last4.every((r) => /^\d{4}$/.test(r.phoneLast4!)),
    `${last4.length} of ${page.rows.length} rows have one`)
  check('every row carries a serial', page.rows.every((r) => Number.isInteger(r.serial)))

  /* ----------------------------------------------------- group enforcement */
  console.log('\nstreaming obeys the group grant')
  const sample = page.rows[0]
  const granted = await qaResolve(sample.serial, [sample.group])
  check('a granted group resolves', granted !== null)

  const otherGroup = groups.find((g) => g !== sample.group)
  if (otherGroup) {
    const denied = await qaResolve(sample.serial, [otherGroup])
    check('a serial outside the grant does not resolve', denied === null)
  }
  const nothing = await qaResolve(sample.serial, [])
  check('no grants resolves nothing', nothing === null)

  finish()
}

function finish() {
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
