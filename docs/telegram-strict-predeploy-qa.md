# Telegram pre-production strict GO/NO-GO policy (Draft)

**Purpose:** prevent the previous release-sequencing mistake, in which CI 6/6 passed but real Staging TLS stability, Signal V3 freshness and ongoing Telegram delivery were not demonstrated. This policy is for Telegram scope only, not a promise that all production faults can be predicted.

## Required sequential release phases

1. Develop and fix in Draft: preserve all existing producer, account, order, and release safety boundaries; do not merge/deploy.
2. Run Telegram-only mocked end-to-end flows, all six room routes, five market-direction lanes, personal 403/relink, dedupe, market briefing schedule, canonical format, no Bot API sends. Verify standalone Signal V3 contract.
3. Pass exact SHA Fast and Full CI with required six contexts, including DB/RLS, security, AI privacy, browser UI and futures public smoke.
4. Release same exact candidate SHA to Staging **only under separate approval** and verify PM2 running SHA, health marker, DB authentication, Staging Readiness, TLS observations and any permitted Bot API read-only room permissions. Capture trusted protected workflow run IDs; never copy secret or chat ID values into receipts.
5. Verify **fresh** Signal V3 public source via loopback GET: server/timer ACTIVE, most recent successful producer cycle, /v1/signals HTTP 200, valid snapshot, age within the existing 15-minute threshold. `SNAPSHOT_STALE`, 503, unknown cycle or failures mean NO-GO. No TTL expansion or fabricated signals.
6. Require two independently timed successful IPv4/TLS samples at least five minutes apart, all samples within thirty minutes and the latest within ten minutes. Any failure or stale evidence blocks deployment. This does not prove the future network can never fail.
7. Evaluate the sanitized, provenance-verified evidence using `evaluateTelegramPredeploy`. Only `GO_FOR_HUMAN_REVIEW` allows asking the owner for a **separate** Production deployment approval. Evaluation never authorizes deploy, PM2, DB or Bot API operations.
8. After an authorized Production deploy, verify PM2/marker SHA, health, Telegram worker ticks, scheduled due/ledger evidence, Signal V3 snapshot, and actual permitted natural delivery receipts. This last part is post-deploy by nature and must not be claimed proved in predeploy mock CI.

## Current release blockers (observed 2026-10-11)

- Signal V3 `/health` SNAPSHOT_STALE; `/v1/signals` HTTP 503.
- One Staging IPv4/TLS probe succeeded and another timed out; network stability not proven.
- Personal confirmed delivery and scheduled market/Signal ledger records remain unproven. They are not necessarily failures if no new due events occurred; require staging dry-run correctness and later natural production evidence.
- Draft #1829 adds read-only Staging IPv4/TLS diagnostic; Draft #1830 adds V3 cycle-result diagnostics. Their test success is not proof the live operational faults are resolved.

**Status now: NO-GO for any new Telegram Production release until those prerequisites pass.** The previous #1828 code-only release has already been applied; this policy does not roll it back or mutate the server.

## Enforceability caveat

The new PR CI tests only the evaluator and mocked integration. A successful PR CI run **is not** the trusted live evidence object. A release workflow must separately verify the artifact origin and same-SHA protected Staging/Production read-only receipts and call this evaluator before issuing a deploy-ready decision. Until that wiring is reviewed and merged, it is a Draft guard **not yet automatically enforced** by the already-run one-time #1828 deployment workflow.

Replit/Replit Agent prohibited. No real message sends, no database mutations, no live orders, no secrets, no operating deployments in this Draft.