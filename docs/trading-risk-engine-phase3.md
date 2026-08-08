# Phase 3 — Preview-only trading risk engine

## Scope

This phase adds a deterministic, preview-only risk calculator shared by stock, crypto spot, and crypto futures scenarios. The first UI integration is the existing Bitget USDT futures workspace.

The engine runs before any AI or order logic. It does not submit, prepare, approve, or execute an exchange order.

Not included:

- real orders or auto-trading changes
- backtesting
- paper fills or trading journal
- AI trade review
- WebSocket work
- database migrations
- environment-variable changes
- production deployment
- broad permission-system changes

## Existing-code reuse and separation

The existing frontend `calculateAutoTradeRiskPreview` was inspected. It already models account risk budget and floors an integer stock quantity, but it does not include fees, two-sided slippage, funding, reward/risk, exposure, or liquidation. The Phase 3 service generalizes those concepts as a pure calculation module instead of calling the legacy order layer.

The existing `crypto-auto.ts` contract helpers and order-plan flow were inspected for quantity-step, minimum-quantity, minimum-notional, leverage, and daily-order concepts. That file remains unchanged. The new service and route do not import it and do not call Bitget private or order endpoints.

The existing `api-server/src/lib/risk.ts` and `risk-analysis.service.ts` are company/filing risk models, not position-sizing models, so they remain separate.

## Type contract

Server source of truth:

- `api-server/src/services/trading-risk-engine.service.ts`

Frontend mirror:

- `stock-analyzer/src/lib/trading-risk.ts`

The repository's current TypeScript package boundaries do not expose the server type directly to the browser bundle. As in Phase 2, the frontend mirrors the server contract. CI typechecks both sides, and this document records the unit conventions.

Important units:

- `riskPercent`: percentage points. `0.5` means `0.5%`.
- `entryFeeRate`, `exitFeeRate`, `slippageRate`, `estimatedFundingRate`: decimal ratios. `0.0006` means `0.06%`.
- `dailyRealizedPnl`, `weeklyRealizedPnl`: account currency; losses are negative.
- prices: quote-currency price per unit.
- quantities: base-asset or share quantity.
- exposure, notional, fees, margin, profit, and loss: account/quote currency.

## Core formulas

### Maximum allowed loss

```text
maximumRiskAmount = accountBalance × (riskPercent / 100)
```

Increasing leverage does not increase `maximumRiskAmount`.

### Price loss per unit

```text
long  = entryPrice - stopLossPrice
short = stopLossPrice - entryPrice
```

### Cost per unit at the stop

```text
entry fee per unit = entryPrice × entryFeeRate
exit fee per unit  = stopLossPrice × exitFeeRate
slippage per unit  = (entryPrice + stopLossPrice) × slippageRate
funding per unit   = entryPrice × abs(estimatedFundingRate)
```

The maximum-loss calculation treats funding conservatively as a cost even when its sign suggests that the selected side may receive funding. The warning text distinguishes likely payment from likely receipt.

Only one supplied/observed funding-rate value is used. The engine does not invent a holding duration or multiple funding periods.

### Position size

```text
perUnitMaximumLoss = price loss per unit
                   + entry fee per unit
                   + exit fee per unit
                   + two-sided slippage per unit
                   + funding per unit

rawQuantity = maximumRiskAmount / perUnitMaximumLoss
```

When a valid `quantityStep` is supplied:

```text
recommendedQuantity = floor(rawQuantity / quantityStep) × quantityStep
```

Decimal scaling and fixed decimal output are used to reduce floating-point step errors. The engine never rounds quantity upward.

After all costs are recomputed, a bounded adjustment loop reduces quantity by one step while:

```text
estimatedMaximumLoss > maximumRiskAmount
```

The loop has a hard maximum iteration count. Without a quantity step, a final conservative proportional reduction is used if floating-point error would otherwise exceed the risk budget.

Required invariant:

```text
estimatedMaximumLoss <= maximumRiskAmount
```

### Notional and margin

```text
notionalValue = entryPrice × recommendedQuantity
requiredMargin = notionalValue / leverage
```

Leverage changes required margin and the educational liquidation approximation. It does not change risk budget or risk-sized quantity.

## Input validation and risk policy

Default policy constants are exported as `TRADING_RISK_POLICY`.

- risk warning: above `0.5%`
- risk block: above `1%`
- daily loss block: account balance × `1%`
- weekly loss block: account balance × `3%`
- consecutive-loss block: `3`
- total notional exposure block: account balance × `300%`
- same-direction exposure block: account balance × `200%`
- minimum reward/risk: `1.0`
- strong warning range: `1.0` through less than `1.5`
- satisfactory reward/risk: `1.5` or greater

Fatal input validation blocks:

- non-positive or non-finite account balance
- non-positive or non-finite entry price
- leverage below 1 or non-finite
- risk percentage non-positive, non-finite, or above 1%
- invalid long or short stop direction
- invalid target direction
- negative fee or slippage rate
- non-finite fee, slippage, or funding rate
- otherwise non-computable core values

## Quantity and exchange-rule handling

If provided, the engine applies:

- `quantityStep`
- `minimumQuantity`
- `minimumNotional`

It does not fabricate exchange rules. When one or more of these values are not supplied, the preview remains available and includes:

> 실제 거래소 최소 수량 규칙은 미확인입니다.

Failure to meet a supplied minimum quantity or minimum notional blocks the scenario.

The first UI integration intentionally passes these fields as unknown because Phase 3 does not add another exchange-contract request or connect the preview to the existing private/order module.

## Fees, slippage, and funding

The preview reports separately:

- estimated entry fee
- estimated exit fee at the stop
- estimated two-sided slippage cost
- estimated funding cost

Maximum loss includes all four costs plus the stop-price loss.

Target profit also subtracts entry fee, target exit fee, two-sided target slippage, and the supplied funding cost.

## Reward/risk

For each target:

```text
riskReward = netEstimatedProfit / estimatedMaximumLoss
```

Policy:

- below 1.0: `RISK_REWARD_TOO_LOW`
- 1.0 to below 1.5: strong warning
- 1.5 or greater: threshold satisfied
- no target: result is `null`; no reward/risk-based approval is inferred

Target 1 is the primary reward/risk threshold when present. Target 2 is calculated and displayed independently.

## Break-even price

The break-even price is not the entry price. It solves for the exit price that recovers entry fee, exit fee, and entry/exit slippage.

Long:

```text
breakEven = entryPrice × (1 + entryFeeRate + slippageRate)
          / (1 - exitFeeRate - slippageRate)
```

Short:

```text
breakEven = entryPrice × (1 - entryFeeRate - slippageRate)
          / (1 + exitFeeRate + slippageRate)
```

If the denominator or result is invalid, the value is `null` with a warning.

## Estimated liquidation price

The UI label is:

> 예상 청산가격 · 단순 근사

The preview assumes isolated margin and uses the selected leverage. When an actual maintenance-margin rate is supplied, it can be used; otherwise the policy's explicit default assumption of `0.5%` is applied.

Approximation:

```text
long  = entryPrice × (1 - 1/leverage + maintenanceMarginRate)
short = entryPrice × (1 + 1/leverage - maintenanceMarginRate)
```

This is educational risk preview only. It does not include exchange tiered maintenance margin, account mode, cross margin, added collateral, fees at liquidation, or existing portfolio state.

The required warning is always shown for futures:

> 실제 청산가격은 거래소 유지증거금, 계정 모드 및 포지션 상태에 따라 달라질 수 있습니다.

A missing actual maintenance-margin input also produces an explicit default-assumption warning. A stop that is beyond the estimated liquidation price or within the configured minimum buffer blocks the scenario with `LIQUIDATION_TOO_CLOSE`.

## Daily, weekly, and consecutive-loss limits

These are pure inputs. Phase 3 does not read a database or journal.

- `dailyRealizedPnl <= -(accountBalance × 1%)` blocks.
- `weeklyRealizedPnl <= -(accountBalance × 3%)` blocks.
- `consecutiveLosses >= 3` blocks.

Loss values are negative by contract.

## Exposure limits

Inputs:

- current total notional exposure
- current same-direction notional exposure
- newly calculated notional value

The new notional is added before checking:

- total exposure above account balance × 3 blocks
- same-direction exposure above account balance × 2 blocks

These are risk concentration limits, not statements of allowed exchange leverage.

## Data-status policy

The Phase 2 `DataStatus` contract is reused.

- `live`: eligible for scenario assessment
- `cached`: visible with warning, blocked
- `delayed`: blocked
- `disconnected`: blocked
- `error`: blocked
- `insufficient`: blocked

`allowed` means only that the analysis scenario passes current deterministic rules. It never means an order was submitted or that an exchange would accept an order.

## API

Authenticated endpoint:

```http
POST /api/trading/risk/preview
```

The route is mounted after the existing `requireMember` middleware, so an approved logged-in member is required. It is not admin-only and does not change the permission model.

Success shape:

```json
{
  "ok": true,
  "mode": "preview-only",
  "orderSubmitted": false,
  "result": {}
}
```

The route:

- accepts JSON numeric fields as numbers, not numeric strings
- validates market, symbol, side, and data status
- limits request size to 32 KB
- returns HTTP 400 for malformed or fatal calculation inputs
- returns non-live/risk-policy blocks as a safe calculated preview
- does not expose stack traces or secrets
- does not import or call `crypto-auto.ts`

## Frontend integration

New component:

- `stock-analyzer/src/components/trading-risk-preview-panel.tsx`

It is rendered next to the existing Phase 2 market-status panel without rewriting `crypto-trading-workspace.tsx`.

Phase 2 snapshot integration:

- entry-price default uses `markPrice`, not last price
- funding default uses the snapshot's decimal funding rate
- data status is passed to the risk engine
- automatic values are identified in the UI
- a manually changed entry or funding value is not silently overwritten
- the user may explicitly reapply market defaults

The component has no order button and only calls the preview endpoint.

Required message:

> 분석용 리스크 미리보기입니다. 실제 주문은 전송되지 않습니다.

Failed or unavailable calculations display `계산 불가`, never zero.

## Tests

Phase 3 unit tests cover more than 25 distinct behaviors, including:

- input validity and non-finite numbers
- long and short sizing
- step flooring and minimum rules
- complete cost accounting
- maximum-loss invariant
- leverage-risk invariance
- target profit and reward/risk thresholds
- no-target behavior
- daily, weekly, consecutive-loss, and exposure limits
- all non-live data states
- long and short liquidation approximation
- stop/liquidation blocking
- maintenance-margin warnings
- long and short break-even prices
- funding direction warnings
- missing exchange-rule warning

API smoke tests cover:

- normal HTTP 200 preview
- `mode=preview-only`
- `orderSubmitted=false`
- malformed input HTTP 400
- non-live blocked preview
- JSON content type
- no stack trace, API key, secret, authorization token, or order-module text

CI separately executes:

1. frozen lockfile installation
2. frontend typecheck
3. backend typecheck
4. Phase 2 tests
5. Phase 3 risk tests
6. API smoke tests
7. frontend production build
8. backend production build

The existing real Bitget public-data smoke remains a separate non-blocking job and does not call a private or order API.

## Unverified items

Until separately verified, the following remain unverified:

- real browser DOM rendering
- mobile viewport, touch, keyboard, and scrolling behavior
- exact Bitget contract step/minimum rules inside the new preview panel
- exact exchange liquidation price
- long-duration funding across multiple settlement periods
- portfolio PnL/exposure data from a persistent source
- production deployment behavior

No production deployment is part of Phase 3.
