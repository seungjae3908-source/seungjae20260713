# Research Center Copilot

## #833 canonical research bundle resolver

The admin path is Research Center → AI Research Copilot → DSL validation →
server-side bundle resolution → explicit research backtest submission.
The same router retains authenticated/admin middleware for validation,
`POST /resolve-bundle` and `POST /submit-backtest`. Non-admin requests never
reach canonical reads or the executor. No AI output is a bundle input.

`ResearchBundleService` is an admission/submission seam, not a new backtester.
It reuses `createSafeStrategyDslV1`, `assertFormulaCandidateV1`,
`resolveCanonicalStrategyIdentity`, `buildResearchDatasetIdentity`,
the merged #772 explicit policy producer, the merged #769 sizing validator,
the safe formula evaluator/exit parameter adapter, and
`runOnePassCandidateBacktestV1` (#690).

Server integration contract:

- `readCanonicalBundle(dslDigest)` must read an immutable, server-owned
  `research-bundle-source-v1` record. HTTP bodies, AI/cache text, cycle
  summaries and PUBLIC_FORWARD liquidity calibration artifacts are not sources.
- The record binds the canonical DSL, approved FormulaCandidate and frozen
  generated parameters to exact StrategyIdentity, research SHA, dataset identity,
  OHLCV content digest, immutable receipt, observation interval, PIT and leakage
  checks. Dataset observations and provenance timestamps are never synthesized.
- Split policy and receipt carry independently digest-verified payloads, exact
  TRAIN/VALIDATION/OOS assignments, freeze and first-outcome observation times.
  Assignment sets must cover the exact dataset without overlap. No default split
  percentages, minimum sample counts or retrospective policy are generated.
- Risk is an actual #772 record plus the inputs required by #769. Its scope,
  version, freshness, leverage and sizing must validate. Capital and quantity step
  must agree with canonical sizing evidence; no account/sizing payload reaches AI
  or the public result.
- Full Cost contains all eight explicit components, each with source, provenance,
  market/symbol/timeframe/SHA/dataset, bucket and freshness. Null/absent values
  are incomplete, not zero. The existing #690 engine cannot apply nonzero
  liquidity/partial-fill costs: those produce
  `BACKTEST_COST_ADAPTER_UNSUPPORTED`, even if the input bundle is structurally
  complete. A documented observed zero is accepted only as an explicit receipt.
- Pre-frozen OOS horizon, WF windows and locked FinalHoldout identity are required.
  Holdout bars/metrics are never passed to the training executor or UI. WF windows
  cannot consume OOS or holdout assignments. No new statistical thresholds are
  introduced; DSR/PBO/multiple-testing/stability/firewall evidence stays missing.
- `ResearchSubmissionStore.reserve` must be an atomic durable insert-if-absent.
  Its deterministic key binds strategy identity, DSL, complete bundle, dataset,
  split receipt, risk record version, cost policy and exact research SHA.
  The key is shared across administrators so duplicates cannot create new tasks.
  Reservations must survive restarts; uncertain/failed completion never releases
  the key for automatic retry. Source bytes/freshness are reread after reservation
  and before execution. No new queue or disk/DB persistence is activated here.

The current canonical dashboard publishes cycle summaries, not a generic DSL
bundle catalog or durable submission store. The default router therefore has no
source/store adapter and reports explicit missing evidence with executor calls 0.
Connecting an actual owner-published catalog/store is a dependency, not permission
to build synthetic records or to enable runtime schedules. A complete structural
TEST_ONLY bundle is accepted only in an explicitly injected test harness;
runtime defaults reject TEST_ONLY. Test fixtures carry zero economic evidence
credit. No environment flag is used to enable test evidence.

Public states are separate: DSL_VALID, RESEARCH_BUNDLE_READY, BACKTEST_EXECUTABLE,
BACKTEST_SUBMITTED and BACKTEST_COMPLETED. Historical completion leaves WF/OOS
NOT_EVALUATED, FinalHoldout LOCKED, statistical firewall MISSING_EVIDENCE,
profitability false, Promotion ineligible and Champion absent. The resolver does
not generate performance metrics, probabilities, leverage choices or promotions.

Verification starts with failing tests: missing resolver contracts and an admin
HTTP 404 on the absent new routes. The suite then exercises aligned TEST_ONLY
receipts, missing/mismatched data, all split/risk/cost gates, OOS/holdout isolation,
forged client fields, AI text injection, cross-service duplicate reservation,
source changes across async IO and one real canonical backtest on fixture bars.
Existing Phase9 imports the new suite through the already-owned Copilot test;
no additional shared `api-server/test.mjs` edits or owner takeover are needed.

This is a research-only consumer of the existing canonical owners. It does not
create financial metrics, choose leverage, open final holdout data, promote a
strategy, select a champion, activate Shadow/Forward, or submit any order.

## User path

`/research-center` → **AI Research Copilot** uses the existing administrator gate.
The existing overview/AI debate page is composed unchanged; its active owner is
PR #756. The backend uses authenticated, administrator-only
`/api/admin/research/copilot`.

- GET reads the fixed loopback Research Production overview and canonical
  Strategy Promotion registry. It makes no AI call.
- POST `/review` accepts only a task enum and the exact displayed evidence digest.
  It re-reads canonical state before dispatch. User prompts, account context,
  prices and holdout outcomes are not transmitted.
- POST `/validate-dsl` invokes the existing `createSafeStrategyDslV1` and resolves
  the canonical bundle. Its identity is the canonical DSL digest; DSL validity
  alone grants no backtest or later-stage evidence. Explicit `/submit-backtest`
  admission rechecks the server-owned bundle before the existing executor.
- Backtester and promotion links open existing user paths. They do not submit a
  job or carry an incompatible DSL into an unrelated strategy.

## AI boundary

Reuse PR #821's strict proposer/critic seam and `answerAiChat`. No alternate
provider client or global environment mutation is introduced. Runtime requires
an isolated, allowlisted Gemini or Groq route and a separately confirmed
`RESEARCH_AI_FREE_TIER_CONFIRMED=true`. A model name or API credential does not
prove free billing entitlement. This PR does not set that flag or change any
credential/configuration.

AI output is qualitative, bounded JSON. Numeric prose, named financial
authority, Korean authority claims, unknown keys and private material are
rejected. Only canonical code supplies authority fields. No paid fallback or
application-level retry is allowed. The canonical transport timeout is fifteen
seconds. Provider requests are limited to one concurrent request, four per
minute per process and one per minute per administrator; exact-context cache
and single-flight results are isolated by administrator and expire after one
minute. Multi-process deployments need a shared quota owner before activation.
Token usage and remaining provider quota remain unknown, never fabricated.

## Evidence interpretation

Task success is runtime observation, not a strategy validation receipt.
Available canonical PASS receipts require matching code identity, provenance,
verified data quality, valid source timing and relevant dataset/sample evidence.
Receipt availability never grants promotion or trading authority.

The review digest binds canonical receipt quality, provenance and validation
timestamps, excluding only generated registry poll timestamps. Corrections or
revocations invalidate cached explanations. Evidence and provider policy are
checked again after AI completion, including every concurrent duplicate waiter.
The UI scopes its cache to the authenticated administrator and hides old review
text after a failed or changed source refresh.

Strategy comparisons currently expose canonical identities and stage metadata,
without performance ranking. Missing source timestamps stay missing, future
timestamps are blocked, and the dashboard freshness window is one day. This
window is a display/transport policy, not an investment threshold.

## Remaining phase dependencies — do not claim 100/100

1. The current default Strategy Promotion source does not ingest immutable
   strategy-specific OOS/WF/Holdout/statistical-firewall receipts. This consumer
   must not manufacture them from runtime task success.
2. The resolver and canonical backtester submission seam are connected, but no
   strategy-specific immutable dataset, frozen split, risk, full-cost and
   OOS/WF/holdout source catalog or durable submission store is connected to the
   default API. The UI reports each missing component and `BLOCKED_DATA`;
   executor calls remain zero. No fake dataset, policy or queue entry is created.
3. Qualitative AI criticism is not deterministic overfitting/leakage clearance.
   Statistical-firewall and untouched final-holdout owners must supply verified
   receipts. Final holdout outcomes are excluded from proposal input.
4. Shadow/Forward activation and production deployment remain separate approval
   tasks. No production provider was probed during development.

## Local verification

New service/HTTP boundary tests and the existing proposer/critic tests cover
authority injection, private suffixes, numeric claims, freshness, exact digest,
free-provider configuration, duplicate/cache isolation, quota failures, DSL
code injection and administrator permissions.

`api-server/test.mjs` includes the new tests in normal phase9/smoke execution.
`stock-analyzer/e2e/research-copilot.spec.ts` covers desktop/mobile, manual-only
AI requests, duplicate prevention, invalid DSL, malformed/unavailable responses,
missing evidence and member access. Browser fixtures have no runtime evidence
credit and invoke no external AI, database or trading provider.

## Candidate result identity and durable readback

`POST /api/admin/research/copilot/read-backtest` uses the same strict
`{dsl, bundleDigest, strategyIdentityDigest}` binding as submission and accepts
`resultArtifactDigest` to pin a previously returned result. The UI sends that
digest and rejects a changed result even when storage rehashes it. It is an
authenticated administrator read operation and never reserves or executes a job.
The server rereads the canonical bundle before and after artifact storage IO.

The existing #690 executor result must match the exact formula candidate,
formula hash, parameter identity, dataset and TRAIN period, with holdout and all
execution authority disabled. A `PASS` string alone cannot complete a candidate.
The original result is passed unchanged as the third argument to
`ResearchSubmissionStore.complete(key, receipt, artifact)`, with its canonical
SHA-256 on the receipt. Store implementations must retain both atomically.
No financial metric is recalculated by the Copilot or sent to AI.

An owner-provided `ResearchSubmissionStore.read(key)` returns the stored receipt
and artifact. Readback revalidates receipt binding, result digest, identity,
period, authority and time. Only this independent read can produce
`publicationStatus=READBACK_VERIFIED`; historical completion alone remains
`MISSING_EVIDENCE`. Missing readers/publications and failed/corrupt reads are
explicit and never trigger a resubmission. The default runtime has no connected
catalog/store, so remains `BLOCKED_DATA`. Injected test stores prove the contract,
not production durability or genuine evidence.

The UI exposes a working result-readback action and candidate-specific identity
details, and keeps OOS/WF/Holdout, model/features/trial, Shadow/Forward,
independence and full-cost/Health gaps explicit. Whole-registry stage counts and
operational Health summaries are labeled separately from this candidate.
Provider refresh failure removes cached evidence instead of leaving it visible
as fresh. Tested sizes: 1440×900, 1024×768, 320×740, 360×800, 390×844, 412×915,
430×932. No production deployment, model tuning, owner-engine change or approval
authority is part of this work.
