# Protected Telegram code-only Production rollout

This is a Draft release-control workflow to fill a missing narrow deployment
capability. The existing generic Production Deploy workflow runs Paper/Member
RLS database migration steps and broad QA. The Telegram Production Release
workflow additionally changes Telegram runtime/webhook and performs real Bot
API proof sends. Neither is suitable for an approval restricted to Telegram
code deployment plus read-only verification.

## Safe boundary

- The protected production job requires an exact owner command on Release
  Control #1555, current-main SHA, postmerge CI provenance, completed successful
  same-SHA Staging PostgreSQL auth and Staging Readiness artifacts.
- It reads the actual PM2 runtime and deploy marker before any write. Trading
  execution authority must be OFF; existing six Telegram room bindings and
  Telegram activation must match. It rejects other changes since Production
  according to the finite allowlist in ops/telegram-production-code-only-scope.mjs.
- It reuses the existing, previously reviewed ops/deploy-production.sh build,
  canary, backup, rollback, PM2 restart, and health verification logic rather
  than introducing an independent in-place copy deployment.
- The workflow itself has **no** SQL/migration/webhook/Telegram send
  operation. It reads PM2 and the app's existing loopback /api/health after
  deploy. Existing automatic Telegram workers retain their previously
  approved runtime activation and may operate naturally after a deployment.
  This does **not** claim that a scheduled briefing, Signal V3 event or personal
  Telegram message was sent or received.
- It will not run until this PR is explicitly reviewed/approved and merged and
  the owner triggers the exact issue command, then approves the GitHub
  protected production environment.
- A separate exact-SHA protected read-only audit is still required to inspect
  persisted Telegram ledgers, user-delivery evidence and the Signal V3
  snapshot freshness.

Command after separately approved merge and immutable SHA verification:

    /run-telegram-code-only-production <exact-current-main-sha>

Any error or missing prerequisite must fail closed. Do not dispatch a generic
deployment as a workaround. Replit / Replit Agent never used. No new LIVE/AUTO
trading authority is granted; no orders, transfers or withdrawals are made.

Central Hub #1102; Release Control #1555.
