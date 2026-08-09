# Phase 12 approval-order safety contract

## Scope

This phase is approval-based simulation only. The supported account modes are `paper` and `mock`; real-account order placement, real cancellation, private broker/exchange requests, automatic liquidation, and unattended live execution are outside this phase.

The route-reachable execution coordinator is deliberately air-gapped from private exchange adapters. Paper/mock execution, cancellation, and restart reconciliation are local state transitions and write audit metadata showing that no exchange/private API request was sent. A `live` plan presented to the coordinator is rejected with `LIVE_EXECUTION_DISABLED` even when legacy live environment flags are set.

## Approval lifecycle

The approval-level lifecycle contract is:

`signal_received -> risk_review -> plan_created -> awaiting_user_approval -> approved -> submitting -> partially_filled|filled -> cancel_requested|exit_planned -> cancelled|closed`

Terminal or exceptional states are `rejected`, `expired`, `failed`, and `condition_invalidated`. Unsupported transitions are rejected. In particular, `awaiting_user_approval -> submitting` is forbidden, and a filled position may only move to an `exit_planned` path that requires a separate approval before any future real exit implementation.

Persistent order events record the user, timestamp, previous state, next state, reason, and metadata. Atomic plan submission, idempotency keys, execution claims, and per-user repository scoping prevent duplicate approval/submission and cross-user order access.

## Risk controls

The approval risk engine enforces the existing total capital/order amount, daily loss, exposure percentage, open-position count, daily order count, consecutive-loss, leverage, slippage/spread, stale feed, rapid-move, halt, orderbook-gap, balance, split-ratio, and exit-plan checks.

Additional approval controls in this phase are:

- `newEntriesStopped`: blocks new entries while preserving reduce-only/exit evaluation paths.
- `weeklyLossLimitPercent`: blocks a plan when the supplied weekly PnL snapshot breaches the configured loss limit.
- `maxInstrumentKrw`: blocks projected per-instrument exposure above the configured amount.
- `maxAssetClassKrw`: blocks projected exposure for `domestic_stock`, `us_stock`, `crypto_spot`, or `crypto_futures` above its configured amount.

These values are stored in the existing policy JSON payload, so this phase does not require a production database migration. Existing policies are backward-compatible through normalization defaults.

## Paper/mock execution guarantees

Tests intercept global outbound HTTP and verify zero outbound calls for paper/mock execution, cancellation, and restart recovery. The same tests enable every legacy live/mock environment flag and still verify that the route-reachable coordinator performs no private API request. Live execution is rejected locally.

Partial fills retain `filledQuantity` and `averageFillPrice` when the remaining simulated order is cancelled. Restart recovery first marks ambiguous open orders as recovery-required and then resolves paper/mock state from local audit history without authenticated exchange status queries.

## Scanner approval

Scanner-generated order plans are paper-only, server-revalidated immediately before approval, idempotent, duplicate-symbol guarded, split-order validated, price-drift checked, and subject to the same risk recheck before the order is atomically created. The desktop/mobile approval UI requires explicit confirmation and does not expose an automatic-execution path.

The current scanner order contract creates one user-selected candidate plan at a time. It therefore cannot automatically submit every equal-score candidate. Portfolio ranking inputs such as cross-candidate expected value, maximum drawdown, correlation, and fillability remain owned by the signal/backtest contracts; they must be supplied as a verified cross-workroom contract before a batch allocator is connected. No synthetic ranking values are invented in the order engine.

## Explicitly not performed

- No real order or cancellation.
- No private exchange/broker request.
- No live-mode activation.
- No production or staging execution.
- No secret or permission change.
- No production database migration.

Any sandbox/private API integration, production DB change, secret registration, real-account connection, or live activation requires separate explicit approval.
