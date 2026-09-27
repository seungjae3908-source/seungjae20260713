# Move Hunter V1

Isolated research-only lane for four markets:

- KR_STOCK
- US_STOCK
- CRYPTO_SPOT
- CRYPTO_FUTURES

## Guarantees in V1

- point-in-time candidate discovery: only candles at or before `asOf`
- next-bar entry; no same-close fantasy fills
- MFE / MAE / R-multiple tracking
- +3% / +5% / +10% first-hit timestamps
- short initial risk using ATR + recent structure
- long-runner behavior with breakeven + ATR trailing; no fixed profit ceiling
- conservative active-stop-first intrabar handling
- fees + slippage + spread deduction
- rolling Train / Validation / Test windows with purge gaps
- Recall@K for realized movers
- market-agnostic historical replay

## Hard isolation

This directory does not wire into Research Center, Backtester, Forward, Auto/Paper Trading, Member/Auth, Telegram, DB, secrets, schedules, or deployment workflows. No Replit/Replit Agent.

Historical replay is not genuine Forward evidence and cannot prove profitability.

## Real 3-year audit contract

A real 2023-09-27 through 2026-09-27 four-market audit additionally requires immutable point-in-time datasets with:
1. historical universe membership including delisted symbols;
2. sorted OHLCV;
3. corporate-action normalization for equities;
4. listing/delisting/halt truth;
5. exchange/session metadata;
6. provider lineage + immutable dataset identity.

Run tests:

```bash
node --test research-lab/move-hunter-v1/test/engine.test.mjs
```
