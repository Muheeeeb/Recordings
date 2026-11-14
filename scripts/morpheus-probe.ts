/**
 * First contact with the Morpheus API.
 *
 * The docs leave several things unstated — the shape of `from`/`to`, what
 * `download_url` looks like, which campaign names exist — so this asks the API
 * directly rather than building against guesses.
 *
 *   npx tsx --env-file=.env.local scripts/morpheus-probe.ts
 */

const HOST = process.env.MORPHEUS_HOST
const KEY = process.env.MORPHEUS_API_KEY
if (!HOST || !KEY) throw new Error('MORPHEUS_HOST / MORPHEUS_API_KEY not set')

const BASE = `https://${HOST}/api/v1/call-control`

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-API-Key': KEY!, Accept: 'application/json' },
  })
  const text = await res.text()
  return { status: res.status, text }
}

async function main() {
  console.log(`base: ${BASE}\n`)

  const r = await get('/recordings?limit=3')
  console.log(`GET /recordings?limit=3  ->  ${r.status}`)

  if (r.status !== 200) {
    console.log(r.text.slice(0, 600))
    return
  }

  const body = JSON.parse(r.text)
  const list = body.recordings ?? body.data ?? body
  console.log(`top-level keys: ${Object.keys(body).join(', ')}`)
  console.log(`recordings returned: ${Array.isArray(list) ? list.length : 'not an array'}\n`)

  if (Array.isArray(list) && list.length > 0) {
    console.log('fields present on the first record:')
    for (const [k, v] of Object.entries(list[0])) {
      const shown = typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '…' : v
      console.log(`   ${k.padEnd(20)} ${JSON.stringify(shown)}`)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })

// Keeps this file a module so its top-level names stay file-scoped.
export {}
