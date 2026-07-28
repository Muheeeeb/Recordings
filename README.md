# Call recordings search

A private search tool over the call recordings the dialer uploads to S3.
Recordings stay in S3; this app keeps a small searchable index of their
filenames and streams the audio through short-lived signed links.

## How it fits together

```
dialer ──uploads──► S3  poshnee-call-recordings/dialer/<group>/<YYYYMMDD>/
                     │
                     │  filenames only (never the audio)
                     ▼
        GitHub Actions ──► Turso (SQLite index)
                                   │
   browser ──► Vercel app ─────────┘
                    └─ signs a 5-minute URL; audio streams S3 ► browser direct
```

The app never proxies audio, so playback costs no Vercel bandwidth.

## Filenames

```
20260726-004021_6026629_CLOSER2-all.mp3
│        │      │       │       └ mix type
│        │      │       └ agent
│        │      └ lead id (a customer phone number is expected here later)
│        └ time
└ date
```

`lib/parse.ts` identifies fields by shape rather than position, so adding the
customer number does not break it: 6–9 digits are read as a lead id, 10–11 as a
phone number. Both columns exist already and the search box queries both.

## Local development

```bash
npm install
cp .env.example .env.local     # then fill in the blanks
npm run dev
```

`ALLOWED_IPS` must be empty locally or the app will 404 your own machine.

AWS credentials come from the `reader` profile when no keys are in the
environment, so `aws configure --profile reader` is enough for local work:

```powershell
$env:AWS_PROFILE="reader"; npm run dev
```

## Scripts

| Command | Purpose |
|---|---|
| `npx tsx --env-file=.env.local scripts/migrate.ts` | Apply schema and backfills |
| `... scripts/index-recordings.ts` | Full reindex |
| `... scripts/index-recordings.ts --recent=3` | Only the newest folders |
| `... scripts/set-user.ts <email> [password]` | Change the login |
| `... scripts/unblock.ts [--clear-question]` | Recover from a lockout |
| `... scripts/verify-index.ts` | Row counts, query latency, index size |
| `... scripts/verify-keys.ts` | Confirm rebuilt S3 keys resolve |

Indexing scripts need `AWS_PROFILE=reader` (or explicit keys).

## Environment

| Variable | Notes |
|---|---|
| `ALLOWED_IPS` | Comma-separated CIDRs. Empty disables the check. Everything else gets a 404 |
| `SESSION_SECRET` | 32+ random characters. Changing it signs everyone out |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Search index |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | The `recordings-reader` user: list + read on `dialer/` only |
| `AWS_REGION` / `S3_BUCKET` / `S3_PREFIX` | `ap-south-1` / `poshnee-call-recordings` / `dialer/` |

`ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` only seed the very first login. Once
an account exists in the database they are ignored, so deployments do not need
them.

## Security model

- Requests from outside `ALLOWED_IPS` get a 404, not a 403 — a scanner cannot
  tell anything is hosted here.
- Login is two steps: password, then a security question. The password step
  issues a separate five-minute cookie that grants no access on its own.
- Three failed attempts block the IP for 5 minutes; every block after that is 30
  minutes. Both login steps share the counter, and it lives in the database
  because serverless instances share no memory.
- AWS keys never reach the browser. Playback URLs expire in five minutes, are
  scoped to a single object, and are only issued for keys already in the index.
- The upload credential the dialer uses is a different IAM user, with
  `PutObject` on `dialer/*` and nothing else.

## Scheduled sync

`.github/workflows/sync-index.yml` runs every six hours over the newest folders
and does a full reconcile on Sundays. The incremental pass keeps the index
current; the weekly full pass stops it drifting, since late uploads can land in
older folders.

Repository secrets required: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
