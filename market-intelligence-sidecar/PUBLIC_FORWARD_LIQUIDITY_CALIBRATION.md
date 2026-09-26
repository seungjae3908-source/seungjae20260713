# Public Forward Liquidity Calibration Collector

## Purpose

This collector preserves future public-market observations that may later support an independent liquidity-impact calibration. It does not estimate a coefficient, prove that liquidity impact is present, or turn an observation into an execution cost.

Simulated Paper orders never move the real market and are never accepted as causal market-impact events. The only event source in this contract is a public Bitget trade that occurs after a captured public L2 frame.

## Verified public capability

The collector uses only these unauthenticated GET endpoints:

- `/api/v3/market/orderbook`: bid/ask price and quantity plus match-engine timestamp
- `/api/v3/market/fills`: public execution ID, execution-link ID, price, size, trade side, and fill timestamp

The provider documents `side` as public trade side, not as an explicit `tradeScope=taker` field. The collector therefore accepts an aggressive side only when the public buy prints at or above the pre-event best ask, or the public sell prints at or below the pre-event best bid. A mismatch is dropped as `AGGRESSIVE_SIDE_NOT_VERIFIED_AT_PRE_EVENT_BBO`.

Natural Forward collection captures the pre-event book first, waits a fixed event-observation window (two seconds by default), and only then fetches public fills. This makes the eligible event interval genuinely forward-looking instead of relying on a race between two immediate requests. Older fills remain visible in dropped-event provenance but receive no sample credit.

Local request-start and receive timestamps are captured around every public response. A bounded five-second provider-clock skew is tolerated; timestamps beyond it, and missing, stale, crossed, misordered, malformed, or identity-mismatched data, fail closed.

## Observation contract

Every accepted observation preserves:

- deterministic observation ID
- market, symbol, event timestamp, and local receive timestamp
- BBO-verified aggressive side
- public flow quantity and notional
- pre-event best bid/ask, mid, spread, visible L2 levels and book digest
- public execution price
- public endpoints, public execution IDs, raw payload/row digests, and source digest
- exact 40-character collector code SHA
- missing-data flags
- later public BBO/mid observations

`INSTANTANEOUS_VISIBLE_DEPTH_BOOK_WALK` and `SUBSEQUENT_PUBLIC_PRICE_DRIFT` have separate immutable identities. The book walk remains owned by `SLIPPAGE_VISIBLE_L2_BOOK_WALK_ONLY`; subsequent drift is calibration-source-only and has `executionCostEligible=false`. This separation allows a future model to remove the instantaneous book-walk component before considering any distinct impact target.

## Sample identity and leakage controls

- `FORWARD_NATURAL_SAMPLE` can receive forward calibration sample credit only when collected in real time.
- `CALIBRATION_RESEARCH_SAMPLE` always has forward credit `0`.
- Historical backfill forward credit is always `0`.
- The two sample classes cannot share one dataset chain.
- Missing price is rejected; it is never forward-filled.
- A pre-event book must precede the event and stay inside the fixed maximum age.
- Post-event books must follow both the event timestamp and local trade receive timestamp.
- Duplicate observation IDs add zero sample credit; changed content under the same ID fails closed.

## Durable store boundary

The writer does not create a database, Supabase table, cloud bucket, release, or arbitrary permanent path. The caller must explicitly supply the existing canonical Research Production state root and the exact contract `research-production-state-root/forward-liquidity-calibration-v1`.

Data is stored beneath:

```text
<RESEARCH_STATE_ROOT>/forward/liquidity-calibration-v1/<sample-class>/<collector-sha>/dataset.json
```

The dataset uses an exclusive lock, atomic replacement, predecessor digest, deterministic normalized/raw digests, and exact collector-SHA/sample-class isolation. Absence of the canonical state root or contract returns `BLOCKED_STORAGE` without collecting or persisting data.

The CLI is a one-shot harness, not a timer or activation mechanism:

```text
node market-intelligence-sidecar/scripts/run-public-forward-liquidity-calibration.mjs \
  --symbol BTCUSDT \
  --collector-sha <exact-40-character-sha> \
  --event-window-ms 2000 \
  --state-root <existing-research-production-state-root>
```

## Truth state

```text
PUBLIC_CALIBRATION_DATA_CAPABLE=true
LIQUIDITY_CALIBRATION_DATA_COLLECTOR_READY=true
LIQUIDITY_IMPACT_PRESENT=false
CALIBRATION_SAMPLE_SUFFICIENT=false
LIQUIDITY_IMPACT_STATUS=BLOCKED_DATA
FULL_COST_READY=false
```

No private account/order endpoint, live order, cancel, amend, transfer, withdrawal, Paper-order causal claim, coefficient fabrication, schedule activation, deployment, or Production mutation is present.
