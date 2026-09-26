# App UI Navigation and Unified Search Integration

## Read-only baseline

Investigation date: 2026-08-04 (Asia/Seoul)

| Item | Verified state |
| --- | --- |
| Latest `main` | `1987b74799d213b63d065c63a7c8c3b675a863f4` |
| UI branch before this change | `feature/app-ui-navigation-cleanup@aab202273498af5d2db13f4328a9ebe9287f9a1c` |
| UI branch relation to `main` | ahead 0, behind 1 |
| UI Draft PR at investigation time | none |
| Unified search Draft PR | #58, open, Draft, mergeable |
| PR #58 HEAD | `67f8d318091304495320e592740fb48e9255a557` |
| PR #50 | open, Draft, HEAD `bf585de48d208df7f03848977c92ff370c2745dc`, ahead 29, behind 4 |
| PR #51 | open, Draft, HEAD `280fbe1c857e4365524b38f9fb08635a431b1653`, ahead 25, behind 3 |
| PR #52 | open, Draft, HEAD `65a01be54d3f5b1cc5fd8673cc0e43ceaec49aa5`, ahead 72, behind 4 |
| PR #58 | open, Draft, HEAD `67f8d318091304495320e592740fb48e9255a557`, ahead 39, behind 1 |

Verified CI runs:

- PR #50 Application CI `30888876383`: success
- PR #51 Application CI `30883147603`: success
- PR #52 Application CI `30888595069`: success
- PR #58 Application CI `30890741085`: success
- PR #58 Unified Search Branch Validation `30890741293`: success

No `main` merge, rebase, cherry-pick, deployment, database, Supabase, Secret, PM2, server, or order action is part of this UI work.

## Conflict matrix

| File | UI PR change | PR #58 change | Other PR change | Conflict type | Responsibility | Integration method |
| --- | --- | --- | --- | --- | --- | --- |
| `stock-analyzer/src/App.tsx` | none in this UI step | lazy import for unified search; `/stocks`, `/search`, `/market-rankings`, `/market-browser`; Phase 11 search E2E route | PR #52 adds Phase 12 scanner E2E import, wide-layout condition, and route | B with adjacent D risk | Search routes: #58. Phase 12 route: #52. Shell: existing app | Keep #58 general search routes. Add #52 test-only route and wide-layout entry without rewriting router blocks. UI branch must not redeclare search routes. |
| `stock-analyzer/src/components/bottom-nav.tsx` | five-group navigation, active state, keyboard menu, 44px touch target | none | none in #50-#52 | E | UI navigation | Consume existing active routes now. Change only route metadata after #58 integration. |
| `stock-analyzer/src/lib/app-navigation.ts` | new independent menu and route metadata | none | none | E | UI navigation | Keep search business types out. `UNIFIED_SEARCH_ROUTE_CONTRACT` stores route ownership boundaries only. |
| `stock-analyzer/src/pages/technical-workspace.tsx` | none | none | PR #52 changes stock/spot/futures workspace selection, capability gates, saved searches | E for UI branch | #52 | Do not move or duplicate. Navigation links only to `/scanner` and `/auto-trading`. |
| `stock-analyzer/src/pages/scanner.tsx` | none | none | none in #50-#52 | E | Existing scanner | Leave unchanged. |
| `stock-analyzer/src/pages/ai-chart.tsx` | none | none | PR #50 performs large chart-page rewrite; PR #52 inserts approval composer into the same page | A | Chart engine/UI: #50. Approval composer: #52 | Use #50 page as structural base, then insert #52 composer at the current-context/analysis boundary and rerun both PR test sets. |
| `stock-analyzer/src/pages/auto-trading.tsx` | none | none | PR #51 and #52 both change props, heading, approval queue, and content order | A and C | Approval lifecycle: #52. Optimization status/settings: #51 | Resolve manually: retain #52 lifecycle alerts/queue, then add #51 optimization fields without creating a second queue. |
| `api-server/test.mjs` | none | test registration | #50, #51, and #52 also register tests | B | Each feature PR | Combine test entries once after feature merges; UI PR must not touch it. |
| `stock-analyzer/e2e/phase12-trade-automation.spec.ts` | none | none | #51 and #52 both change the same scenario file | A | #51/#52 | Consolidate fixtures and assertions after service contract resolution. |
| `stock-analyzer/e2e/app-navigation.spec.ts` | new UI-only navigation contract | none | none | E | UI navigation | Run independently on the existing Phase 11 test route. |

Common changed files among feature PRs:

- #50 and #52: `api-server/test.mjs`, `stock-analyzer/src/pages/ai-chart.tsx`
- #51 and #52: 8 files, including trade repository/service/types, test registry, approval queue, auto-trading page, and Phase 12 test/page
- #52 and #58: `api-server/src/routes/index.ts`, `api-server/test.mjs`, `stock-analyzer/src/App.tsx`
- UI branch changes in this step overlap with none of #50, #51, #52, or #58

## PR #58 public UI contract

The UI branch must import this contract after PR #58 is merged. It must not recreate these types or functions.

| Contract item | PR #58 implementation | UI consumption position | Integration caution |
| --- | --- | --- | --- |
| Search component | `UnifiedAssetSearch` in `stock-analyzer/src/components/unified-asset-search.tsx` | Home search entry, assets page, optional desktop header | Pass filters and `onSelect`; do not copy debounce, IME, request cancellation, ranking, recent, or watchlist logic. |
| Search page | default `UnifiedAssetSearchPage` | `/stocks` and `/search` owned by #58 | UI navigation points to `/stocks`; UI branch does not add routes. |
| Endpoint | `GET /api/search/suggest` | Called only by PR #58 client helper | Do not call provider APIs directly from UI. |
| Query parameters | `q`, `asset=all|stock|coin`, `market=KR|US|spot|futures`, `limit` capped at 50 | Search component props | Empty query is not sent; server rejects empty query. |
| Result type | `UnifiedAssetSuggestion` | Selection callback and display | Reuse type. Do not define another asset-search result type. |
| Response type | `UnifiedAssetSuggestResponse` | Loading/result/status rendering inside #58 component | Reuse `stale`, `partial`, `providers`, and `hiddenMatches`. |
| Asset ID | `id` | recent selection identity | Do not derive identity from symbol alone. |
| Asset kind | `assetType: stock|coin` | detail route decision | Keep stock and coin handling distinct. |
| Market | `KR|US|spot|futures` | grouping, filter, and detail route | Spot and futures with the same base symbol remain separate. |
| Exchange | `exchange` | result metadata | Display only; do not use as a replacement for `productCode`. |
| Product code | `productCode` | futures detail and identity | Preserve separators and original code. |
| Instrument kind | `instrumentType: stock|spot|futures` | display and accessibility label | Do not infer futures from `USDT` text in the UI. |
| Selection callback | `onSelect(item: UnifiedAssetSuggestion)` | Navigation owner | UI may call the helper below, not rebuild route rules. |
| Detail route helper | `unifiedAssetDetailPath(item, backPath)` | search page selection | Stocks: `/stock/:ticker?back=...`; coins: `/stock-info?asset=coin&coinMarket=...&symbol=...`. |
| Loading | internal `loading` state | #58 component | UI shell must not overlay a second spinner. |
| Empty result | `results.length === 0` plus `hiddenMatches` | #58 component | Preserve other-market guidance. |
| Partial provider failure | `partial === true` | #58 component | Show last-good-index warning; do not convert to empty state. |
| Stale index | `stale === true`, `dataAsOf` | #58 component | Keep basis time visible. |
| Full failure | helper throws from non-2xx; API may return `SEARCH_INDEX_UNAVAILABLE` | #58 component | Preserve error and retry UI. |
| Retry | component calls the same search helper again | #58 component | UI shell must not bypass rate limiting or call refresh-admin API. |

## Active user route inventory before PR #58 integration

| Route | Page/handler | Entry | Reachable | Mobile | Desktop | Responsibility | Current issue |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/`, `/home` | `HomePage` | Home menu | yes | yes | yes | UI | No route issue. |
| `/stocks` | `StocksPage` | Home search button; assets menu | yes | yes | yes | Existing UI; future page ownership #58 | Contains a separate search implementation that will be replaced by #58. |
| `/search` | `SearchPage` | assets menu | yes | yes | yes | Existing ranking page; future route ownership #58 | Currently combines rankings and a second stock-name/code filter. After #58 it becomes unified search and rankings move. |
| `/stock/:ticker` | `DetailPage` | stock lists/search selection | yes | yes | yes | Existing detail | Stock selection path is active. |
| `/stock-info` | `StockInfoAccess` | coin lists and crypto redirects | yes | yes | yes | Existing detail/permission gate | Assets group owns active highlighting after this UI change. |
| `/market-rankings` | not present on UI baseline | PR #58 search page link after integration | no before #58 | no | no | #58 | Must not be added by UI branch. |
| `/market-browser` | not present on UI baseline | future assets submenu after integration | no before #58 | no | no | #58 | Must not be added by UI branch. |
| `/scanner` | `ScannerAccess` -> `TechnicalWorkspacePage` | technical menu | yes with capability | yes | yes | scanner/PR #52 | Leave workspace implementation to #52. |
| `/ai-chart` | `AiChartAccess` | technical menu; scanner selection | yes with capability | yes | yes | PR #50 plus #52 insertion | Direct same-file integration required later. |
| `/auto-trading` | `ScannerAccess` -> `TechnicalWorkspacePage` | technical menu | yes with current gate | yes | yes | #51/#52 | Current router uses scanner access; #52 adds inner capability handling. Do not change in UI PR. |
| `/themes` | `ThemesPage` | assets submenu | yes | yes | yes | Existing UI | Moved from top-level to assets submenu, not removed. |
| `/watchlist`, `/alerts` | dedicated pages | assets submenu | yes | yes | yes | Existing UI | Moved from top-level to assets submenu, not removed. |
| `/market-overview`, `/learn`, `/ai-chat`, `/portfolio` | existing pages/gates | information submenu | yes | yes | yes | Existing UI | Actual repository functions differ from proposed news/disclosure/schedule grouping; preserve active screens. |
| `/more`, `/settings`, `/account`, `/login` | settings/account pages | settings menu | yes | yes | yes | Existing UI | Aliases remain active. |
| `/__phase11-*`, `/__phase12-*` | test-only routes | Playwright only | gated by build flags | yes | yes | owning feature PR | Never expose in user menu. |

## Search UI inventory

Confirmed asset-search surfaces on the UI baseline:

1. Home search entry button -> `/stocks`
2. `StocksPage` input using the existing `api.searchRows` plus local coin filtering
3. `SearchPage` input filtering market-ranking rows

These are two search inputs plus one entry button. They serve overlapping purposes. This UI change only consolidates the entry location; it does not modify either search implementation. PR #58 is responsible for replacing them with the unified component and preserving rankings/browser routes.

## UI navigation result

Top-level navigation is now:

1. 홈
2. 종목
3. 기술
4. 정보
5. 설정

No active feature was deleted. Themes, watchlist, alerts, scanner, AI chart, approval-order screen, market overview, learning, AI information, and portfolio remain reachable through grouped menus. Top-level controls and menu rows have a minimum 44px target. Asset menus support Arrow Up/Down, Home, End, Escape, outside click, active state, and focus restoration.

## Verification boundaries

Can be verified on the UI branch without PR #58:

- five-section metadata
- active-route matching
- desktop/mobile bottom-navigation layout
- 44px target size
- keyboard menu navigation
- current `/stocks` search entry
- no horizontal overflow
- existing route gates remain authoritative

Can only be verified after PR #58 integration:

- real `UnifiedAssetSearch` rendering from the UI branch
- actual `/api/search/suggest` response in the integrated tree
- selection of KR, US, spot, and futures results from the integrated navigation
- `/market-rankings` and `/market-browser` user navigation
- stale/partial/full-error states in the integrated shell

Mocked in this UI branch:

- unrelated API traffic on the Phase 11 navigation test route

Not mocked or duplicated:

- unified search result types
- unified search API
- provider synchronization
- ranking and alias logic
- detail-route helper

## Deferred integration procedure

After production deployment and post-deployment health verification are complete:

1. Confirm the latest `main` SHA.
2. Update PR #58 with latest `main` only under a separately approved workflow.
3. Resolve PR #58 conflicts while preserving its search routes and public contract.
4. Run complete PR #58 CI.
5. Merge PR #58 only after separate user approval.
6. Update the UI branch from the new `main` only after separate approval.
7. Keep the PR #58 search route block in `App.tsx` unchanged.
8. Change the `market-rankings` menu metadata from `/search` to `/market-rankings` and add `/market-browser` as a separate assets submenu item.
9. Integrate PR #50 and #52 in `ai-chart.tsx`, and PR #51 and #52 in `auto-trading.tsx`, with manual same-file conflict resolution.
10. Run frontend typecheck/build, navigation contract, search-entry tests, search-selection tests, full desktop/mobile Playwright, console/page error checks, and unexpected HTTP checks.
11. Perform feature-specific staging only after approval.
12. Do not perform production deployment without a separate explicit approval.
