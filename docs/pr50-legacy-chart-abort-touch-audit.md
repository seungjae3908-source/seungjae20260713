# PR #50 legacy chart abort and touch audit

## Scope

This audit covers the active non-embedded mobile `/scanner` paths that mount `ChartBroadcastPanel` in `viewMode === "chart"` and `viewMode === "auto"`.

It does not change or validate production deployment, staging deployment, servers, databases, secrets, real accounts, or real orders. `CryptoTradingWorkspace` remains read-only in this work item.

## Request call graph

### Legacy ChartBroadcastPanel

1. `ChartBroadcastPanel`
2. TanStack Query chart query
3. `queryFn({ signal })`
4. `fetchChart(ticker, timeframe, signal)`
5. `authorizedFetch(url, { cache: "no-store", signal })`
6. browser `fetch(input, RequestInit)`

The market context request follows the same pattern:

1. `ChartBroadcastPanel`
2. TanStack Query market-context query
3. `queryFn({ signal })`
4. `fetchMarketContext(market, signal)`
5. `authorizedFetch(..., { cache: "no-store", signal })`
6. browser `fetch`

`authorizedFetch` preserves the supplied `RequestInit`, so the query signal reaches the real browser request. The legacy path has no separate timeout controller, therefore there is no external/timeout signal composition in this component.

When the chart request is aborted, `fetchChart` rethrows immediately when `signal.aborted` is true. It does not continue to the fallback `/candles` endpoint and does not convert cancellation into the chart error UI.

### UnifiedAnalysisChart difference

The unified chart path already received the query signal and passed it into `fetchUnifiedChartData`. Its request layer additionally links the external signal with an internal timeout controller and classifies aborts separately from provider and HTTP failures.

The legacy fix intentionally did not replace its query structure or adopt the unified request layer. It only completed the missing signal propagation while preserving the existing URLs, query keys, props, payload normalization, callbacks, and chart results.

## Signal audit table

| Stage | File | Function | Receives signal | Passes signal | Real fetch connection | Result |
| --- | --- | --- | --- | --- | --- | --- |
| React Query chart query | `stock-analyzer/src/components/chart-broadcast.tsx` | chart `useQuery` | Yes | Yes | Indirect | Complete |
| Legacy chart helper | `stock-analyzer/src/components/chart-broadcast.tsx` | `fetchChart` | Yes | Yes | Indirect | Complete |
| Market context query | `stock-analyzer/src/components/chart-broadcast.tsx` | market-context `useQuery` | Yes | Yes | Indirect | Complete |
| Market context helper | `stock-analyzer/src/components/chart-broadcast.tsx` | `fetchMarketContext` | Yes | Yes | Indirect | Complete |
| Authenticated fetch wrapper | `stock-analyzer/src/lib/auth-fetch.ts` | `authorizedFetch` | Through `RequestInit` | Yes | Yes | Complete |
| Browser request | native `fetch` | `fetch` | Yes | N/A | Yes | Confirmed by Playwright |

## Stale-response protection versus HTTP abort

Before this work, changing the timeframe or market prevented the older result from replacing the latest visible chart, but the obsolete HTTP request remained in flight. That was stale-response protection only.

The final contract now proves both properties independently:

- the latest 15-minute or overseas response remains visible;
- the obsolete delayed 1-minute browser request emits an actual aborted-request event.

The test does not treat ordinary stale-result suppression as proof of cancellation and does not add an abort error to an ignore list.

## Independent browser contract

File: `stock-analyzer/e2e/scanner-chart-abort-touch.spec.ts`

The isolated contract:

- opens the real mobile `/scanner` route with a deterministic approved-user mock;
- mounts the legacy chart panel through the `AI 차트 분석기` control;
- delays a 1-minute request;
- changes to 15 minutes and confirms one actual aborted request;
- starts another delayed 1-minute request;
- changes the market and confirms a second actual aborted request;
- confirms cancellation does not render the generic chart error state;
- confirms only the latest chart value is rendered;
- confirms zero unexpected request failures;
- confirms zero order-like POST requests.

The final successful run confirmed two actual chart aborts: one for timeframe replacement and one for market replacement.

## Mobile touch geometry

The contract measures visible DOM bounding boxes at `390 × 844` and rechecks the timeframe control after changing to `844 × 390`.

Final measurements:

| Control | Width | Height | Result |
| --- | ---: | ---: | --- |
| AI chart mode | 114px | 44px | Pass |
| Auto-trading mode | 114px | 44px | Pass |
| Domestic market | 175px | 44px | Pass |
| Overseas market | 175px | 44px | Pass |
| Live refresh toggle | 121px | 44px | Pass |
| Stock search input | 324px | 44px | Pass |
| Chart refresh | 44px | 44px | Pass |
| 1-minute timeframe | 44px | 44px | Pass |
| 15-minute timeframe | 51px | 44px | Pass |
| Retry | 83px | 44px | Pass |
| Landscape 15-minute timeframe | 51px | 44px | Pass |

The test also confirms that paired mode and market controls do not overlap and that neither portrait nor landscape produces document-level horizontal overflow.

The CSS change is limited to active scanner mode/market controls and legacy chart live-refresh, refresh, timeframe, and retry controls. It does not globally force every icon or secondary control to 44px.

## Intermediate diagnostic results

The initial diagnostic run correctly failed because the delayed 1-minute request was not aborted. A second diagnostic run let the geometry test execute and found the AI chart mode button at 38px height. Neither run was counted as a successful final result.

The later cancelled run was superseded by a newer branch HEAD and was also not counted as success.

## Conflict boundary

The added browser contract and this document are PR #50-specific. The implementation files changed in this step do not directly overlap the latest changed-file lists of PR #51, PR #52, PR #58, or PR #61.

Shared files such as `phase11-ai-workspace.spec.ts`, `playwright.config.ts`, and `api-server/test.mjs` were not modified during this step.

## Remaining cleanup

### CryptoTradingWorkspace

`stock-analyzer/src/components/crypto-trading-workspace.tsx` still contains:

- a `Date.now()` fallback for invalid timestamps;
- generated one-minute spacing for missing timestamps;
- forced high/low correction;
- chart, signal, and order-decision responsibilities in one component.

It must remain outside PR #50 for this task. After production deployment and post-deployment health verification are complete, a separate cleanup candidate is:

`fix/crypto-chart-candle-normalization`

That follow-up should cover spot and futures providers, `1W`, `quoteVolume`, completed-candle semantics, invalid OHLC removal, analysis changes, paper/live separation, approval gates, and zero-order-on-entry browser contracts.

### Integration after production work

After production work is fully complete:

1. re-read the then-current `main` and PR #50 HEAD;
2. obtain explicit approval before bringing current main into the feature branch;
3. resolve conflicts without copying unrelated Draft PR implementations;
4. rerun typechecks, unit tests, both legacy chart contracts, unified chart contracts, full desktop/mobile Playwright, builds, and all six required statuses;
5. keep PR #50 Draft until a separate review/merge approval is given.
