# Protected Telegram code-only Production rollout

This is a Draft release-control workflow to fill a missing narrow deployment
capability. The existing generic Production Deploy workflow runs Paper/Member
RLS database migration steps and broad QA. The Telegram Production Release
workflow additionally changes Telegram runtime/webhook and performs real Bot
API proof sends. Neither is suitable for an approval restricted to Telegram
code deployment plus read-only verification.

## Safe boundary

The ten files included in the already-verified merged Telegram candidate
(#1825, merge commit ceade3d9fb4cbb4bfcea42d548233aec79653e92)
are pinned by immutable Git blob SHAs. Even a change to an allowed filename
blocks deployment. Current main and existing PM2/marker SHA are checked once
more immediately before applying Production code.


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

## Canary background-worker isolation safety hardening

The generic deploy script now sets `BACKGROUND_WORKERS_ENABLED=false` **only on the
temporary canary Node process**. This prevents recovery, market scanning, scheduled
Telegram notifications, Paper or other workers from executing within canary before
the approved code is promoted. The Production PM2 restart environment does not set
this variable; the previous Production worker policy is preserved. If any live or
Paper trading execution flag is enabled, the existing pre-deploy gate refuses
promotion. The scoped deployment workflow also pins the exact SHA of this shared
script, so unreviewed edits fail closed. No SQL migrations or Bot API proof sends
are included in the code-only workflow.
