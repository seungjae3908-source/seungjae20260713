# Futures Analysis Phase 1 Inspection

## Scope

This phase inspects the existing GitHub repository and adds repository-level CI only. It does not enable deployment, real orders, automatic trading, database migrations, or exchange credential changes.

## Repository identity

- Requested candidate: `seungjae3908-source/stock-ai-app` — not accessible through the installed GitHub connection.
- Matching accessible repository: `seungjae3908-source/seungjae20260713`.
- Default branch: `main`.
- Inspection base commit: `4330d4f6fdbe99192f84285ab7e1e7f202d4fc34`.
- Workspace manager: pnpm, lockfile format 9.0.
- Runtime requirement: Node 20 or newer and pnpm 9 or newer.

## Confirmed project structure

- Frontend: `stock-analyzer/`
- Backend: `api-server/`
- Shared packages: `packages/*`
- Workspace definition: `pnpm-workspace.yaml`
- Frontend router: `stock-analyzer/src/App.tsx`
- Bottom navigation: `stock-analyzer/src/components/bottom-nav.tsx`
- Frontend authentication: `stock-analyzer/src/lib/auth.tsx`
- Backend authorization middleware: `api-server/src/middleware/auth.ts`
- Backend route registry: `api-server/src/routes/index.ts`
- API client: `stock-analyzer/src/lib/api.ts`
- Authenticated fetch helper: `stock-analyzer/src/lib/auth-fetch.ts`
- Coin spot and futures routes: `api-server/src/routes/crypto.ts`
- Crypto futures order routes: `api-server/src/routes/crypto-auto.ts`
- Stock order helper and risk preview: `stock-analyzer/src/lib/auto-trading.ts`
- Stock and coin scanner page: `stock-analyzer/src/pages/scanner.tsx`
- Futures chart/workspace: `stock-analyzer/src/components/crypto-trading-workspace.tsx`
- Stock chart analysis component: `stock-analyzer/src/components/chart-broadcast.tsx`
- Database schema: `api-server/supabase/schema.sql`

### Requested paths checked

- `stock-analyzer/src/components/crypto-trading-workspace.tsx`: present
- `stock-analyzer/src/components/chart-broadcast.tsx`: present
- `stock-analyzer/src/pages/scanner.tsx`: present
- `api-server/src/routes/crypto.ts`: present
- `api-server/src/routes/crypto-auto.ts`: present
- `stock-analyzer/src/pages/trading-workspace.tsx`: not present
- `stock-analyzer/src/components/trading/`: no confirmed implementation found during this inspection

## Existing CI state

Specialized GitHub Actions workflows exist for prediction-lab and deployment-related tasks, but no general `.github/workflows/ci.yml` was present on `main`. The application package files expose these validation scripts:

- Frontend typecheck: `pnpm --dir stock-analyzer run typecheck`
- Backend typecheck: `pnpm --dir api-server run typecheck`
- Frontend build: `pnpm --dir stock-analyzer run build`
- Backend build: `pnpm --dir api-server run build:server`
- Lint: no script defined
- Tests: no script defined

The new workflow intentionally uses only scripts confirmed in the repository. It does not deploy and does not read or print secrets.

## Current implementation assessment

### Implemented

- Upbit public spot markets, tickers, orderbook, and candles.
- Bitget public futures tickers and candles.
- Futures ticker response includes last price, mark price, index price, 24-hour change, volume, quote volume, funding rate, open interest, bid, ask, and timestamp.
- Futures candle endpoint supports 1m, 3m, 5m, 15m, 30m, 1H, 4H, 6H, 12H, 1D, and 1W values accepted by the current route.
- Frontend futures workspace contains chart rendering, timeframe selection, SMA, RSI, MACD, ATR, VWAP, volume ratio, support/resistance, pattern scoring, and long/short/wait scoring.
- Basic stock position-size preview and daily safety limits exist in `stock-analyzer/src/lib/auto-trading.ts`.
- Supabase authentication and backend member/admin middleware exist.

### Partially implemented

- Futures data is connected, but there is no shared normalized `NormalizedCandle` model across backend and frontend.
- Futures data status is represented mainly by request success/failure; no shared `live/delayed/cached/disconnected/error/insufficient` model exists.
- Ticker data exposes a current open-interest value and funding rate, but not dedicated open-interest history, change percentage, next funding time, basis, long/short ratio, or liquidation feeds.
- Multiple timeframes are selectable, but no confirmed shared server-side aggregation module was found.
- Technical indicators are implemented inside large UI components, creating duplication and making unit testing difficult.
- Risk logic covers basic risk budget, stop percentage, open-position count, daily orders, consecutive losses, and daily loss. It does not yet cover fee/slippage/funding-inclusive position sizing, liquidation-distance checks, weekly loss, portfolio exposure, or correlation limits.
- Journals exist for real-order flows, but no confirmed paper-trading journal with realistic fill simulation was found.

### Not implemented or not confirmed

- Dedicated futures status endpoint and symbol metadata endpoint.
- Futures orderbook and public trades endpoints.
- Open-interest history and change-rate endpoint.
- Funding history and next-funding endpoint.
- Basis endpoint.
- Long/short ratio endpoint.
- Liquidation data endpoint.
- WebSocket connection/reconnection layer for futures market data.
- Shared stale-data detection and cache policy for futures snapshots.
- Shared market-state classifier.
- Independent backtest engine and walk-forward validation.
- Paper-order engine with spread, slippage, partial fill, delay, expiry, and funding cost.
- Paper-trade database tables and safe migration.
- AI trade review based only on stored paper-trade records.
- General application unit/integration test suite.
- Root or backend environment-variable example file was not found at the checked conventional paths.

## Security and operational risks

### Real-order code exists

The current repository contains real stock and Bitget futures order execution paths. They are guarded by execution keys and environment flags, but they remain reachable from application code when those controls are enabled. This phase does not modify, call, or enable those paths.

### Authorization gap

The inspected authentication model currently exposes only `user` and `admin` roles. The requested `pending/associate/regular/admin` feature matrix is not implemented in this GitHub branch. In addition, the route registry mounts public crypto routes before the global member middleware, while account endpoints apply `requireMember` internally. The futures auto-trade router applies `requireMember`, but no confirmed admin-only gate is applied at the route registry on the inspected `main` commit.

### Test gap

No application `test` or `lint` script is defined in the inspected package files. The CI workflow therefore reports those checks as unavailable instead of pretending they ran.

### Data-quality gap

The current futures responses do not consistently expose source status, stale age, candle completion, normalized timestamps, or a unified insufficient-data state. Technical indicators are calculated in UI code, so NaN handling and look-ahead behavior are not covered by dedicated automated tests.

## Recommended futures phase 2 structure

Extend existing modules instead of creating duplicate pages or APIs:

- Add shared market types under an existing shared package after confirming the preferred package boundary.
- Extend `api-server/src/routes/crypto.ts` or extract a futures market service used by that route.
- Reuse `stock-analyzer/src/components/crypto-trading-workspace.tsx` as the existing futures UI entry point.
- Extract indicator and timeframe aggregation logic from UI components into testable modules.
- Keep all phase-2 market endpoints public-data-only.
- Do not import or call `crypto-auto.ts` from the public analysis path.

Minimum shared statuses:

```ts
type DataStatus =
  | 'live'
  | 'delayed'
  | 'cached'
  | 'disconnected'
  | 'error'
  | 'insufficient';
```

Minimum normalized candle shape:

```ts
type NormalizedCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timeframe: string;
  symbol: string;
  source: string;
  isClosed: boolean;
  isDelayed: boolean;
  updatedAt: string;
};
```

## Phase 1 changes

- Added `.github/workflows/ci.yml`.
- Added this inspection report.
- No production deployment workflow was changed.
- No database file was changed.
- No order route was changed.
- No secret or environment-variable value was added.
