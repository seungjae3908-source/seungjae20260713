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
