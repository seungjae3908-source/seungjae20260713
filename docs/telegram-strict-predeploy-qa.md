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

The new PR CI tests the evaluator and mocked integration. The same Draft also inserts two concrete read-only vetoes into the existing code-only release workflow **before deployment**: (1) two recent independent successful protected Staging Telegram-only TLS runs, with no recent failures, and (2) Production-local Signal V3 systemd server/timer and bounded loopback /health plus /v1/signals freshness checks. Both block on HTTP 503 or stale data and never call POST, send messages, or alter PM2.

That workflow is a pinned one-time historical release route, already used for #1828. Its lineage constraints intentionally do not provide a general new-release path; a future approved release needs its exact artifact/lineage review again. These Draft vetoes do not retroactively change the completed Production deployment.

The new PR CI tests only the evaluator and mocked integration. A successful PR CI run **is not** the trusted live evidence object. A release workflow must separately verify the artifact origin and same-SHA protected Staging/Production read-only receipts and call this evaluator before issuing a deploy-ready decision. Until that wiring is reviewed and merged, it is a Draft guard **not yet automatically enforced** by the already-run one-time #1828 deployment workflow.

Replit/Replit Agent prohibited. No real message sends, no database mutations, no live orders, no secrets, no operating deployments in this Draft.
## Technical hold and follow-through

- The modified code-only Production workflow retains the separate protected production approval and all previous exact-main, immutable-blob, six-room, no-LIVE, canary, backup and rollback gates; it now fails closed earlier if the latest protected Staging network QA set is unstable or current Signal V3 health/source is stale.
- No new Telegram release may proceed based only on CI 6/6 or previously successful Staging Readiness. Two independently timed Staging TLS success receipts and fresh V3 signal must be observed at actual runtime before asking for Production approval.
- The complete pure GO/NO-GO manifest evaluator still requires provenance-verified collection of actual Staging dry-run, read-only bot permissions and V3 cycle receipts. This wiring is a follow-up task and MUST not be mislabeled finished just because a unit test passed.


## Additional false-green fixes (Draft)
The verifier now refuses a newly stamped Signal V3 snapshot unless all twelve
canonical market × strategy × timeframe coverage lanes are individually
source-backed, complete, non-partial, and have zero provider/timeouts. It
rejects stale, missing, duplicated and malformed coverage even when `/health`
claims READY and HTTP 200. A successful oneshot result must also be recent,
not merely marked success in systemd history.

The Production protected code-only gate now streams a **read-only** helper from
the exact operator checkout over SSH to the server without writing files.
It performs only fixed `systemctl show`, read of Linux `/proc/uptime` and
bounded localhost GET `/health` and `/v1/signals`, then emits a fixed PASS/NO-GO
code. No raw signals or secret environment contents are output. This remains
an operator-only, previous-release-lineage-specific workflow; it does not
constitute a reusable authorized deployment path or finish the signed full
GO/NO-GO manifest provenance collector. User production approval is still
required after all blockers are resolved.


### Predeploy helper immutable source integrity
The read-only Signal V3 preflight helper is referenced by its reviewed Git
blob SHA from the immutable operator checkout; it does not come from the
old Telegram application artifact. Dedicated no-network mocked tests cover
all 12 market/strategy lanes, stale/partial/provider error blocking, old cycle
status, safety envelope and fixed-loopback HTTP GET. A workflow-only code
snippet cannot replace these executable contract tests.

## Draft additional false-green closure: actual lane lineage (2026-10-11)

All twelve Signal V3 coverage rows must now prove market-specific public
roster sources, in-range advancing cursors, and non-replayed fresh lane
observations. Blocked-only cursor rotation and retained last-good rows are
never new full-coverage success. A `VALID_NO_TRADE` row cannot secretly
retain candidate inputs; a `CANDIDATES_AVAILABLE` row must have real adapted
inputs bounded by its scanned count, and a reported provider failure can
never be concealed by a zero-error envelope. Deterministic contract tests
include these counterexamples, without external providers or writes.

This is **not** a fix for the three observed KR/US `BLOCKED_DATA` lanes
in PR #1816. Those remain NO-GO until independently verified provider,
session and quality-source evidence succeeds; no quality gate is relaxed.
