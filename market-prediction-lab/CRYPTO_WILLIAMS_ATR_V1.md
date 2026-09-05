# Crypto Williams + ATR V1

## Scope

This research strategy is intentionally limited to signal generation plus Paper/Shadow simulation.
It does not permit live execution, private exchange API requests, real orders, or real cancellations.

- Strategy ID: `crypto-williams-atr-v1`
- Spot: LONG only
- Futures: LONG and SHORT
- Session boundary: Asia/Seoul 09:00, exactly UTC 00:00
- Kelly sizing: disabled in V1
- Live execution: hard disabled

## Entry formulas

Previous range:

```text
range = previousHigh - previousLow
```

LONG target:

```text
longTarget = sessionOpen + range * K
```

LONG entry:

```text
currentPrice >= longTarget
AND sessionOpen > movingAverage
```

Futures SHORT target:

```text
shortTarget = sessionOpen - range * K
```

Futures SHORT entry:

```text
currentPrice <= shortTarget
AND sessionOpen < movingAverage
```

## V1 defaults

- `K = 0.5`
- `ATR period = 14`
- `ATR stop multiplier = 2`
- `riskFraction = 0.005` (0.5% of capital)
- `MA period = 5`

All defaults are parameterized for research. V1 caps `riskFraction` at 1% and does not claim that any parameter is optimal.

## ATR stop and position sizing

```text
stopDistance = ATR * atrStopMultiplier
riskMoney = capital * riskFraction
quantity = riskMoney / stopDistance
```

LONG stop:

```text
stopPrice = entryPrice - stopDistance
```

SHORT stop:

```text
stopPrice = entryPrice + stopDistance
```

The returned `quantity` is a strategy-level base quantity. An exchange adapter must convert it to the instrument's legal lot, step size, contract multiplier, inverse-contract convention, minimum notional, and precision before any future execution integration.

## Exit lifecycle

A simulated position exits on the first applicable condition:

1. At the next KST 09:00 session boundary (`NEXT_SESSION_OPEN`).
2. Inside the entry session when the ATR stop is crossed (`ATR_STOP`).

`evaluateCryptoWilliamsAtrExit()` accepts an explicit `riskPrice`. This is intentional: the exchange/public-market adapter owns the contract for whether a venue uses last, mark, or another reference price for a given simulated risk rule. V1 does not silently invent an exchange-specific trigger source.

## Execution cost diagnostics

The signal result records:

- fee rate
- spread rate
- slippage rate
- estimated round-trip execution cost rate

These fields are research diagnostics. Backtests and Paper/Shadow accounting must apply the actual cost model rather than treating the diagnostic estimate as guaranteed realized cost.

## Futures Shadow safety gate

A futures signal may remain observable in Paper mode with incomplete derivatives context, but it cannot produce a Shadow order plan unless all of the following are supplied:

- `markPrice`
- `fundingRate`
- `leverage`
- `liquidationPrice`

The liquidation guard must also confirm that the ATR stop is reached before the supplied liquidation price:

- LONG: `liquidationPrice < stopPrice`
- SHORT: `liquidationPrice > stopPrice`

If derivatives context is incomplete, the result includes `shadow_derivatives_context_incomplete` and `eligibleForShadow=false`.

## Shared scanner / Shadow contract

The same result from `evaluateCryptoWilliamsAtrSignal()` is used to build:

- scanner output through `buildCryptoWilliamsScannerSignal()`
- simulated Shadow order plan through `buildCryptoWilliamsShadowOrderPlan()`
- exit lifecycle through `evaluateCryptoWilliamsAtrExit()`

This prevents separate scanner and automation formulas from drifting apart.

Shadow plans use:

- `mode = SHADOW`
- `orderType = MARKET_SIMULATED`
- futures exit is reduce-only
- `liveExecutionAllowed = false`
- `privateExchangeApiAllowed = false`

## Safety boundaries

V1 must not:

- call private exchange endpoints
- place or cancel a real order
- enable live auto-trading
- enable Kelly sizing
- modify Production, PM2, Caddy, secrets, or an operational database
- infer profitability from the strategy formula alone

Promotion beyond Paper/Shadow requires independent backtest, out-of-sample, walk-forward, replay, Paper and Shadow evidence plus a separate approval decision.

## Research grid for later validation

Planned parameter research can compare, without declaring an in-sample winner as production-ready:

- K: 0.3 / 0.4 / 0.5 / 0.6 / 0.7
- ATR stop multiplier: 1.0 / 1.5 / 2.0 / 2.5 / 3.0
- MA: 5 / 10 / 20
- risk: 0.25% / 0.50% / 0.75% / 1.00%

Spot, futures LONG, and futures SHORT results must be reported separately with fees, spread, slippage, funding where applicable, drawdown, expectancy, profit factor, loss streaks, and regime breakdowns.
