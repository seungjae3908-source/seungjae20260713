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
