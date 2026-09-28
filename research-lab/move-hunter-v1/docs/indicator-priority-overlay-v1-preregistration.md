# Indicator Priority Overlay V1 — preregistration

Registered before inspecting Indicator-Priority portfolio outcomes.

## Scope

Observed archived FIRST_RETEST candidates only. This is exploratory historical research, not OOS/Forward.

Exit policy is frozen and unchanged:
- LONG_RUNNER_3ATR
- same initial stop / risk / costs / max hold
- no indicator-based forced exit
- no adaptive trailing in this comparison

The indicator overlay has NO entry rejection authority. Every canonical FIRST_RETEST candidate remains eligible. Indicators are used only when multiple candidates compete for limited account capacity.

## Point-in-time inputs

Computed only from closed bars available at the candidate signal timestamp, with BTC on the same 4h timestamps as the crypto benchmark.

Reuse the canonical Market Features V2 definitions:
- EMA20 / EMA50 direction and slopes
- ADX / directional DI
- ROC12
- RSI14
- MACD 12/26/9 histogram
- benchmark relative-strength ROC20
- relative volume20
- signed volume balance
- price-volume disagreement

## Frozen four-component priority

One point each:

1. TREND
   - EMA20 > EMA50
   - EMA20 slope > 0
   - ADX direction = UP
   - no ADX numeric threshold is required

2. MOMENTUM
   - ROC12 > 0
   - MACD histogram > 0
   - RSI14 >= 50 and < 82

3. RELATIVE_STRENGTH
   - asset ROC20 - BTC ROC20 > 0

4. PARTICIPATION
   - relativeVolume20 >= 1.0
   - signedVolumeBalance > 0
   - priceVolumeDisagreement != true

IndicatorPriority = integer 0..4.

No parameter grid, no weights, no threshold search.

## Portfolio tie-break order

At the same entry timestamp:
1. IndicatorPriority descending
2. existing candidate momentum score descending
3. existing RVOL descending
4. symbol ascending

No candidate may receive more risk because of a higher indicator score.

## Account constraints unchanged

- initial capital KRW10m
- risk/trade 0.5%
- aggregate initial risk 2%
- max positions 5
- symbol gross cap 20%
- theme gross cap 40%
- total gross exposure 100%
- cost 0.15% per side
- no leverage
- fractional crypto units
- same-bar exit cash cannot fund same-open entries

## Evaluation

Compare frozen existing-priority LONG_RUNNER_3ATR versus Indicator-Priority LONG_RUNNER_3ATR across:
- PRIOR_H1
- PRIOR_H2
- RECENT_6M

Report:
- account net return
- MTM MDD
- trades
- win rate
- PF
- accepted/rejected capacity
- top1/top3 profit concentration

A favorable observed-history result remains only a research candidate. It cannot modify the indicator score or become a Champion without unused OOS/Forward.
