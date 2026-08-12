# Integrated Backtest / Paper / Shadow Research Contract V1

This research-only contract connects existing Historical Backtest, OOS, Walk Forward, Final Holdout, Paper Trading, and Shadow Trading results without reimplementing any execution engine.

## Immutable strategy identity

Every compared stage must refer to the same:

- `strategyFamily`
- `strategyVersion`
- `parameterHash`
- `market`
- `symbol`
- `timeframe`
- `side`
- `researchCodeSha`

Identity mismatches fail closed. Cash and spot markets cannot introduce a new short position through this contract.

## Stage metrics

The comparison artifact can carry initial/final capital, return, net profit, win/loss rates, Profit Factor, expectancy, drawdown, average win/loss, risk/reward, trade count, holding duration, streaks, fee/slippage/spread/funding costs, exposure, capital utilization, risk-adjusted metrics, data quality, freshness, provider provenance, and regime-separated metrics.

A zero-trade sample must not report a fabricated `0%` win rate, Profit Factor, or expectancy. Those values remain `null` until a settled sample exists.

## Backtest / Paper / Shadow gaps

The contract computes comparable deltas for:

- Backtest vs Paper
- Backtest vs Shadow
- Final Holdout vs Paper
- Paper vs Shadow
- matching market regimes

Win-rate and return gaps are expressed in percentage points. Costs, Profit Factor, expectancy, holding duration, and trade-count gaps are direct deltas.

## Promotion boundary

Research may progress only through:

`RESEARCHING -> OOS_VALIDATED -> WF_VALIDATED -> PAPER_VALIDATED`

`PAPER_VALIDATED` requires explicit OOS, Walk Forward, Final Holdout, Paper, and Shadow validation and available Paper/Shadow samples. This contract never grants live authority.

## Safety

The following values are immutable:

- `simulatedOnly=true`
- `liveOrderAllowed=false`
- `privateAccountRequestAllowed=false`
- `orderSubmitted=false`
- `actualOrderCount=0`
- `privateTradingApiCalls=0`
- `livePromotionAllowed=false`

No Production, Staging, server, database, Secret, broker account, or order mutation is part of this contract.
