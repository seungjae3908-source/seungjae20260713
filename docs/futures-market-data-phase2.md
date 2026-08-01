# Futures Market Data Phase 2

## Scope

This phase adds normalized Bitget public futures market data, validation, stale-state classification, safe in-memory caching, unit tests, dedicated public status APIs, and a minimal status panel in the existing futures workspace.

It does not add or change real orders, automatic trading, backtesting, paper trading, trade journals, database migrations, credentials, production deployment, navigation, or broad UI structure.

## Base

- Repository: `seungjae3908-source/seungjae20260713`
- Base branch: `main`
- Base commit: `23bf92d3f7aec0637a9fa1fb2cb38b47fae3dcbb`
- Work branch: `feature/futures-market-data-phase2`

## Existing implementation reused

- Existing public crypto routes: `api-server/src/routes/crypto.ts`
- Existing route registry: `api-server/src/routes/index.ts`
- Existing Bitget product type: `USDT-FUTURES`
- Existing frontend API client: `stock-analyzer/src/lib/api.ts`
- Existing authenticated fetch layer: `stock-analyzer/src/lib/auth-fetch.ts`
- Existing futures workspace: `stock-analyzer/src/components/crypto-trading-workspace.tsx`
- Existing React Query setup and UI components
- Existing `esbuild` dependency for a Node built-in test runner

The public phase-2 routes are implemented in a separate router and service. They do not import `api-server/src/routes/crypto-auto.ts` and do not read order keys, account balances, positions, execution keys, or automatic-trading flags.

## Public data source

Provider: Bitget public Mix Market API.

Used public contracts:

- Contracts/supported symbols
- Single-symbol ticker
- Mark and index prices
- Current open interest
- Current funding rate
- Next funding time
- Candles

The APIs require no private Bitget API key or secret.

## Types

Backend source of truth:

`api-server/src/services/futures-market-data.service.ts`

Frontend contract mirror:

`stock-analyzer/src/lib/futures-market-data.ts`

A shared workspace package was considered. The backend `tsconfig` currently limits `rootDir` to `api-server/src`, while existing shared packages expose runtime JavaScript rather than a shared TypeScript contract build. To avoid changing package boundaries in this limited phase, the frontend mirrors the server contract exactly and this document records that contract.

### DataStatus

```ts
export type DataStatus =
  | 'live'
  | 'delayed'
  | 'cached'
  | 'disconnected'
  | 'error'
  | 'insufficient';
```

### NormalizedCandle

```ts
export type NormalizedCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number | null;
  timeframe: string;
  symbol: string;
  market: 'crypto-futures';
  source: string;
  isClosed: boolean;
  isDelayed: boolean;
  updatedAt: string;
};
```

### FuturesMarketSnapshot

The snapshot contains nullable price, mark price, index price, 24-hour change and volume, bid/ask and spread, current/previous OI and change rate, funding rate and next funding time, basis, provider, status, delay flag, update time, and warnings.

## Number normalization

All external numeric fields use `toFiniteNumber(value)`.

- Empty string, whitespace, `undefined`, `null`, `NaN`, `Infinity`, and `-Infinity` become `null`.
- Valid numeric strings become numbers.
- Zero remains a valid number.
- No missing value is replaced with a fabricated market value.

## Symbol normalization

The following forms normalize to `BTCUSDT`:

- `BTC`
- `BTCUSDT`
- `BTC-USDT`
- `BTC/USDT`
- `btcusdt`

After format normalization, the symbol must exist in the Bitget public contracts list. Unsupported symbols return HTTP 400 with `INVALID_FUTURES_SYMBOL`.

## Candle validation

The normalizer:

- Converts timestamps to milliseconds.
- Validates finite OHLC and volume values.
- Rejects non-positive OHLC values.
- Rejects `high < low`.
- Rejects open or close outside the high-low range.
- Keeps missing quote volume as `null`.
- Deduplicates by timestamp.
- Sorts ascending by timestamp.
- Calculates `isClosed` from the requested timeframe duration.
- Calculates `isDelayed` from timeframe-aware tolerance.
- Reports removal counts in warnings.
- Returns an empty array for empty or invalid data; it never fills gaps with fake candles.

Fewer than 25 valid candles are classified as `insufficient` for analysis.

## Stale-state rules

Each supported timeframe has a duration in milliseconds. The allowed delay is:

```text
max(30 seconds, timeframe duration × 0.5)
```

For candles, the newest candle is considered current while:

```text
now <= candle open time + timeframe duration + allowed delay
```

Status order:

1. `cached` when an external request fails and a previous successful cache is returned.
2. `error` for parsing or internal normalization errors.
3. `disconnected` when the provider fails and no cache exists.
4. `insufficient` when required values or the minimum candle count are missing.
5. `live` inside the timeframe-aware delay window.
6. `delayed` outside that window.

## Open-interest change

The current OI comes from the Bitget public current open-interest endpoint. No classic public OI-history contract was found in the existing project, so this phase does not invent history.

The server keeps successful OI samples in process memory only:

- Minimum comparison interval: 60 seconds
- Maximum retained comparison age: 30 minutes
- Maximum retained samples per symbol: 60
- Server restart clears history
- No previous sample or previous OI of zero produces `null`

Formula:

```text
(current OI - previous OI) / previous OI × 100
```

Insufficient history is reported in `warnings`.

## Funding time

`nextFundingAt` is read from the public current-funding response `nextUpdate` or the public funding-time response `nextFundingTime`.

If neither response provides a valid time, the service returns `null` and a warning. It does not assume a fixed funding schedule.

## Basis

Calculated only when mark price and index price are finite and index price is greater than zero.

```text
basis = markPrice - indexPrice
basisPercent = basis / indexPrice × 100
```

Otherwise both values remain `null`.

## Spread

Calculated only when bid and ask are finite, bid is positive, and ask is greater than or equal to bid.

```text
midPrice = (bidPrice + askPrice) / 2
spreadPercent = (askPrice - bidPrice) / midPrice × 100
```

Invalid order-book relationships return `null` and a warning.

## Cache and provider protection

- External timeout: 8 seconds
- Supported-symbol cache TTL: 10 minutes
- Status cache behavior: supported-symbol cache with short status refresh
- Snapshot TTL: 5 seconds
- Candle TTL: one quarter of timeframe duration, clamped between 5 and 60 seconds
- Concurrent identical requests are merged in memory
- No unbounded retry loop
- Provider failure returns the last successful cache when available
- Cached snapshot and candle responses preserve their original `updatedAt`
- Cache fallback is explicitly labeled `cached` and delayed

The cache is process memory only. It does not create or migrate database tables.

## Public API

### `GET /api/crypto/futures/status`

Returns provider connection state, public-data-only status, symbol count, update time, warnings, and `orderCapability: false`.

### `GET /api/crypto/futures/:symbol/snapshot`

Returns:

```json
{
  "ok": true,
  "data": {
    "symbol": "BTCUSDT",
    "status": "live",
    "source": "bitget",
    "warnings": []
  }
}
```

The full `data` value follows `FuturesMarketSnapshot`.

### `GET /api/crypto/futures/:symbol/candles`

Query parameters:

- `timeframe` or compatibility alias `granularity`
- `limit`, clamped from 1 to 1000

Returns normalized candle data, status, warnings, and update time.

Existing query-based `/api/crypto/futures/candles` and ticker routes remain unchanged for compatibility.

## Frontend integration

The existing `crypto-trading-workspace.tsx` was not rewritten. A single `FuturesMarketStatusPanel` was inserted at the top of the existing content area.

It displays:

- Provider
- Live/delayed/cached/error/insufficient badge
- Last update time
- Mark price
- Index price
- OI
- OI change percentage
- Funding rate
- Next funding time
- Basis percentage
- Spread percentage
- Warnings

Null values display `데이터 없음` or `확인 불가`, never zero.

## Tests

Runner: Node built-in `node:test`, with the existing `esbuild` dependency compiling the TypeScript test entry to a temporary bundle.

Covered rules:

- Finite-number normalization and zero preservation
- Empty/NaN/infinite rejection
- Symbol normalization
- Basis formula and zero-division prevention
- Spread formula and inverted-book rejection
- OI change and invalid previous OI
- Timestamp deduplication
- Ascending candle sorting
- Invalid OHLC removal
- Timeframe-aware stale status
- Empty-data handling without fake candles

CI runs the tests without calling the external Bitget API.

## Not implemented in phase 2

- Persistent OI history
- Long/short account ratio
- Liquidation feed
- Public trades and order-book history
- WebSocket streaming/reconnection
- Backtesting
- Paper trading
- Trade journal
- AI trade review
- Database migration
- Role model redesign
- Real-order changes
- Production deployment
