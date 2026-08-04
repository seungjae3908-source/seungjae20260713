# Gemini integration design for chart, scanner, and trade automation

## Status and scope

This document implements the Agent Hub design-only command for the following Draft pull requests:

- PR #50: deterministic AI chart broadcast
- PR #52: AI scanner signal and approval lifecycle
- PR #51: cost-aware approval and trade automation guardrails
- PR #65: free Gemini provider for public AI chat

Repository state inspected on 2026-08-04:

- current `main`: `ddc679065781e40f46dc6f13962d6039bccd4e58`
- PR #50 HEAD: `106aef677720cafd5c370ec735d76894c0291581`
- PR #52 HEAD: `8d7e3e8083ec88ac0d4ce19c30d0a4aa9a55940d`
- PR #51 HEAD: `a3ee12b46f8c74313476342664a625ac537d9871`
- PR #65 pre-document HEAD: `69e66a99ae53a9377bb561180e205b47ff836abf`

This work changes documentation only. It does not modify product code, routes, tests, deployment, server configuration, databases, secrets, account access, or order execution.

## Decision

Gemini can support all three features, but it must not become the source of truth for chart calculations, scanner states, approval decisions, risk limits, order plans, queues, or execution.

The final authority remains:

1. PR #50 deterministic candle, indicator, pattern, and analysis engines.
2. PR #52 deterministic signal lifecycle, expiry, invalidation, capability, and server revalidation.
3. PR #51 deterministic expected-value, risk sizing, policy, idempotency, queue, adapter, and live-gate engines.

Gemini is an optional read-only explanation and review layer above those outputs.

A Gemini failure, timeout, malformed answer, quota exhaustion, or disabled configuration must never:

- change a chart analysis state;
- create or upgrade a scanner signal;
- enable an approval button;
- create or mutate a trading plan;
- enqueue, submit, retry, cancel, or close an order;
- select Paper or live execution;
- weaken an existing deterministic safety block.

## Why the existing public chat contract is not enough

PR #65 currently exposes a safe public-information contract through `answerAiChat()` and `/api/ai/chat`.

The existing `AiChatContext` contains only:

- market;
- symbol;
- display name.

The service can collect public KR and US quote, company, news, and financial context. It intentionally does not accept chart engine objects, scanner lifecycle objects, trading plans, approval tokens, account state, or execution state.

Reusing `/api/ai/chat` directly for feature decisions would be unsafe because:

- the output is free-form text rather than a task-specific validated schema;
- the route does not know the authoritative chart, signal, or trade-plan version;
- the route cannot prevent stale feature context supplied by the browser;
- the current public context collector does not cover deterministic chart and lifecycle outputs;
- a free-form answer must not be interpreted as a state transition or order instruction.

The public chat route should remain a question-and-summary surface. Feature integration should use separate read-only task contracts built on the same provider adapter.

## Target architecture

### Shared provider layer

After the relevant feature PRs are integrated, extract the provider-specific request code from the public chat implementation into a shared server-only adapter.

Suggested file:

`api-server/src/services/ai-provider.service.ts`

Suggested responsibilities:

- resolve Gemini or explicit OpenAI-compatible provider configuration;
- keep API keys server-only;
- send text or structured JSON tasks;
- join external cancellation with the server timeout;
- map 429, provider failure, timeout, and malformed responses;
- apply output length limits;
- reject unsafe output;
- expose no account, order, deployment, server, GitHub, or tool authority.

Suggested provider methods:

```ts
generatePublicText(task: PublicAiTask): Promise<PublicAiTextResult>
generatePublicJson<T>(task: StructuredPublicAiTask<T>): Promise<T>
```

The provider adapter must not import chart, scanner, approval, queue, broker, or exchange services. Feature services prepare sanitized public inputs and validate task-specific outputs.

### Task separation

Use separate tasks and system instructions instead of one universal prompt.

Suggested task names:

- `public_financial_question`
- `chart_analysis_explanation`
- `scanner_signal_explanation`
- `trade_plan_risk_explanation`

Every result should include:

- `task`;
- `taskVersion`;
- `sourceVersion` or deterministic input hash;
- `model`;
- `generatedAt`;
- `advisoryOnly: true` for feature tasks;
- task-specific validated content.

The model must never return executable commands, state transition requests, approval tokens, idempotency keys, or order actions.

## PR #50: chart explanation

### Authoritative source

PR #50 already owns:

- candle timestamp and OHLC validation;
- sorting and duplicate removal;
- completed-candle handling;
- SMA, EMA, RSI, MACD, ATR, Bollinger, VWAP, and volume calculations;
- pattern direction;
- stable analysis ID;
- analysis status;
- bias;
- confidence;
- reasons;
- confirmation conditions;
- invalidation conditions;
- transition history.

Gemini must consume those results. It must not calculate a replacement RSI, pattern, status, bias, confidence, support, resistance, target, or stop.

### Server input contract

Suggested sanitized input:

```ts
type ChartExplanationInput = {
  analysisId: string;
  engineVersion: string;
  market: 'KR' | 'US' | 'UPBIT' | 'BITGET';
  symbol: string;
  displayName?: string;
  timeframe: string;
  dataAsOf: string;
  dataStatus: string;
  status: ChartAnalysisStatus;
  bias: ChartAnalysisBias;
  confidence: number;
  title: string;
  summary: string;
  reasons: string[];
  confirmationConditions: string[];
  invalidationConditions: string[];
  indicators: Record<string, number | string | boolean | null>;
};
```

Do not send raw candle arrays by default. The deterministic engine output is smaller, safer, cheaper, and sufficient for explanation. A later visual-pattern task may use a bounded set of normalized points, but only after a separate schema and token-cost review.

### Model output contract

Suggested output:

```ts
type ChartExplanation = {
  plainSummary: string;
  bullishFactors: string[];
  bearishFactors: string[];
  confirmationWatch: string[];
  invalidationWatch: string[];
  limitations: string[];
  advisoryOnly: true;
};
```

The server must reject output containing:

- a changed status, bias, or confidence;
- guaranteed direction language;
- direct buy, sell, leverage, or position instructions;
- fabricated prices or indicators not present in the input.

### UI placement

Do not implement the feature directly in PR #50 or PR #52 now.

PR #50 and PR #52 both change `stock-analyzer/src/pages/ai-chart.tsx`:

- PR #50 owns the complete chart page rewrite and `UnifiedAnalysisChart`.
- PR #52 inserts `ScannerApprovalComposer` into the legacy page.

Final page integration order:

1. keep PR #50 page and chart structure as the base;
2. manually insert PR #52 `ScannerApprovalComposer` using the final selection and analysis contracts;
3. mount a new `ChartAiExplanationPanel` below the deterministic analysis display;
4. keep the explanation panel independent of approval and order components.

Suggested new component:

`stock-analyzer/src/components/chart-ai-explanation-panel.tsx`

The component should receive a completed deterministic `ChartAnalysis` object. It must not receive setters for analysis state, approval state, trade plans, or queues.

### Trigger and free-tier control

Do not call Gemini on every candle, refresh, or background poll.

Use one of these triggers:

- explicit `AI 설명 생성` button; or
- one automatic request only when a new stable `analysisId` reaches an eligible state, with user opt-in.

Cache by:

`analysisId + engineVersion + locale`

A market or timeframe change must cancel the obsolete explanation request and must not clear or alter the deterministic chart result.

### Failure behavior

On 429, timeout, malformed output, or provider failure:

- keep the chart and deterministic analysis visible;
- show an explanation-unavailable state;
- allow a later retry;
- do not create a substitute analysis;
- do not change the approval composer;
- send zero order-like requests.

## PR #52: scanner signal explanation

### Authoritative source

PR #52 owns:

- signal detection inputs;
- signal state lifecycle;
- `WATCHING`, `READY_FOR_APPROVAL`, `WEAKENED`, `INVALIDATED`, and `EXPIRED`;
- score and confidence minimums;
- core-condition maintenance;
- data freshness;
- expiry;
- risk-reward minimum;
- server revalidation;
- approval availability;
- invalidation reasons;
- signal alerts and delivery lifecycle;
- market capability checks.

Gemini must not set or override any of these fields.

### Server loading boundary

The browser should send only a signal or plan identifier. The server must load the user-scoped authoritative record and construct the sanitized input.

Do not accept browser-provided replacements for:

- score;
- confidence;
- state;
- approval enabled;
- expiry;
- data timestamp;
- risk reward;
- invalidation reason;
- market capability.

Suggested route:

`POST /api/trade-automation/scanner/signals/:signalId/ai-explanation`

This route must be mounted after authentication and the relevant capability check. It must be read-only and must not share a handler with plan creation or approval.

### Sanitized input contract

```ts
type ScannerSignalExplanationInput = {
  signalId: string;
  signalRevision: string;
  market: 'KR' | 'US' | 'UPBIT' | 'BITGET';
  symbol: string;
  displayName?: string;
  timeframe: string;
  state: TradingSignalState;
  reasonCode: string;
  score: number;
  confidence: number;
  riskReward: number | null;
  coreConditionsMaintained: boolean;
  reasons: string[];
  warnings: string[];
  dataTimestamp: string;
  expiresAt: string;
  matchedConditions: string[];
  publicNewsSummary?: PublicNewsSummary;
};
```

Do not send approval tokens, monitor tokens, internal user IDs, idempotency keys, credentials, balances, holdings, or private exchange responses.

### Model output contract

```ts
type ScannerSignalExplanation = {
  plainSummary: string;
  supportingFactors: string[];
  riskFactors: string[];
  whyApprovalIsEnabledOrBlocked: string;
  nextDeterministicChecks: string[];
  limitations: string[];
  advisoryOnly: true;
};
```

The explanation may describe the authoritative state. It may not return a new state or recommend bypassing a block.

### UI placement

Suggested new component:

`stock-analyzer/src/components/scanner-signal-ai-explanation.tsx`

Mount it in the scanner signal detail or approval composer as a sibling read-only panel. Do not place model output inside the approval button logic.

`ScannerApprovalComposer` must continue to derive enabled or disabled state only from the PR #52 server contract.

### Free-tier control

Do not send every scanned candidate to Gemini. The deterministic scanner should reduce the market to candidates first.

Eligible calls:

- user opens one candidate and requests an explanation;
- a signal reaches `READY_FOR_APPROVAL` and an opt-in alert summary is needed;
- a state changes to `WEAKENED`, `INVALIDATED`, or `EXPIRED` and the user opens the reason.

Cache by:

`signalId + signalRevision + state + dataTimestamp`

A new lifecycle event invalidates the previous explanation.

### Failure behavior

On AI failure:

- keep the signal state and approval decision from PR #52;
- display deterministic reasons and warnings;
- show the AI explanation as unavailable;
- do not create or approve a plan;
- do not send an alert claiming the state changed;
- send zero order-like requests.

## PR #51: trade-plan risk explanation

### Authoritative source

PR #51 owns:

- expected value after costs;
- strategy sample requirements;
- profit factor and drawdown limits;
- risk budget;
- maximum order size;
- stop-distance checks;
- entry-zone checks;
- spread and slippage limits;
- daily loss and correlated exposure limits;
- pilot-stage restrictions;
- plan and order idempotency;
- queue and execution state;
- Paper, mock, and live adapters;
- live gates and emergency stop.

Gemini must not calculate the executable quantity, change order prices, weaken a block code, select an adapter, create a queue item, or submit an order.

### Read-only service boundary

Suggested service:

`api-server/src/services/trade-plan-ai-review.service.ts`

The service receives a server-loaded plan plus the already-computed PR #52 lifecycle evaluation and PR #51 optimization assessment.

It must not import or call:

- order submission methods;
- broker or exchange adapters;
- queue mutation methods;
- approval transitions;
- cancel or close-position handlers.

Suggested route:

`POST /api/trade-automation/plans/:planId/ai-risk-explanation`

The route should load the user-scoped plan, recompute deterministic lifecycle and risk assessments, sanitize the result, and ask Gemini only to explain it.

### Sanitized input contract

```ts
type TradePlanExplanationInput = {
  planId: string;
  planRevision: string;
  market: string;
  symbol: string;
  side: 'buy' | 'sell' | 'long' | 'short';
  accountMode: 'paper' | 'live';
  planState: string;
  signalState: TradingSignalState;
  approvalEnabled: boolean;
  approvalReasonCode: string | null;
  optimizationAllowed: boolean;
  blockCodes: string[];
  warnings: string[];
  expectedValueR: number | null;
  stopDistancePercent: number | null;
  riskBudgetPercent: number | null;
  proposedExposurePercent: number | null;
  entryZoneStatus: string;
  pilotStage: string;
};
```

Do not send:

- account balances;
- actual holdings;
- credentials;
- approval nonce or token;
- idempotency key;
- internal user ID;
- private exchange payloads;
- raw logs;
- full account history.

Prefer percentages and categorical states over absolute private account amounts.

### Model output contract

```ts
type TradePlanRiskExplanation = {
  plainSummary: string;
  blockingReasonsExplained: string[];
  riskNotes: string[];
  planChecklist: string[];
  dataLimitations: string[];
  advisoryOnly: true;
};
```

The output must not contain executable order instructions, a replacement quantity, a changed approval decision, or claims that a block can be ignored.

### UI placement and PR #51/#52 conflict

PR #51 and PR #52 directly conflict in:

- `api-server/src/services/trade-automation.repository.ts`
- `api-server/src/services/trade-automation.service.ts`
- `api-server/src/services/trade-automation.types.ts`
- `api-server/test.mjs`
- `stock-analyzer/e2e/phase12-trade-automation.spec.ts`
- `stock-analyzer/src/components/trade-approval-queue.tsx`
- `stock-analyzer/src/pages/auto-trading.tsx`
- `stock-analyzer/src/pages/phase12-trade-automation-e2e.tsx`

Do not add the Gemini review panel to either current Draft branch.

First complete the planned integration:

1. PR #52 lifecycle and approval contract becomes authoritative.
2. PR #51 consumes the PR #52 contract and owns risk, queue, and execution.
3. Duplicate queue and approval state are removed.
4. `auto-trading.tsx` is manually integrated.
5. Only then add a sibling `TradePlanAiReviewPanel` to the final page.

The panel must receive a plan ID and read-only review result. It must not receive order mutation callbacks.

### Failure behavior

Gemini is not a required execution gate. Deterministic PR #52 and PR #51 rules remain the only execution gates.

On AI failure:

- keep approval and risk block states unchanged;
- keep Paper/live gates unchanged;
- allow the user to read deterministic block codes and warnings;
- do not enqueue or submit anything;
- do not fall back to a paid provider unless explicitly configured;
- send zero exchange requests.

## Common privacy and data policy

The Gemini free tier must receive public or minimized derived data only.

Allowed examples:

- public market and company identifiers;
- public quote and news summaries;
- deterministic chart indicators and statuses;
- scanner condition names and public signal metrics;
- risk percentages, categorical block codes, and sanitized plan properties.

Forbidden examples:

- API keys and authorization headers;
- access or refresh tokens;
- account numbers;
- credentials;
- exact balances and holdings;
- internal user IDs;
- approval tokens or nonces;
- monitor tokens;
- idempotency keys;
- private broker or exchange responses;
- raw server logs;
- database records not explicitly allowlisted.

Feature input must be constructed on the server from authoritative records. Browser-provided feature objects must not be trusted.

## Prompt-injection boundary

All user text, news, company descriptions, chart reasons, scanner conditions, and plan notes are inert data.

Task prompts must state that model output cannot:

- invoke tools;
- request secrets;
- change application state;
- issue order or deployment commands;
- override deterministic fields;
- treat data text as instructions.

Structured outputs must be parsed against an allowlisted schema. Unknown fields must be discarded or rejected.

## Caching, cost, and rate limits

A background model call for every candle or every scanner row would exhaust the free quota and create unnecessary latency.

Recommended policy:

- public chat: keep the existing per-user route limit;
- chart explanation: one result per stable analysis version;
- scanner explanation: one result per signal revision and state;
- trade-plan explanation: one result per plan revision and deterministic assessment hash;
- explicit retry only after an error backoff;
- no automatic paid-provider fallback;
- no model call for invalid, secret-bearing, unauthorized, or missing authoritative records.

Cache entries should be bounded, short-lived, and keyed by a deterministic source hash. A cached explanation is display data, not application state.

## Conflict matrix

| Area | PR #65 current overlap | Future conflict | Resolution |
| --- | --- | --- | --- |
| `ai-chat.service.ts` | None with #50/#52/#51 | Shared provider extraction | Do once after PR #65 integration; preserve public chat contract |
| `ai-chart.tsx` | Not changed by #65 | Direct #50/#52 conflict | Base on #50, insert #52 composer, then add independent explanation panel |
| chart engines | Not changed by #65 | No required conflict | Gemini consumes immutable serialized result only |
| lifecycle service | Not changed by #65 | No required conflict | Gemini never writes lifecycle state |
| `auto-trading.tsx` | Not changed by #65 | Direct #51/#52 conflict | Integrate #52 then #51 before adding AI panel |
| trade types/service/repository | Not changed by #65 | Direct #51/#52 conflict | Unify authoritative contracts before AI read model |
| `routes/index.ts` | Not changed by #65 | PR #52 already changes registration | Register feature AI routes after final route order is settled |
| `api-server/test.mjs` | Not changed by #65 | #50/#51/#52 all touch it | Prefer standalone tests, then manually register once after integration |
| Phase 12 E2E | Not changed by #65 | #51/#52 direct conflict | Add feature AI E2E after final Phase 12 fixture exists |

Current PR #65 changed files:

- `api-server/src/services/ai-chat.service.ts`
- `api-server/src/services/ai-chat.service.test.ts`
- `docs/free-gemini-ai-chat.md`

There is no direct current changed-file overlap with PR #50, PR #52, or PR #51.

## Implementation sequence after current deployment restrictions end

The safest sequence is:

1. finish production deployment and post-deployment health verification;
2. separately approve and integrate PR #65 provider foundation;
3. integrate PR #50 deterministic chart functionality;
4. integrate PR #52 signal lifecycle and approval contract;
5. integrate PR #51 against the final PR #52 contract;
6. verify one lifecycle, one approval queue, one trade service, and one execution path;
7. create a separate Draft PR such as `feature/gemini-feature-explanations`;
8. extract the shared server-only AI provider adapter without changing public chat behavior;
9. implement chart explanation first;
10. implement scanner explanation second;
11. implement trade-plan risk explanation last;
12. run mock-only route and browser tests before any runtime secret mapping;
13. keep runtime secret mapping and deployment as separate approval-required work.

A single later integration PR is safer than adding different Gemini adapters to PR #50, #52, and #51 because it avoids duplicated provider code and allows testing against the final feature contracts.

## Required direct tests

### Shared provider

- Gemini request shape;
- key only in request header;
- key absent from prompt and response;
- timeout and cancellation;
- 429 mapping;
- provider 4xx and 5xx mapping;
- malformed JSON;
- empty candidates;
- unsafe output;
- prompt injection text treated as data;
- no paid fallback;
- no live key in unit or route tests.

### Chart

- explanation uses the current analysis ID and version;
- stale explanation cannot overwrite a newer analysis;
- changed market or timeframe aborts the old request;
- malformed or failed AI response leaves chart state unchanged;
- model output cannot replace status, bias, confidence, indicators, or price levels;
- invalid or empty chart data creates no AI call;
- order-like requests: zero.

### Scanner

- server loads the user-scoped signal;
- forged browser state is ignored;
- invalidated and expired states remain blocked;
- changed signal revision invalidates the old explanation;
- AI failure leaves approval enabled or blocked exactly as determined by PR #52;
- unauthorized market access creates no provider call;
- approval and order mutations: zero.

### Trade plan

- server loads the user-scoped plan;
- exact account balances, credentials, tokens, and idempotency keys are absent;
- deterministic block codes remain authoritative;
- AI cannot change amount, quantity, prices, state, queue, or adapter;
- repeated review calls do not create plans or orders;
- Paper adapter calls: zero from the review route;
- live adapter calls: zero;
- exchange requests: zero.

### Browser and full regression

For desktop and mobile:

- loading, success, quota, timeout, malformed, and retry states;
- existing deterministic content remains visible during AI errors;
- no console error or page error;
- no unexpected HTTP errors;
- no horizontal overflow;
- major controls maintain 44px touch targets;
- no approval-state or order-state mutation from explanation UI;
- all existing chart, scanner, approval, queue, Paper, and live-gate tests remain successful.

Any intermediate failure must be reported, corrected at its cause, and rerun. A run where later jobs were skipped due to an earlier failure must not be reported as successful.

## Completion criteria for the later implementation PR

- one shared provider adapter;
- separate task-specific services and schemas;
- no duplicate Gemini implementation in feature components;
- deterministic chart, lifecycle, risk, and execution authority unchanged;
- all feature inputs server-authoritative and sanitized;
- no secrets or private account data sent to the provider;
- graceful free-quota and outage behavior;
- mock-only direct Express route tests;
- direct desktop and mobile browser tests;
- full typecheck, unit, smoke, build, security, privacy, RLS, and Playwright success;
- six required statuses successful;
- zero real account, live adapter, exchange, or order requests;
- Draft state maintained until separate review and merge approval.

## Current conclusion

All three features can use Gemini safely if Gemini remains an advisory explanation layer.

The recommended mapping is:

| Feature | Gemini role | Deterministic authority |
| --- | --- | --- |
| AI chart | Explain chart state, reasons, confirmation, invalidation, and limitations | PR #50 chart engines |
| AI scanner | Explain why a signal is active, weakened, invalidated, expired, or approval-eligible | PR #52 lifecycle and server revalidation |
| Trade automation | Explain deterministic risk blocks, expected value, sizing limits, and plan checklist | PR #52 approval contract plus PR #51 risk and execution engines |

No Gemini output may directly alter a state or cause an order. This preserves functionality when the free provider is unavailable and prevents model errors from bypassing the existing safety architecture.
