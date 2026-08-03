# Phase 10 staging readiness and production approval gates

## Purpose

Phase 10 prepares an isolated staging environment and gathers evidence for a later production decision.

A successful staging run does **not** grant production approval. This workflow never deploys production, changes the production database, enables real trading, or touches `/opt/stock-app` or the `stock-app` PM2 process.

## Two-step staging procedure

The workflow now defaults to `action=preflight`.

1. **Preflight only**
   - validates the exact SHA;
   - reports every missing or invalid setting name in one run;
   - does not connect to the staging server;
   - does not change files, PM2, the app, or any database.
2. **Non-destructive deploy**
   - runs only when `action=deploy`;
   - starts only after the same aggregate preflight passes;
   - uses `/srv/seungjae-staging`, `seungjae-staging`, port `18080`, and canary port `18082`;
   - performs build, canary health, backup, promotion, live health, and automatic rollback on failure.

`run_full_validation` and `run_destructive_recovery_drill` are separate opt-in scopes. Both default to `false`.

## Settings by scope

| Setting | Required for | Where the value comes from |
|---|---|---|
| `STAGING_SSH_HOST` | Preflight and deploy | Staging server public IP: `158.247.235.32` |
| `STAGING_SSH_USER` | Preflight and deploy | SSH login user: `root` |
| `STAGING_SSH_PRIVATE_KEY` | Preflight and deploy | The private half of the SSH key whose public half is in `/root/.ssh/authorized_keys` on the staging server |
| `STAGING_BASE_URL` | Preflight and deploy | The dedicated HTTPS URL routed to staging port `18080`; it must not be `https://lsj119.duckdns.org` |
| `STAGING_SSH_PORT` | Optional | SSH daemon port; omit to use `22` |
| `STAGING_SSH_KNOWN_HOSTS` | Optional | Output of `ssh-keyscan -H -p <port> 158.247.235.32`; when omitted, the workflow scans the host during the run |
| `STAGING_SUPABASE_URL` | Full account/browser validation | URL of the staging-only Supabase project |
| `STAGING_SUPABASE_ANON_KEY` | Full account/browser validation | Publishable anon key from the staging-only Supabase project |
| `STAGING_SUPABASE_SECRET_KEY` | Full account/browser validation | Server secret/service-role key from the staging-only Supabase project |
| `STAGING_PENDING_EMAIL` / `PASSWORD` | Full account/browser validation | Real staging account in pending state |
| `STAGING_ASSOCIATE_EMAIL` / `PASSWORD` | Full account/browser validation | Real approved associate staging account |
| `STAGING_REGULAR_EMAIL` / `PASSWORD` | Full account/browser validation | Real approved regular staging account |
| `STAGING_ADMIN_EMAIL` / `PASSWORD` | Full account/browser validation | Real staging admin account |
| `STAGING_DATABASE_URL` | Explicit DB migration/recovery drill only | PostgreSQL URL for an isolated staging database; never production |
| `STAGING_AI_API_KEY` | Not required by current readiness workflow | Optional future external-provider validation only; current readiness tests intentionally require no external AI call |

All private keys, passwords, database URLs, and API keys belong only in GitHub **Environment → staging → Environment secrets**. They must not be pasted into chat, committed, printed, or stored in workflow artifacts.

## Why DB, AI, and accounts are not minimal deploy requirements

The API process and `/api/health` start without a database migration URL or external AI key. The runtime database integration used by authentication is Supabase and is lazy: missing Supabase values make authenticated routes return an honest configuration error, but do not prevent the health-only minimal deployment from starting.

The four account pairs are consumed only by `phase10-staging-readiness.spec.ts`, so they are required only when `run_full_validation=true`.

`STAGING_DATABASE_URL` is consumed by the explicit `verify-phase8-db.sh` migration/rollback drill. It is therefore required only when `run_destructive_recovery_drill=true`.

The current full browser suite verifies that the privacy-safe AI path does not place orders and does not require an external provider call. `STAGING_AI_API_KEY` is not a readiness prerequisite.

## Runtime environment handling

The frontend build receives only the staging Supabase URL and publishable anon key when full configuration is present.

The backend receives a mode-`600` `.env.staging` containing staging-only runtime values. PM2 starts or reloads `seungjae-staging` with Node's `--env-file=.env.staging`, so the protected file is actually loaded by the live process. Release directories do not retain copied secret files.

## Production gate

Production remains manual-only. A production request must provide an exact 40-character SHA contained in `main` and all six required successful CI contexts with a matching successful `Application CI` push run on `main`.

The final verdict remains:

```text
운영 배포 승인 보류
```
