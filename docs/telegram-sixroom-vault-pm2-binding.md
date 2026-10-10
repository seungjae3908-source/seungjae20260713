# Telegram six-room Vault → Production PM2 binding

## Why this is needed

Owner-protected Run #37930749251 obtained Bot API **SENT_CONFIRMED 6/6**
through the canonical encrypted Vault. That proof does **not** show the
automatic Telegram intelligence and owner holdings workers have usable room
destinations.

Owner-protected read-only Run #37932611221 then found:

- PM2 stock-app online, deploy marker and PM2 SHA both
  `801cd4553ec03d911b77455b5514da7ffb59b933`.
- Core bot config and Telegram activation/worker flags present.
- Vault valid, but PM2 missing the **five** dedicated market/holdings IDs
  and `TELEGRAM_OWNER_MEMBER_ID`. Existing AUTO room remains configured.
- No missing keys discovered in fixed server env files.
- Classification `SIX_ROOM_CONFIG_MISSING`, not six-room delivery-ready.

The deployed code reads market room IDs and the owner holdings room from
`process.env`. To make those workers functional, the running process
must receive the **exact** approved Vault room bindings. An isolated, one-shot
test-send through Vault does not itself accomplish this.

## Protected PLAN / APPLY

After this PR is merged into current main, the repository owner may comment
on canonical Release Control issue **#1555**:

`/run-telegram-sixroom-binding-plan <exact-main-sha> <actual-deployed-sha>`

The PLAN uses protected `production` secrets and SSH, only
`SELECT`s the two approved Vault secrets, reads one PM2 stock-app state
and deploy marker, and emits a **sanitized** status. This mode NEVER restarts
PM2, saves configuration, sends to Telegram, modifies the database or touches
any trading/API settings.

An APPLY is **separately owner-authorized** with a different exact comment:

`/run-telegram-sixroom-binding-apply <exact-main-sha> <actual-deployed-sha>`

Even that command requires all of the following:

- The GitHub `production` protected environment owner review.
- Exact current `main` and official Required CI **6/6 SUCCESS**.
- A recent, successful owner-protected **Telegram-only Staging** result for
  that exact main with Staging runtime/marker and IPv4/TLS ready. The protected Staging receipt must additionally name the actual running
  Node app SHA, marker SHA and authenticated health identity matching the
  exact current main. The Staging health-provenance fix is separately owned
  by Draft PR #1763 and must reach main before a binding APPLY can qualify.
  A merely reachable or stale Staging instance is not sufficient. No full-app staging
  protection is disabled.
- One unambiguous, online `stock-app`, canonical Production cwd/entrypoint,
  no PM2 watch and deploy SHA = marker = specifically approved deployed SHA.
- Valid encrypted Vault six-room values (strict distinct supergroup IDs) and
  canonical approved owner membership. AUTO room must already match Vault.
- No conflicting, nonempty room env values; only the missing approved keys
  can be filled.
- **All trading/live/provider order gates OFF** and
  `executionAuthority=NONE`. Any live authority blocks the action.
- Existing bot token and Telegram activation flags verified before any
  runtime change. A globally disabled `BACKGROUND_WORKERS_ENABLED=false`
  explicitly blocks binding, and its value must remain unchanged through
  the PM2 restart. The API defaults background workers to enabled when
  this flag is absent; a missing value is not proof of an actual worker tick.
- Alternate `LIVE_TRADING_ENABLED` / `AUTO_TRADING_ENABLED`, provider order
  permissions, transfer and withdrawal switches are also prohibited from
  being enabled during a Telegram-only bind.

If every condition passes, APPLY attempts **one PM2 restart with only the
approved missing room IDs/owner UUID**. It then checks new PM2 environment,
unchanged trading and Telegram feature flags, unchanged deploy SHA and
direct-loopback app health, and saves PM2 only after verification.
If any post-restart check fails, it attempts a single rollback to the
previous binding values and verifies whether rollback succeeded. An
ambiguous outcome **fails closed**; there is no retry-to-pass.

The APPLY restart touches the existing Production API process and can cause
brief downtime and start existing *real Telegram notification workers*. It
does not grant financial order authority and sends **no test messages**.
This is a production configuration change, not a harmless read-only check:
**do not invoke it without the owner's explicit approval.**

## Confidentiality and operational boundaries

Room IDs and owner UUID remain in Vault at rest; a binding APPLY also
places the necessary values in the PM2 runtime and PM2 saved process state.
Protect server filesystem and PM2 permissions. The job never includes these
values, the bot token, DB password, raw PM2 environment, or personal data in
GitHub logs, comments or artifacts.

This is Telegram-only. It does not deploy new application code, alter
webhooks, payment/trading settings, account data or strategies, execute
private broker APIs, or initiate real orders. No Replit.

Only after a verified binding and successful owner-approved runtime checks
should ongoing scheduled briefings, four-market signals, holdings mirror,
automatic trading notifications, and durable SEND receipts be assessed as
operational. Do not automatically resend the already-confirmed six TEST
messages.
