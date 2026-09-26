# Market Intelligence Sidecar Safety Contract

This service is a read-only intelligence sidecar. It is deliberately isolated from the app Production process and from all order execution authority.

## Hard invariants

- `executionAuthority=NONE`
- `privateTradingApiAllowed=false`
- `realOrderAllowed=false`
- `orderSubmissionAllowed=false`
- loopback bind only (`127.0.0.1`)
- no account, balance, position, order, cancel, amend, transfer, withdrawal, API-key, or private exchange request
- no Production database mutation
- no signal is allowed to bypass the parent Quant / Profit / Risk / Portfolio / Execution gates

## Scanner integration contract

The sidecar is a `SOFT_INTELLIGENCE_LAYER` by default. Missing optional microstructure or structural data must remain visible as `NOT_AVAILABLE`/warnings instead of deleting otherwise valid Scanner candidates. Hard blocking is reserved for explicit safety/data conditions such as stale intelligence, configured spread breach, or extreme dilution risk.

## Auto-trading integration contract

The sidecar never submits an order. Until explicit forward evidence meets the caller-visible versioned policy, auto-trading mode is `PAPER_ONLY`. Even after evidence is sufficient, the highest state this service can produce is `ELIGIBLE_FOR_PARENT_GATE`; the existing parent execution pipeline must independently re-check Profit, Risk, portfolio exposure, order preparation, approval, and execution policy.

## Failure isolation

If this service is unavailable or times out, the parent Scanner remains available and reports intelligence as unavailable. Parent auto-trading must fail closed for new intelligence-dependent trades rather than infer missing intelligence.

## Data sources

Public collectors are limited to public market-data endpoints. Current v1 directly supports Bitget UTA v3 public futures evidence and Upbit public spot orderbook/trade evidence. Stock and microcap structural evidence is accepted only as normalized read-only input until a separately validated public filing/market-data adapter is connected.
