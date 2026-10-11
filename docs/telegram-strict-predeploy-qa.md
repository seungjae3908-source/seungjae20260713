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

## Draft: exact source-page execution provenance within 12 latest lanes

In addition to the twelve unique 4-market × 3-mode lane names, the
read-only predeploy source verifier now requires the V3 public producer's
bounded `publicExecutionDiagnostic` for each lane. Exactly the requested
number of stage-2 source items must have started **and completed**,
with `partial=false`, `timedOut=false`, zero reported item failures,
and cursor progression/wrap matching the completed count.
A zero-error provider summary alone is insufficient if an unfinished
scan reports an empty results list, as observed in Futures 60m.

**Scope caveat:** a fully verified current batch is *not* historical
or current all-symbol full-market coverage. The 12-lane predeploy check
is a latest-batch/source-integrity veto, not a claim that 4,010 KR or 820
Futures instruments were all scanned. Cumulative all-roster coverage
and excluded KRX symbol remediation remain separate mandatory product
acceptance evidence. This checker cannot turn that missing evidence into
a deployment or trading authorization. The new receipt field requires
a matching V3 producer revision (Draft #1816), which is currently
unmerged and unapproved.

## Draft: require a common producer cycle identity

Signal V3 rotates through many small pages. After a full roster wrap the
same cursor can occur in a later cycle; an old saved candidate must not be
treated as a new Telegram alert. This predeploy verifier requires all 12
source-backed coverage rows to carry one identical canonical UUIDv4
`sourceCycleId`, plus `snapshotCurrentPageSourceReady=true` from the V3
/health endpoint. Missing or mixed epochs and blocked source data remain
NO-GO regardless of a new JSON timestamp or green code CI. The matching
public-only producer and server implementation is Draft PR #1816; all
changes are unmerged and do not authorize Staging/Production or messages.

## Draft — prevent weekend phantom closing/premarket reports

The dedicated four-market Telegram scheduler previously generated
KR_CLOSING every day at 15:50–16:10 KST and US_PREMARKET every day
at 07:50–08:10 America/New_York. This included weekends when
neither exchange normally holds a regular session, potentially
misleading users with a close/premarket report. Those two session-
specific plans now require the weekday for their respective exchange
local timezone (US EDT/EST naturally handled). MORNING remains a daily
market-state briefing, WEEKLY stays Monday KST. Stock-market official
holidays/early closes remain subject to the existing N/A/NO_TRADE
source-quality handling; no unsupported holiday calendar is invented.
No actual Telegram message or schedule task was triggered here.

## Draft: Telegram subscriber current-page source gate (no sends)

Before forwarding V3 events to any of the four market rooms or member
watchlist personal outbox, the Telegram subscriber now demands a fresh
(<=15m), public-only twelve-lane shared UUIDv4 source epoch, and
matches every NEW_CANDIDATE to its exact current-cycle source row,
ticker, direction, cursor, timeframe and completed zero-error page.
Blocked other lanes do not veto valid single-lane current candidates.
Noncandidate events, stale/future publications, duplicated/replayed
event IDs, mismatched rows/epochs and false-success source pages are
blocked before any fanout. The subscriber disallows redirect-following
away from its loopback GET and caps JSON response bodies at 8 MiB.
A corrupt local dedupe ledger still fails closed.

This runtime gate requires separately merged Signal V3 producer #1816
to provide compatible sourceCycleId/provenance. It is Draft-only and
does not activate a live source, send Telegram messages, issue orders,
or change Production secrets/PM2/DB.

## Signal text accuracy against source row

Telegram subscriber candidate receipts now also verify that the
human-visible validation tier, risk-adjusted utility R/mode and
indicative leverage metadata match the same current-cycle source row.
An altered research candidate cannot be advertised as CHAMPION or
claim 999R / 125x leverage solely by tampering with an event object.
This remains source-integrity validation, not an independent economic
OOS/realized-return PASS.

## Scoped V3 tests must not mutate the global API test registry

The initial hardening inserted two source tests into the shared
`api-server/test.mjs` Telegram group, which triggered the unrelated
research/automatic-trading integration scope guard. That protected
guard must remain untouched. The exact shared test runner and original
Staging test-target cardinality are now restored to current `main`.
A separate, deterministic `ops/telegram-v3-source-mock-tests.mjs`
reuses the existing esbuild-and-node test harness to run **exactly**
the two new Telegram-only V3 intake and subscriber test files in the
Telegram-Only Staging and Strict Predeploy QA workflows. Existing
`test:telegram`, backend typecheck, application Fast/Full CI and all
protected checks remain required and unchanged. No additional
Paper/Research/Live test, private service, Telegram send or deployment
was invoked or authorized.

## 2026-10-11 Telegram-only subscriber corrections: canonical IDs + honest queue receipts

A forged V3 envelope could carry a same-row/same-event noncanonical
`id` or a US SWING 60m event attached to a different US 1D lane
while retaining all other current-page fields. The Telegram subscriber
now requires exact `market|symbol|strategy|timeframe|direction`
canonical candidate ID plus a source lane identity derived from the
current market/timeframe (`SCALPING_15M`, `SWING_60M`,
`MID_LONG_1D`) and matching lane strategy. Both adversarial cases
are regression-tested in the isolated Telegram mock QA.

Separately, member watchlist alerts accepted into the durable outbox
were counted as `attempted` but not visible as `queued` in the
subscriber's log. A healthy queue admission is NOT a Telegram send,
nor proof of human receipt. The subscriber now reports
`personalQueued`, `personalDelivered`, `publicDelivered`
and `queued` as separate safe aggregate counters, preserving
the existing total `delivered` meaning. No chat IDs, symbols,
tokens or member details appear in telemetry. Existing personal
delivery/retry/dedupe code and the authoritative Paper/live runtime
are unmodified. All tests use local mock senders; no Bot API calls.

## 2026-10-11 — Telegram source truth + bounded rich scheduled brief

The Signal V3 subscriber can receive a structurally valid zero-event,
all-BLOCKED_DATA twelve-lane snapshot. It now classifies this as
`SOURCE_DATA_BLOCKED` (0 sends), NOT `READY`. A genuine verified
one-lane/no-trade source still reports READY even when other markets
are blocked. This distinguishes "HTTP healthy" from "current source
eligible" without fabricating signals or opening trading permissions.
If an AbortSignal aborts while decoding a bounded 200 body, this is
TIMEOUT, not INVALID_RESPONSE. Personal watchlist policy timestamps
are now the verified V3 snapshot generation time, rather than the
subscriber polling time, to prevent misleading freshness.

Separately, optional KR/US theme lookup was previously not bound by
the market brief's 8-second AbortController, so one hung
`getSectorPopular` promise could stall a scheduled market Telegram
briefing indefinitely. `boundedTelegramBriefRead` now bounds each
market-room and sector result to eight seconds, returns null/N/A for
unavailable evidence and lets other room data proceed. Provider
exception messages are reduced to fixed safe codes, never raw token/
URL/PII material. Offline tests use a deliberate never-resolving
promise and throwing source, not network calls or actual Bot API sends.
