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

### 2026-10-13 complete periodic send-owner inventory and operating proof

The standalone owner originally covered three send-capable workers but missed
Signal V3 AI watch. That component both requests public-only rescans and directly
sends Telegram AI change alerts. Its startup is now owned by the same
embedded/isolated switch, and the isolated entry optionally starts it when
AI access is configured. The old application exports its state in its existing
health readback. The market routing uses the dedicated four market rooms
instead of collapsing them into two legacy stock/crypto destinations.

Production quiescence is verified only when the old process declares
telegramWorkerOwner=isolated, backgroundWorkersEnabled=true, and all four
send-capable workers have never started in that isolated-owner API process:
personal enabled=false; briefing state NOT_STARTED; V3 subscriber state
NOT_STARTED/inFlight=0; AI watcher state NOT_STARTED/inFlight=0. The exact
new-code process/marker SHA and live PM2 owner flag must match. This does not
turn off unrelated price monitoring, trading or Paper background activity;
price alerts and trade events continue writing into the durable personal
outbox and must be delivered by the sole personal worker owner.

Operator approval and a fresh protected immutable cutover remain mandatory.
No change to running PM2 or real trading permissions is authorized by this
Draft-only source change, and no real Bot/user receipt is claimed.

### 2026-10-13 one-batch direct AI watch restart-safety

The previous Signal V3 AI change-watch used only process memory for dedupe
and called the Bot transport directly after an informational public rescan.
It could repeat material-change notifications after a restart or ambiguous POST.
A SHA-independent per-event/per-UTC-day AI watcher key is now pre-reserved and
fsynced in its OWN standalone file ledger before any Bot POST. Confirmed Bot
acceptance is recorded separately from a known no-send; any transport timeout,
crash, duplicate or ambiguous response remains an unconfirmed no-replay tombstone.
The V3 body reader now bounds response size and requires a current, safe,
canonical 12-lane source envelope, not just HTTP 200.

Existing in-memory sends cannot be reconstructed from the preexisting server.
To avoid silently replaying older AI notifications, direct AI-change Bot
delivery now requires an independent explicit migration approval:
TELEGRAM_AI_WATCH_DELIVERY_APPROVED=true, after confirming historical state.
The default is OFF. Public-only AI rescan calculations remain available, and
this never grants trading/private API authority. The isolated runner provides
a separate immutable /opt/stock-app/.runtime/signal-ai-watch-delivery-state.json
path and does not modify the legacy market briefing or V3 signal subscriber
dedupe files. Full-release preflight checks both durable idempotency and the
explicit migration receipt before a GREEN release verdict.

This is source-only Draft at this checkpoint: no Bot sends, PM2 restart, LIVE
flag changes, DB migration, protected deployment or real-user delivery proof.

### Aggregated preactivation failure matrix (2026-10-13)

Before a final Full CI and protected staging:
1. Identity: latest merged main lineage, immutable release SHA, only Telegram
   independent scope, no moving-main acceptance by stale receipt
2. Data: V3 current twelve source pages, successful actual cycle, age below
   15 minutes and valid source/profit provenance (HTTP 200 alone insufficient)
3. Routing: all six unique destinations with actual read-only Bot getMe/getChat
   and posting rights; personal link active and 403 relink reconciled
4. Network: independently repeated HTTPS/TLS IPv4 route and safe 429 backoff,
   no expired/private tokens in console, logs or messages
5. Delivery: real personal SENT, outbox producer-consumer integration,
   source to event to journal to notification, confirmed/unconfirmed
   outcomes separated; no automatic replay of ambiguous POST
6. AI change-watch: explicit legacy notification migration, separately fsynced
   durable reservation before POST, bounded 8 MiB V3 source and market routing
7. Process: exactly one Telegram sender process across personal/brief/V3/AI,
   exact actual PM2 runtime SHA, no in-flight old sender, separate owner+deploy
   locks with immutable ledger paths and no automatic financial authority
8. Packaging: isolated worker fully bundled from pinned workspace and loaded
   in a clean temporary Node directory WITHOUT node_modules. Build-time
   verification rejects missing dynamic dependencies before release
9. Staging: scoped Telegram network/security and natural operational checks;
   Full app staging Paper Holdings GET HTTP400 remains an independent full
   application release blocker, NEVER silently relabeled as Telegram PASS
10. Operations: protected environment owner review, persisted rollback copy,
    safe after-crash resumption, disk space/permissions, real-sha drift
    validation, preserve all existing LIVE/Paper accounts and zero orders.

The pure ops/telegram-batch-release-verdict.mjs accumulates these conditions
into distinct source, scoped rights/network, runtime/rollback, full CI,
staging, Bot/personal, cutover and trade-preservation blockers. It is a
defense-in-depth policy, not a trusted collector of Production proof. Fixture
PASS must not bypass actual protected receipt provenance. CI failures do not
authorize retry-to-pass, broad application PM2 restart, secrets modification or
disable of manual SPOT/FUTURES LIVE capabilities.

The existing old Telegram code-only workflow pins earlier fixed deployments
and may reject newer isolated-worker files. That old allowlist must NOT be
widened merely to force this release. A reviewed independent installer,
staging and owner-controlled migration remain necessary before actual LIVE
Telegram service can switch from embedded to isolated without disturbing
manual LIVE trading. Code-only prepare ≠ installed worker ≠ received message.

### Source preflight uncovered an additional isolated-worker authority gap

The initial isolated-owner matrix mirrored an older Telegram release check,
but had omitted independent TRANSFER_ENABLED, WITHDRAWAL_ENABLED and the four
provider ORDER_ENABLED flags. A new offline failure test caught this BEFORE
Full CI. The isolated process now rejects all those flags and rejects inherited
private broker signing credentials (master encryption key, Toss, Kiwoom, Upbit
and Bitget keys) even when their enable booleans say false. The personal
Telegram bot token, Supabase service-role storage key and optional public AI
credentials remain the only separately approved notification data scope.

A failed scoped QA is not a reason to repeat Full CI: exact-head Fast dispatch
correctly blocks the expensive Full run until the whole Telegram QA passes.
The prior verified Full 26/26 is historical source evidence and cannot be
borrowed for this modified candidate. Protected server diagnostics and the
Staging Paper GET400 remain truthful NO_GO until independently resolved.

## 2026-10-13 full-Staging and owner-approved read-only evidence repair

The latest real Full Staging run #38340742857 deployed tested merged main
1756d0c538e2f75a9fd3636e4959e552fe67f0ad. Importantly, the previous
GET /api/trade-automation/holdings 400 did NOT recur in this release: 0
unexpected HTTP errors, 0 browser console errors, and 18 completed browser
checks succeeded. The real blocker was a missing visible Technical / 모의매매
menu item; that blocked the admin full-product navigation journey and skipped
8 downstream routes. Add that existing route to the real capability-gated
APP_NAVIGATION rather than deleting the E2E expectation. Static mirrored
full-Staging navigation contract now checks all Technical / Information /
Settings paths, unique labels and the existing capability gate; the real
full Staging protected workflow is still required after merge.

A separately authorized six-room Vault/Bot GET read-only run #38334566983
failed before remote SSH because protected approval completed AFTER the pinned
requested main SHA ceased to be the latest. For non-mutating diagnostics only,
pinned exact-source ancestry now permits collecting sanitized Bot/room/Vault
read-only evidence even if main advances. The final ready gate still requires
the pinned SHA to be CURRENT as well as correct actual PM2 SHA, Vault and six
room rights; a changed main can never become a false-green deployment or bot
activation. Strict write/PM2/trading deployment version guards stay unchanged.

All actual user Bot SEND and private trading authority remain separately
protected. This is not a claim of real message receipt or Signal V3 source
freshness, and does not authorize stock-app production restart while manual
LIVE Spot/Futures trading may be enabled. Replit prohibited.

### 2026-10-13 contradictory navigation acceptance reconciled BEFORE merge

Full canonical Browser shard 3/4 in #38343785628 failed an actual
source-contract check after the earlier Staging fix inserted a duplicate
Technical / 모의매매 menu entry. The real product rule is intentionally
ONE Technical / 기술매매 top-level menu with distinct LIVE and Paper modes
inside a common trading workspace. This is a real quality failure; it must
NOT be bypassed by deleting the stronger Browser regression check.

Repair keeps APP_NAVIGATION's canonical ONE 技術매매 link to /auto-trading,
which is capability-gated; remove the duplicate top-level Paper item.
Update BOTH real Full Staging E2E paths: navigate first through Technical /
기술매매 to /auto-trading and then the visible technical-mode-paper button
to /paper-trading. Require trading-paper-modes to appear for automatic/manual
Paper selection. Leave existing Paper route and its financial safety gates
unchanged. A static contract now checks the E2E tests, singular visible
menu and real mode-link against the canonical auto-trading-professional-ui
contract, so future Stage fixes cannot reintroduce this contradiction.
Actual protected Staging run remains necessary; this source alignment alone
does NOT establish live Bot delivery, full Staging readiness or manual LIVE
provider health.
