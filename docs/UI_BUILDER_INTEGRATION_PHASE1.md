# Visual UI Builder Integration — Phase 1

## Immutable contracts

- Stock App base: `da129e98a04beaafcbd08f3604c3e0e7cfac22ff`
- Builder stable commit: `c98915da80c57a02c7e037522f6ae7dabd07664d`
- Builder stable tree: `43cd3798164f709786281b7f85acd68b0c9d9095`
- Builder schema: v1
- Integration target: `SIGNAL_SCANNER` only

The Builder repository is read-only. The Stock App integration mirrors the frozen Layout JSON contract and validates it again at runtime.

## Registry inventory

The machine-readable inventory is `stock-analyzer/src/lib/ui-builder-layout.ts`.

- `REGISTRY_BLOCKS_TOTAL=46`
- `EXISTING_EXACT=3`
- `EXISTING_ADAPTER_REQUIRED=9`
- `EXISTING_COMPOSITE_REQUIRED=34`
- `MOCK_ONLY=0`
- `MISSING=0`
- `FORBIDDEN_RUNTIME_BINDING=0`

`FORBIDDEN_RUNTIME_BINDING=0` means no Builder block is allowed to bind directly to runtime execution. Forbidden props such as URL, API path, HTTP method, broker, token, secret, callback, permission override, risk override, or arbitrary action are rejected by the Stock App validator.

## Phase 1 runtime surfaces

The layout renderer groups Builder blocks into existing Stock App surfaces rather than duplicating domain UI:

- `scanner` → existing `SignalScannerPage` and its existing `fetchSignalScanner` business logic.
- `chart` → existing `AiChartPage` / `UnifiedAnalysisChart`.
- `position` → read-only adapter over existing `getPortfolioChartOverlay` cache. It does not query account/broker/private APIs and does not calculate Risk Engine policy.
- `trade-review` → existing `ScannerApprovalComposer`, which owns the fixed approval-mode Paper plan path.

The frozen Builder template includes more granular blocks than the current Stock App components expose. Phase 1 therefore uses composite adapters for internal selector/list/chart regions. It does not create a second scanner engine.

## Published layout source and fallback

Phase 1 reads only device-specific published JSON stored under:

- `stock-ui-builder:published-layout:SIGNAL_SCANNER:mobile`
- `stock-ui-builder:published-layout:SIGNAL_SCANNER:desktop`

This is a non-server integration proof. If the key is absent, JSON is invalid, schema/device/page validation fails, a block is unknown, a required block is missing, a safe action is mutated, or a runtime surface is unsupported, the app keeps the current Stock App default workspace.

Mobile and Desktop keys are separate.

## Safety

Builder JSON cannot configure:

- broker/private API endpoints
- HTTP methods
- secrets/tokens
- order quantity logic
- position sizing
- Risk Engine limits
- approval bypass
- execution mode
- Kill Switch behavior
- permissions

`TradeReviewButton` maps only to the existing approval composer. No order endpoint is accepted from Layout JSON.

No Production, Staging, server, PM2, Caddy, DB schema/RLS, Secret, real account, actual order, cancel, transfer, or withdrawal change is part of this phase.
