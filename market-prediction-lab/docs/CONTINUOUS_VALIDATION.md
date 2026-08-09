# Continuous validation policy

## Current active comparison

- 15m: `tiny-softmax-crypto-futures-15m-v1-calibrated` vs `tiny-linear-baseline-v0`
- 1h: `tiny-softmax-crypto-futures-1h-v1-calibrated` vs `tiny-linear-baseline-v0`
- v2 funding-only, v3 market-structure and v4 probability-ensemble experiments remain `research_hold`.
- A held model is never selected by the shadow cycle.

## Temporal safety

- Historical funding uses only the latest published value at or before each anchor.
- Mark and index candles require an exact timestamp match with the market candle.
- Current open interest is accumulated from the first live shadow cycle onward.
- Historical open interest is never invented or backfilled from a current value.
- Missing temporal data stays unavailable; it is not carried forward indefinitely or synthetically interpolated.

## Promotion gates

The current model pair remains in `shadow_continue` until all gates pass:

- at least 300 settled predictions,
- at least 100 settled predictions per symbol,
- at least 28 elapsed days,
- at least two sufficiently sampled market regimes,
- positive held-out log-loss improvement,
- no material overall, symbol-level or regime-level regression,
- no model-pair mixing in reported metrics.

Passing these gates means only `integration_review_ready`. It does not merge, deploy or connect the model to the existing API.

## Isolation

The shadow cycle:

- uses only public market-data GET endpoints,
- has no API key, signature, account, position or order permission,
- does not import or modify `api-server` or `stock-analyzer`,
- does not access Supabase, the production database, PM2 or Caddy,
- does not merge the draft pull request,
- does not deploy to the production server.
