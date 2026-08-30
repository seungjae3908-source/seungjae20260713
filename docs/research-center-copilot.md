# Research Center Copilot

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
- POST `/validate-dsl` invokes the existing `createSafeStrategyDslV1`. Its identity
  is the canonical DSL digest; a valid DSL remains `NOT_EVALUATED`.
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
2. A validated P1 DSL is not yet bound to the canonical backtest dispatcher's
   immutable dataset, frozen split, cost and risk policy. No fake queue entry is
   created. The UI explicitly reports `CANONICAL_BACKTEST_BINDING` missing.
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
