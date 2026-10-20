# stat-arb two-leg hedge adapter

Dedicated adapter for the crypto stat-arb strategies validated in
`crypto-stat-arb/` (PR #2004). It is deliberately **not** wired into the
single-leg Bitget handoff (`trade-automation.service.ts`,
`member-auto-trading-background-worker`): nothing in this directory is imported
by production code. Only the tests import it.

## What it does

| File | Role |
| --- | --- |
| `stat-arb-hedge.types.ts` | Signal schema `stat-arb-hedge-signal-v1`, pair/leg state, ports |
| `stat-arb-hedge-capabilities.ts` | Venue capability matrix as verified in this repo; `evaluateHedgeCapability` |
| `stat-arb-hedge-validation.ts` | Shape/freshness validation, idempotency keys, step rounding, exposure, performance gate |
| `stat-arb-hedge-adapter.ts` | `StatArbHedgeAdapter.enter / exit / recover` state machine |
| `stat-arb-hedge-bridge.ts` | Read-only projection of a leg onto `TradingPlanInput` (tests only) |
| `stat-arb-hedge-mock.ts` | Scripted mock venue (fill / partial / open / reject / timeout / disconnect / unknown) and in-memory stores |
| `*.test.ts` | Unit, fault-injection and existing-order-path integration tests |

### Supported hedge (the only one)

`carry_upbit_spot_long__bitget_perp_short`: long Upbit KRW spot (BUY) +
short Bitget USDT-FUTURES (isolated, leverage = member policy, 2–7 live).
Everything else (Binance, Hyperliquid, Bitget spot, reversed direction,
hedge mode, cross margin, leverage outside 2–7) is blocked with
`UNSUPPORTED_HEDGE_COMBINATION` / `VENUE_ADAPTER_MISSING:*` / `*_SIDE_UNSUPPORTED`.

### Entry flow

1. Schema → capability → freshness (data age, expiry, FX age, clock skew).
2. Performance gate: PR #2004 `summary.csv` rows for the same strategy, leverage,
   `researchCodeSha` and `cost_profile=current_public_assumed` must all be
   `status=OK`, `data_verdict=OK`, ≥180 days, ≥30 trades, `net_return>0`,
   `pf_net>1`, `liquidations=0`. Any failing or missing row → authority `NONE`.
3. Execution authority: default `NONE` (places nothing). `MOCK` only drives
   mock ports. `LIVE` is refused while `LIVE_AUTHORITY_RELEASED === false`
   and would in any case refuse a mock port.
4. Duplicate signal → returns the existing pair, no order.
5. Control: emergency stop, new-entries stop, per-venue order **and cancel**
   permission, leverage must equal the policy leverage.
6. Open pair in `UNBALANCED | UNWINDING | UNKNOWN | *_SUBMITTED | EXITING` →
   `HEDGE_IMBALANCE_OPEN`, Telegram-style alert.
7. Foreign strategy position/open order on the same venue+symbol → conflict.
8. Instrument rules per venue (min qty, qty step, price step, min notional,
   Upbit 5,000 KRW), planned legs must be hedge-neutral (≤ `maxImbalanceBps`).
9. Existing safeguards reused from `trade-automation-risk.service.ts`:
   `projectMarketLedger` (drift vs exchange balance, 1,000 KRW tolerance) and
   `finalAllowedEntryKrw` (role cap / policy max / allocation / ledger /
   exchange available) per market (`crypto_spot`, `crypto_futures`).
10. Position mismatch on the perp venue vs. the adapter's own open pairs → block.
11. Leg 1 = spot BUY. Leg 2 = perp SHORT sized to the **actual** spot fill,
    rounded **down** to the contract step.
    * leg 1 rejected → `REJECTED`, leg 2 never sent
    * leg 2 rejected / below minimum → spot sold back (`UNWINDING → UNWOUND`)
    * partial fill → remainder cancelled after `legFillTimeoutMs`, mismatch
      beyond tolerance → `UNBALANCED` (blocks further entries, alert)
    * timeout/disconnect → the venue is queried, never assumed; order not found
      → `UNKNOWN`, halt reason `ORDER_STATE_UNKNOWN`, alert, **no unwind**

### Exit flow

Perp closed first (reduce-only), then spot sold. Exits are allowed under an
emergency stop (risk reducing) but still require order + cancel permission.
Perp failure keeps the hedge intact; spot failure after the perp closed →
`UNBALANCED` + alert. On `CLOSED` the pair carries realized PnL in KRW
(spot + perp × exit FX, fees included). Funding is recorded only when the
venue reports it (`fundingStatus: REPORTED`), otherwise `NOT_AVAILABLE_LIVE`.

### Recovery

`recover(pairId)` re-reads every non-terminal leg by `clientOrderId`, cancels
anything still working, reconciles the perp position with the pair's own
ledger and settles the phase. It places no new orders. A venue that cannot be
read, or a position that disagrees, halts the pair (`RECOVERY_RECONCILIATION_FAILED`).

### Idempotency

`sha256(user|strategy|signalId|signalAt|action|legId)` → `sah-<venue>-<20 hex>`.
The `sah-` prefix keeps hedge orders apart from the existing `sj-` path.
Replaying the same signal returns the stored pair; replaying the same
clientOrderId is rejected by the venue.

## What it does not do (yet)

* No live `HedgeExchangePort` for Upbit or Bitget exists. Writing one means
  reusing `prepareUpbitOrder` / Bitget request builders and the 30 s recovery
  worker polling, and is a separate owner-approved change.
* Not wired into the worker, routes, or Supabase persistence.
* The research evidence (PR #2004) was produced on Binance/Hyperliquid data;
  the only executable venue pair here is Upbit/Bitget. That basis mismatch is
  a residual risk the performance gate cannot close by itself.
* Upbit's `identifier` (client order id) support and Bitget `clientOid`
  acceptance of the `sah-` format have not been exercised against the real APIs.
