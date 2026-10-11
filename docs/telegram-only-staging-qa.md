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

## 2026-10-11: isolate intermittent IPv4 connection failure, without retry-to-pass

The previous probe performed one IPv4 DNS preflight then handed the hostname
back to `tls.connect`, making a second lookup possible and conflating TCP
reachability timeouts with TLS handshake timeouts. The probe now connects
to the **validated IPv4 answer from the first lookup**, while continuing to
verify the `api.telegram.org` TLS certificate and SNI identity.
It classifies `IPV4_TCP_TIMEOUT` separately from `IPV4_TLS_TIMEOUT`.
Only one bounded (6.5-second) attempt is allowed; no retries, no bot token,
no Bot API calls, no messages, and no network addresses in audit receipts.

This improves diagnostic fidelity; it does not claim that an intermittent
remote firewall, route, or provider network fault is resolved. The protected
Staging QA retains the exact-current-main and exact-runtime identity gate,
and execution needs separate approved merger/deployment before it can attest
any new live network outcome.


## Public IPv4 DNS redirect and TLS error safety (Draft)
The token-free Staging probe now refuses connections to private, loopback,
link-local, shared CGNAT, documentation, benchmarking or multicast IPv4
answers, reporting only `IPV4_DNS_UNSAFE_ADDRESS` without the destination.
This avoids local-network probing after DNS poisoning or split-horizon
misconfiguration. A trusted public IPv4 is still validated using strict
Telegram hostname SNI and the CA chain; hostname mismatches, missing CA
issuers and expired/invalid certificates have an explicit bounded
`IPV4_TLS_CERT_FAILED` classification rather than a generic network error.
This does not change actual Production egress or prove real connectivity.
