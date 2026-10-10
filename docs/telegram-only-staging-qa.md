# Telegram-only Staging QA policy

Scope: Telegram market rooms, holdings, auto-trading alerts, formatting,
six-room routing, owner binding, Bot API network checks, and Telegram safety.

**Default for Telegram work:** run `.github/workflows/telegram-only-staging-qa.yml`.
Do not substitute `Staging Readiness` (the full-application, four-user browser
release gate) for ordinary Telegram-only diagnostics. Conversely, **the
Telegram-only lane does not replace or weaken mandatory application, security,
database/RLS, privacy or release-wide Staging gates when Production policy
requires them.** The full-application gate retains its existing settings.

## Two independent evidence levels

1. **Pull request / no secrets:** `pnpm --dir api-server test:telegram`
   runs 11 Telegram-only service tests, plus Telegram six-room and Vault
   contract tests. No application-wide Playwright suite, app deployment,
   private provider calls, Bot API send methods or real orders.
2. **Owner-controlled, isolated Staging server / read-only:** once merged to
   exact current `main`, use the canonical Release Control issue #1555:

   `/run-telegram-staging-qa <40-character-current-main-sha>`

   The job uses only the protected `staging` environment and the
   `STAGING_SSH_*` secrets. It inspects only PM2 process
   `seungjae-staging` and its deploy marker under
   `/srv/seungjae-staging`. The live app SHA is checked against its fixed
   direct-loopback `http://127.0.0.1:18083/api/health`, because the Staging
   launcher uses `node --env-file=.env.staging` and therefore PM2 supervisor
   environment metadata may not expose `DEPLOY_SHA`. Full health bodies are
   never published; only sanitized revision and boolean identity fields are
   retained. The job then performs a token-free IPv4 DNS/TLS 443 handshake
   with `api.telegram.org`. A stale live Staging SHA, offline PM2, inconsistent
   health/marker revision or blocked TLS route produces a failed job, with a
   sanitized receipt on #1555.
   **No Staging deployment is performed by this QA.**

This stage check proves **network reachability only**: a TLS handshake is
not proof of a valid Telegram token, access to six rooms, Bot API permissions
or actual message delivery. Production's six-room read-only inspection and
separately authorized Telegram-only delivery receipts remain necessary.

## Prohibited operations in this workflow

- Replit or any Replit deployment.
- Production credentials, production SSH, production processes, or Production deploy.
- Staging deploy, restart, PM2 save, database/Vault/env writes or webhook changes.
- Bot API `sendMessage`, `setWebhook`, or other posting/editing calls.
- Live trading, real orders, financial mutations, or unapproved release gates.
- Publishing bot tokens, chat IDs, owner UUIDs, Telegram response bodies,
  private network addresses, or raw exceptions.

Only GitHub-protected owners can request the isolated Staging job. Never
interpret a green scoped contract test as live six-room operational success.
