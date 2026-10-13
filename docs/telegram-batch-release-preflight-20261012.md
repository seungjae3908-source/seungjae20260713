# Telegram 6-room, Personal and V3 batch preflight — 2026-10-12

Scope: protect the existing investment platform's Telegram function only. Replit and Replit Agent forbidden.

## Verified previous operational blockers
- Latest protected Production read-only evidence: PM2 stock-app online but its code SHA differs from new main. All six room configs/bot GET passed. Neither real private delivery nor confirmed end-user receipt was proven; personal SENT 0 and three historical HTTP403 dead letters.
- Signal V3 /v1/signals returned HTTP 503 from an outdated source snapshot; the subscriber remains fail-closed. Do not fabricate signals or count skipped/deduped messages as successful sends.
- Staging Full Readiness failed from an unrelated member Paper holdings GET 400 (/api/trade-automation/holdings); exact build/PM2 SHA, Staging app health and two independent Telegram IPv4/TLS probes passed. Never weaken full-gate browser checks to call this a release success.
- LIVE SPOT_LIVE_LIMITED and FUTURES_LIVE_LIMITED manual authorities have been active. No Telegram release is permitted to disable or restart stock-app with existing trading state.
- Legacy DB watchlist has 10 rows, nine not explicitly owned by members; don't auto-transfer device rows. The separate approved UI opt-in code requires authenticated-member confirmation.

## Fixed in this batch (safe Draft; no runtime actions)
- Harmonize three independent Telegram Production veto points: code-only, full release pre-DB, full release immediately before PM2 restart.
- Fail closed for boolean flags, even malformed truthy strings or booleans; for spot and futures capability/market allowlists; and separate Futures LIVE executionAuthority plus spot executionAuthority. Do NOT let futures-only permissions bypass the Telegram deployment gate.
- Add executable behavior matrix tests and source-contract checks to both scoped Telegram release QA workflows.

## Required before any Staging/Production cutover
1. Exact-head Telegram mocks, Fast CI and Full CI all Required 6/6 success, no open review, no merge drift.
2. Exact-main protected Staging Full Readiness release_ready=true and two independent recent exact-sha IPv4/TLS receipts (read-only TLS alone isn't delivery).
3. Protected Production READ-ONLY Signal V3 cycle/snapshot diagnosis, real six-room Bot acceptance and user personal delivery proof, without blind resend of uncertain outcomes.
4. If old stock-app holds manual LIVE/FUTURES permissions, shared process restart is NO_GO. A future separately reviewed isolated Telegram worker, guaranteed single-writer ownership/leader lease and atomic cutover would be needed; never bypass or automatically turn off trading.
5. Only after protections and human environment approvals can protected Production release be attempted. Roll back safely on any failure; no orders, transfers or withdrawals.

This is a preflight risk inventory, not a claim of Production readiness or realized trading profitability.

## 2026-10-13 — One-batch release and isolated worker preparation

This is DRAFT SOURCE ONLY. No independent service installation, Bot API send,
LIVE order activation or Production modification occurred. No Replit.

The API still starts embedded Telegram workers by default. An explicitly
approved TELEGRAM_WORKER_OWNER=isolated suppresses only the three Telegram
worker starts; the pre-existing Paper and Trading workers remain unchanged.
The new api-server/dist/telegram-isolated-worker.mjs is built but dormant.

The independently controlled launcher ops/run-telegram-isolated-worker.sh
requires a sealed release marker, SHA256 manifest, six non-colliding Telegram
rooms, personal service-role storage, exact-sha owner approval, exclusive flock
and two separate actual PM2 readbacks proving the old Telegram writers are
disabled. The launcher never restarts stock-app or changes live flags.

Existing manual LIVE and embedded Telegram workers were active in previous
Production evidence. Therefore isolated cutover is NO_GO until a separately
reviewed trading-preserving shutdown/handoff and explicit human approval.
The old PM2 cannot be safely restarted solely to satisfy Telegram QA.

The pure one-batch verdict accumulates all release blockers in ONE result:
(1) exact-head Full CI required six SUCCESS, (2) protected complete Staging
including resolution of Paper holdings HTTP 400, (3) Signal V3 fresh successful
cycle, HTTP 200 and valid source evidence, (4) six-room and personally owned
SENT plus fill-to-Journal-to-Telegram verified events and dedupe, (5) preserved
durable ledgers, one isolated send writer and safe rollback, (6) exact
preservation of existing financial authority and zero Telegram-triggered
order/cancel/transfer/withdrawal. Fixture PASS grants NO Production permission.

Desired pipeline: freeze one candidate -> all static/batch blockers -> only
Telegram scoped QA -> ONE exact-head Full CI -> full protected Staging QA ->
real protected Signal V3 and Bot readbacks -> separately approved single-writer
cutover -> protected Production release -> natural use receipts and financial
safety invariants. Orders remain owned by the Trading release, not Telegram.

### 2026-10-13 follow-up: actual legacy worker quiescence, not just PM2 flags

An earlier isolated-worker launcher read three PM2 environment strings; those
values alone cannot establish that in-memory background timers have stopped.
The Draft now additionally reads the SAME running API `/api/health` at a
hardcoded loopback host and bounded owner-selected port. It demands an
exact SHA match to the installed Production marker, identityMatch=true,
a recent health timestamp, personal worker disabled, brief worker DISABLED,
and a new read-only subscriber lane DISABLED with inFlight=0. Missing or
legacy health schemas fail closed; malformed/unavailable responses do not
become permission for a second Telegram sender.

The independent launcher holds the original stock-app deployment flock
as well as its own owner flock for its lifetime, so the guarded production
deploy cannot restart the shared PM2 while this Telegram sender runs.
Two PM2 checks and two current-runtime checks are required before starting.
No stock-app PM2 command, database write, financial API or Bot send is in
this preflight. Owner-reviewed SSH/systemd installation and receipt provenance
are still pending and cannot be inferred from green mocks.

The existing real Production app lacks proof it is quiesced and is not
assumed to support this new health schema until separately deployed.
Therefore manual LIVE preservation still keeps cutover NO_GO. No Replit.
