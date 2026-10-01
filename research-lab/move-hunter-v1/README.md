# Move Hunter V1 — canonical adapter + Runner overlay

This is an isolated research-only lane for the user's four markets:
- KR_STOCK
- US_STOCK
- CRYPTO_SPOT
- CRYPTO_FUTURES

## No duplicate research engine

Move Hunter reuses the merged canonical owners already present on main:
- `market-prediction-lab/src/historical-market-replay-v1.js` (#475)
- `market-prediction-lab/src/historical-discovery-settlement-v1.js` (#479)
- `research-production/src/research-dataset-snapshot-store.mjs` (#1153)
- existing 4-market tournament/data readiness owners remain authoritative.

This lane does not replace or edit them.

## New ownership in this lane only

The additive Runner overlay evaluates already-discovered candidates with:
- next-bar entry
- LONG and CRYPTO_FUTURES SHORT
- ATR + recent structure initial stop
- configurable minimum/maximum stop distance
- breakeven protection after R progress
- ATR trailing after further R progress
- no fixed take-profit ceiling
- +3% / +5% / +10% remain measurement checkpoints only; they are never take-profit caps
- higher milestones (+20% / +30% / +50% / +100% by default) and unlimited peak MFE tracking
- MFE / MAE / max-R
- gross/net capture ratio: realized return divided by the best favorable excursion
- giveback from peak: how much open profit the trailing exit surrendered before exit
- STOP_FIRST conservative same-bar handling
- fees + slippage + spread
- immutable Dataset Snapshot identity binding

## Hard isolation

No changes to Research Center, Auto/Paper Trading, Forward, Backtester, Member/Auth, Telegram, stock-analyzer UI, api-server, DB, Secret, Env, schedules, deployment workflows, private APIs, or real orders.

Replit / Replit Agent: forbidden and unused.

## Truth boundary

Historical Replay is not Genuine Forward. Search quality is not profitability proof. A real 2023-09-27 through 2026-09-27 four-market run is permitted only when the existing canonical Dataset Snapshot and point-in-time evidence gates are READY for the exact market/profile. Missing evidence fails closed.

Local isolated tests:
```bash
node --test research-lab/move-hunter-v1/test/engine.test.mjs
```


## Current strict 3-year readiness audit — 2026-09-27

Exact requested audit window: 2023-09-27T00:00:00Z through 2026-09-27T00:00:00Z.

No market is claimed READY from the GitHub evidence inspected. The gate therefore remains fail-closed:

- KR_STOCK: exact 3-year official corporate-action + exchange-session evidence is not proven as an owner artifact for the requested range; latest selective-research stock data is bounded/static rather than a full point-in-time market universe.
- US_STOCK: same exact-range corporate-action/session/universe proof gap; latest bounded research explicitly says corporate-action correctness remains unverified.
- CRYPTO_SPOT: listing + delisting history remains unproven by the current canonical owner chain; latest-list data cannot substitute for historical membership.
- CRYPTO_FUTURES: continuous historical OPEN_INTEREST readiness is not proven and exhaustive LIQUIDATION_RISK / position-tier history remains unavailable in the canonical evidence chain.
- All markets: exact profile-scoped COST_POLICY_IDENTITY and exact 3-year Dataset Snapshot coverage must be present for the precise profile before the audit can run.

Code contracts being merged does not count as source evidence. Missing evidence is never replaced with zero/current values/synthetic backfill.

The current expected strict result is therefore:
- readyMarketCount: 0 (not yet proven READY)
- blockedMarketCount: 4
- fourMarketReady: false

This is an evidence-readiness result, not a statement that the strategy is unprofitable.


## Indicator-Adaptive Runner

Move Hunter now reuses the merged canonical `adaptive-multi-evidence-market-features-v2` output instead of creating a second indicator engine.

Canonical evidence used:
- EMA direction/slope
- ADX / +DI / -DI
- Donchian / price structure
- ROC / RSI / MACD histogram / momentum acceleration
- benchmark-relative strength
- relative volume / signed volume / price-volume disagreement
- realized volatility / range expansion-compression

Runner states:
- ACCELERATION -> 4 ATR trail
- NORMAL -> 3 ATR trail
- WARNING -> 2 ATR trail
- INVALID -> next-bar-open exit

Closed-bar state never causes same-close exit. It only changes the next bar's protection or schedules a next-open invalidation exit.

This module has no automatic entry authority, no strategy promotion authority and no execution authority. The fixed archived Runner policies remain the only policies with observed-history comparison evidence; Indicator-Adaptive Runner still requires frozen replay + unused OOS/Forward validation.


## Scanner Quality Bridge

Move Hunter now contains a research-only fail-closed bridge that can produce a Scanner-compatible `backtestQuality.status=verified` packet only when exact evidence is supplied for the same strategy/symbol/dataset identity.

Required:
- exact Scanner strategyProfileId / strategyVersion
- parameterHash / researchCodeSha / datasetSnapshotHash
- exact market / symbol / timeframe / direction
- execution-aware canonical OOS backtest results
- exact leak-free purged walk-forward fold results
- complete full-cost evidence, including measured/documented slippage
- lookahead-protected historical dataset audit
- survivorship protection
- KR/US additionally require the point-in-time removed-name stock-universe audit
- minimum Walk-forward trade count

Metrics are recomputed from canonical trade rows rather than trusting caller-supplied summary numbers.

The bridge is not connected to active Scanner ranking in this PR:
- activeLaneMutation=false
- automaticPromotionAuthority=false
- profitabilityClaimAllowed=false
- executionAuthority=NONE

## Spot Forward identity plan

Current Spot SWING canonical timeframe remains 4H while Forward Spot is hardcoded to 60m.

The repo already supports:
- Swing at 4H
- Upbit 4H public candles through `minutes/240`

Therefore the lower-semantic-change future repair is to keep the canonical Spot SWING 4H definition and make Forward lane timeframes market-specific:
- KR 60m
- US 60m
- Spot 4H
- Futures 60m

No active Forward/Scanner file is changed by #1407.
See:
`docs/spot-forward-4h-alignment-plan-20260927.md`
