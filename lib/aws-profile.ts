/**
 * Reads a named profile out of ~/.aws/credentials.
 *
 * Why this is not left to the SDK's own credential chain: on the machine this
 * project is run from, the `default` profile is `dialer-uploader` — the
 * upload-only credential that was handed to the dialer vendor. So "fall back to
 * the default chain" does not mean "use the reader credential", it means "use
 * the vendor's key", which cannot read an object and should never be used from
 * here at all. A named profile makes the choice explicit instead of inherited.
 *
 * On a deployment there is no ~/.aws, so this returns null and the caller uses
 * the environment variables, which is how Vercel supplies credentials.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type AwsCredential = { accessKeyId: string; secretAccessKey: string }

export function readAwsProfile(name: string): AwsCredential | null {
  try {
    const file = process.env.AWS_SHARED_CREDENTIALS_FILE ?? join(homedir(), '.aws', 'credentials')
    if (!existsSync(file)) return null

    let section = ''
    const found: Record<string, string> = {}
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#') || line.startsWith(';')) continue
      const header = /^\[(.+)\]$/.exec(line)
      if (header) {
        section = header[1].trim()
        continue
      }
      if (section !== name) continue
      const kv = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line)
      if (kv) found[kv[1].toLowerCase()] = kv[2].trim()
    }

    const accessKeyId = found['aws_access_key_id']
    const secretAccessKey = found['aws_secret_access_key']
    return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null
  } catch {
    // An unreadable credentials file is not an error here — the caller falls
    // back to the environment.
    return null
  }
}
