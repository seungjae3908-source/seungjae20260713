# Feature Integration Readiness Audit — 2026-08-04

This document records a read-only, diff-hunk-based integration audit for the application feature Draft PRs. It does not authorize or perform a merge, rebase, cherry-pick, deployment, database change, Secret change, server action, account access, or order submission.

## Verified baseline

- Repository: `seungjae3908-source/seungjae20260713`
- Latest verified `main`: `1987b74799d213b63d065c63a7c8c3b675a863f4`
- All feature PRs below remain open and Draft.
- Every relevant feature PR has the six required status contexts in `success` at its verified HEAD.

| PR | Purpose | Branch | Verified HEAD | Relation to main | Changed files | Latest verification |
| --- | --- | --- | --- | --- | ---: | --- |
| #50 | Realtime AI chart broadcast | `feature/realtime-ai-chart-broadcast` | `bf585de48d208df7f03848977c92ff370c2745dc` | diverged, ahead 29, behind 4 | 17 | Application CI `30888876383` success |
| #51 | Cost-aware auto-trading optimization guardrails | `agent/auto-trading-optimization-guardrails` | `280fbe1c857e4365524b38f9fb08635a431b1653` | diverged, ahead 25, behind 3 | 17 | Application CI `30883147603` success |
| #52 | AI scanner approval signal lifecycle | `agent/ai-scanner-approval-lifecycle` | `65a01be54d3f5b1cc5fd8673cc0e43ceaec49aa5` | diverged, ahead 72, behind 4 | 38 | Application CI `30888595069` success |
| #54 | Paper-only scanner approval workflow | `feature/ai-scanner-approval-system` | `3ea3bf87326e831a96e9fe2cd44e6722bf9c0310` | diverged, ahead 16, behind 3 | 14 | Application CI `30883872105` success |
| #56 | Information-tab runtime hardening | `feature/stock-info-self-analysis-v1` | `17bbf2886dc529b83e4553783c5f6c32bb4175c8` | ahead 2, behind 0 | 12 | Application CI `30889441324` success |
| #58 | Unified asset search | `feature/unified-asset-search` | `67f8d318091304495320e592740fb48e9255a557` | diverged, ahead 39, behind 1 | 20 | Application CI `30890741085` and search validation `30890741293` success |
| #61 | UI/navigation integration contract | `feature/app-ui-navigation-cleanup` | audit start `a7e5af027a739d39186e2693a2affcc0e00d37c5` | diverged, ahead 7, behind 1 | 4 before this document | Application CI `30894070455` success |

The isolated prediction lab (#4), command hub (#5), and deployment automation (#9) remain outside this application-feature integration sequence.

## Final responsibility boundaries

| Function | Responsible PR | Boundary |
| --- | --- | --- |
| Candle normalization, indicator/structure calculation, chart state, chart-specific race/error handling | #50 | Must not own scanner approval state or order policy. |
| Scanner conditions, signal lifecycle, approval availability, server revalidation, approval alerts, Paper approval state | #52 | Final owner of scanner approval state, DTOs, routes, repository list contract, and approval queue lifecycle. |
| Expected value, risk sizing, pilot stages, strategy economics, optimization policy and emergency-resume constraints | #51 | Must plug into #52 lifecycle; must not create a second approval queue, signal-state enum, or plan-list contract. |
| General Korean/English/ticker/code/coin search, autocomplete, IME, index/cache/provider sync and detail-route helper | #58 | Must not include AI scanner conditions or order logic. |
| Information-tab error/stale/market identity and defensive response normalization | #56 | Must preserve expanded #51 policy fields when integrated. |
| App navigation, route grouping, placement and accessibility | #61 | Must consume feature public interfaces and never copy feature business logic. |
| Staged Paper entry calculation from #54 | #52 extension, not a standalone second lifecycle | Only the unique 1/2/3-leg continuation logic may be extracted later into an independent service under #52 types/routes. |

## Diff-hunk conflict matrix

Conflict types:

- A: same file and same code region
- B: same file but different code region
- C: no direct file conflict but duplicate responsibility
- D: copied/reimplemented responsibility
- E: integration-only route, permission or navigation conflict
- F: no direct conflict

| File | Related PRs | Type | Purpose by PR | Responsible PR | Integration handling |
| --- | --- | --- | --- | --- | --- |
| `stock-analyzer/src/App.tsx` | #52, #54, #56, #58 | A/B/E | #52/#54 add scanner test and approval routes; #56 adds info E2E bypasses; #58 replaces general search routes and preserves rankings/browser | #58 search routes; #52 approval test route; existing shell | Start from the integrated search route block, add only the surviving #52 test route and #56 test gates, and do not retain a second #54 approval route. |
| `stock-analyzer/src/pages/technical-workspace.tsx` | #52, #54 | A/C/D | #52 owns market/capability/saved-search workspace; #54 inserts a separate approval entry | #52 | Keep #52 workspace. Expose staged-entry behavior through #52 components rather than retaining #54 page routing. |
| `stock-analyzer/src/pages/ai-chart.tsx` | #50, #52 | A | #50 rewrites chart page/state; #52 inserts approval composer | #50 structure, #52 composer | Use #50 page as structural base, then insert #52 composer at the current-context/analysis boundary. |
| `stock-analyzer/src/pages/auto-trading.tsx` | #51, #52 | A/C | #51 adds optimization summary and candidate queue; #52 adds lifecycle alerts and approval queue | #52 lifecycle, #51 optimization fields | Keep one #52 lifecycle queue and render #51 economics/risk data inside it. |
| `stock-analyzer/src/components/trade-approval-queue.tsx` | #51, #52 | A/C/D | Incompatible queue DTOs, endpoints and signal-state models | #52 | Remove the duplicate #51 queue contract; extend #52 queue DTO with optional optimization assessment. |
| `stock-analyzer/src/components/trade-automation-settings.tsx` | #51, #56 | A/B | #51 expands policy/settings; #56 defensively normalizes partial status responses | #51 policy, #56 normalization | Normalize all #51 fields and nested maps without resetting optimization data to defaults after a refresh. |
| `stock-analyzer/src/pages/phase12-trade-automation-e2e.tsx` | #51, #52 | A/C | #51 fixture covers EV/pilot; #52 fixture covers lifecycle/alerts | combined test contract | Create one fixture containing both optimization and lifecycle objects. |
| `stock-analyzer/e2e/phase12-trade-automation.spec.ts` | #51, #52 | A/C | Both replace the same scenarios and assertions | combined test contract | Preserve lifecycle fail-closed assertions and optimization/pilot/emergency-resume assertions in one suite. |
| `stock-analyzer/playwright.config.ts` | #54, #56 | A | Same command line adds different E2E flags | test infrastructure | Retain `VITE_INFO_TAB_E2E`; add a scanner test flag only if a surviving #52 test route requires it. Do not keep a #54-only production route. |
| `api-server/src/routes/index.ts` | #52, #54, #58 | A/B/E | #52 intercepts scanner Paper approval and mounts lifecycle/alert routes; #54 mounts a second scanner router; #58 mounts unified search | #52 and #58 | Mount #52 scanner interceptor before generic trade automation, preserve #58 search after basic-info gate, drop duplicate #54 router. |
| `api-server/test.mjs` | #50, #51, #52, #54, #58 | A/B | Every PR registers feature tests; #58 also adds search mode and import-meta test define | integration test registry | Build the union of #50/#51/#52/#58 tests plus any extracted staged-entry test. Never choose one PR version wholesale. |
| `api-server/src/services/trade-automation.repository.ts` | #51, #52 | A/C/D | Both add `listPlans`, with different ordering/limits | #52 | Keep one user-scoped contract; expose enough records for approval queue and let #51 consume it. |
| `api-server/src/services/trade-automation.types.ts` | #51, #52, #54 | A/C/D | #51 defines optimization and lowercase signal state; #52 defines lifecycle state; #54 embeds its own scanner signal/nonce fields | #52 lifecycle plus #51 economics | One uppercase lifecycle state model; add economics/pilot fields; represent staged-entry metadata without importing a second scanner state machine. |
| `api-server/src/services/trade-automation.service.ts` | #51, #52 | A/C | Both modify plan creation, approval and order creation | #52 orchestration | Call #51 pure optimization evaluator from #52 transition gates; do not duplicate transition authority. |
| `api-server/src/services/trade-automation-risk.service.ts` | #51, #54 | B/E | #51 adds optimization evaluation; #54 adds US scanner Paper exception | #51 risk engine under #52 policy | Preserve optimization. Reintroduce only a narrowly typed Paper-only US simulation exception if #52 market requirements still need it. |
| `api-server/src/routes/scanner-approval.ts` | #52, #54 | A/C/D | Two independent scanner approval APIs and state machines | #52 | Keep #52 interceptor/revalidation API. Extract only #54 staged-entry calculations; no second nonce, router or state machine. |
| `api-server/src/routes/scanner-approval.smoke.test.ts` | #52, #54 | A/C | Same test path validates incompatible APIs | #52 | Rewrite as one #52 API suite plus staged-entry service tests. |
| `stock-analyzer/src/components/bottom-nav.tsx` | #61 | F/E | Five-group navigation and accessibility | #61 | Integrate last, after final route ownership is known. |

Direct same-region conflicts requiring manual resolution: 14 files. Major duplicate responsibility groups: 5.

## Active route inventory

| Route | Actual page/handler | Internal component/path | User reachable | Test-only | Legacy/status | Related PR |
| --- | --- | --- | --- | --- | --- | --- |
| `/`, `/home` | `HomePage` | Home search button currently goes to `/stocks` | yes | no | active | #58/#61 integration |
| `/stocks` | current `StocksPage`; #58 `UnifiedAssetSearchPage` | current stock/coin search; later unified component | yes | no | current implementation replaced by #58 | #58 |
| `/search` | current `SearchPage`; #58 unified search alias | current market-ranking filter | yes | no | ranking function moves to `/market-rankings` | #58/#61 |
| `/market-rankings` | #58 preserves old ranking page | `SearchPage` | after #58 | no | new route for existing function | #58 |
| `/market-browser` | #58 preserves old stock browser | `StocksPage` | after #58 | no | new route for existing function | #58 |
| `/stock/:ticker` | `DetailPage` | stock detail | yes | no | active | #58 selection target |
| `/stock-info` | `StockInfoAccess` | stock/coin information detail | yes | no | active | #56/#58 selection target |
| `/scanner` mobile | `ScannerAccess` -> `TechnicalWorkspacePage` -> `ScannerPage` | internal condition/chart/auto views; chart uses `ChartBroadcastPanel` | yes with `canAccessRiskPreview` | no | active | #50/#52 |
| `/scanner` desktop | same workspace | left embedded `ScannerPage`, right embedded `AiChartPage` | yes with capability | no | active | #50/#52 |
| `/ai-chart` | `AiChartAccess` -> `AiChartPage` | `ChartBroadcastPanel` plus later approval composer | yes with `canAccessRiskPreview` | no | active | #50/#52 |
| `/auto-trading` | `ScannerAccess` -> `TechnicalWorkspacePage` -> `AutoTradingPage` | official settings, queue and lifecycle screen | yes; #52 adds inner Paper capability handling | no | active | #51/#52 |
| Scanner internal `auto` view | no separate route | legacy candidate scorer plus stock live auto-trade controls | reachable inside `/scanner` | no | distinct from official `/auto-trading` | existing main, safety integration |
| `/__phase11-ai-workspace-e2e` | Phase 11 workspace fixture | search/chart integration fixture | no normal menu | yes | env-gated | #50/#58 tests |
| `/__phase11-ai-chat-e2e` | AI chat fixture | chat cancellation/refusal tests | no normal menu | yes | env-gated | existing Phase 11 |
| `/__phase11-technical-workspace-e2e` | technical fixture | desktop workspace and navigation | no normal menu | yes | env-gated | #50/#61 tests |
| `/__phase12-trade-automation-e2e` | Phase 12 fixture | automation/approval UI | no normal menu | yes | env-gated | #51/#52 |
| `/__phase12-scanner-markets-e2e` | scanner market fixture | stock/spot/futures capability cases | no normal menu | yes | env-gated | #52 |
| `/__scanner-approval-e2e` | #54-only fixture | duplicate scanner workflow | no normal menu | yes | should not survive as second product route | #54 |
| `/__phase11-unified-search-e2e` | unified search fixture | IME/request/order/group/detail tests | no normal menu | yes | env-gated | #58 |

Observed inactive UI branches in the existing scanner: two controls can open threshold/help state, but the corresponding content is guarded by constant-false render branches. They should be treated as inert UI until separately repaired; this audit does not change them.

## Order safety path audit

No order request was executed during this audit.

| Stage | Screen/client function | API | Permission/gates | Paper | Live-order possibility | Owner/risk |
| --- | --- | --- | --- | --- | --- | --- |
| Scanner internal stock entry | legacy scanner auto-view -> stock auto-trading helper | `/api/stocks/auto-trade/plan` then `/execute` | login, browser confirmation, execution key, `KIWOOM_AUTO_TRADE_ENABLED`, `KIWOOM_MODE=real`, market hours, score/risk/data/order limits | no | yes; server calls Kiwoom domestic/US order provider | existing main; HIGH, although default/server gates fail closed |
| Scanner internal stock exit | close helper | `/close-plan` then `/close-execute` | same key/mode/login/market-hours and one-time token | no | yes; market sell provider call | existing main; HIGH |
| Scanner position monitor | monitor helper | `/monitor` | login and execution key | no order | no; quote inspection and notification only | existing main; LOW |
| General approval plan creation | official `/auto-trading` | `/api/trade-automation/plans` | `canAccessPaperTrading`, user repository, policy and emergency-stop checks | supported | returns without order in approval mode | base/#52; LOW until approval |
| General approval click | approval queue | `/plans/:id/approve` | explicit `approved:true`, user scope, plan/risk gates, execution connection/mode gates | internal Paper fill | live is possible only with configured credentials and per-exchange live flag | #52/#51; MEDIUM/HIGH depending account mode |
| Scanner Paper approval | #52 queue/composer | scanner interceptor on `/plans/:id/approve` or `/approve-paper` | scanner Paper identity, user scope, fresh quote/condition revalidation, lifecycle approval gate | yes | no; response records `liveOrderSubmitted:false` and `exchangeRequestSent:false` | #52; LOW |
| Automatic plan creation | official settings in automatic mode | `/api/trade-automation/plans` | prior detailed policy confirmation, optimization/risk/emergency gates, configured connection and live flag | supported | can submit without another plan click when automatic live is enabled | #51/general engine; HIGH but default OFF and pilot-gated |
| Test paths | fixture/repository factories | mocked route handlers or Paper services | env-gated | yes | no intended outbound order | all feature tests; actual order requests must remain 0 |

The client does not call Bitget, Upbit or Kiwoom private APIs directly. Live requests originate only from the server execution services after account-mode, credential and environment gates.

## Integration order

This is a sequence recommendation only. It does not authorize any merge.

| Order | PR/work item | Requires first | Main conflict files | Pre-integration correction | Post-integration verification |
| ---: | --- | --- | --- | --- | --- |
| 1 | #58 unified search | none of the other feature PRs | `App.tsx`, routes index, test registry | Preserve old ranking/browser pages on their new routes and keep AI scanner logic out | search unit/API/fallback, IME, cancellation, all-market detail navigation, full CI 6/6 |
| 2 | #50 AI chart | #58 only for final shared App/test-registry resolution | `ai-chart.tsx`, `api-server/test.mjs` | Establish chart page and candle/indicator contracts before approval insertion | chart unit/structure/timeline tests, Phase 11 desktop/mobile, full CI |
| 3 | #52 scanner lifecycle and Paper approval | #50 for chart page insertion point | `App.tsx`, technical workspace, AI chart, auto-trading, routes, types, repository, service, test registry | Keep one lifecycle/queue/API; intercept scanner Paper before generic execution | lifecycle/revalidation/alerts, market permissions, Paper no-outbound contract, Phase 12, full CI |
| 4 | #54 unique staged-entry extraction only | #52 | scanner approval route/types/service/test | Do not integrate #54 as a second workflow. Move only pure staged-leg/continuation logic under #52 contracts | 1/2/3 leg unit tests, condition-loss cancellation, no second route/type/nonce, Paper-only outbound count 0 |
| 5 | #51 optimization guardrails | #52 and staged-entry contract | auto-trading page/queue, types, repository, service, risk, phase12 tests | Remove duplicate queue/state/listPlans; expose pure optimization assessment to #52 | EV/risk/pilot/emergency tests plus lifecycle approval regression and live fail-closed tests |
| 6 | #56 information runtime hardening | #51 policy shape should be final | `trade-automation-settings.tsx`, App test gates, Playwright config | Extend defensive normalization to every #51 policy field | info stale/error/market identity, settings refresh, full Playwright |
| 7 | #61 UI/navigation | all business routes and labels stable | BottomNav metadata and later App route metadata only | Point assets menu to #58 final routes; label official approval screen accurately; never expose test routes | navigation accessibility, active groups, all user routes, console/page/HTTP error checks, full CI |

## Integration gate after production work is separately complete

For each step, under a separately approved workflow:

1. Identify the then-current `main` SHA.
2. Update only the target feature branch under explicit approval.
3. Resolve the documented hunks manually; never select an entire conflicting file from one side.
4. Run frontend/backend typecheck, all unit/integration/API smoke tests, both production builds, desktop/mobile Playwright, PostgreSQL migration/RLS regression, security/outbound, AI privacy, and public Bitget smoke.
5. Confirm six required statuses at the exact resulting HEAD.
6. Confirm no unexpected console error, page error, unhandled rejection, HTTP error, private exchange call, account access or order request.
7. Keep Draft until a separate user decision.

This document is evidence and planning only. It does not change application behavior.