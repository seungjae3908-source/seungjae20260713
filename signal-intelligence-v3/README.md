# Signal Intelligence V3 — Independent Release Unit

This directory is intentionally isolated from the application UI and private trading execution path.

## User-visible lists

- `KR_STOCK` → BUY candidates only
- `US_STOCK` → BUY candidates only
- `CRYPTO_SPOT` → BUY candidates only
- `CRYPTO_FUTURES` → separate LONG and SHORT candidate lists

Cash-market sell/exit/reduce planning belongs to Portfolio, not this new-entry scanner.

## Futures direction contract

LONG and SHORT are evaluated independently. When both sides for the same market/symbol/strategy/timeframe pass their upstream gates, V3 compares their cost/risk-adjusted utility. If the separation is too small, both sides become `ABSTAIN`; it never forces a direction just to fill a list.

## AI committee contract

V3 accepts normalized findings from Catalyst, Technical Change, Risk Critic, and Contradiction AI roles.

AI may:
- request an immediate deterministic rescan;
- attach reasons;
- reduce authority to `ABSTAIN` through contradiction/risk veto.

AI may never:
- turn a Quant/Profit/Risk rejected item into a candidate;
- fabricate price, probability, PF, expectancy, cost, MAE/MFE, or liquidation evidence;
- increase leverage;
- grant execution or order authority.

## Dynamic conservative leverage

The leverage engine does not use a fixed “high leverage is always bad” rule and does not invent exchange liquidation formulas. It consumes verified leverage/tier evidence and requires a liquidation buffer beyond the worst of stop distance, MAE q95, and downside interval plus spread/slippage. Volatility, liquidity, and uncertainty increase the required buffer.

Outputs are `INDICATIVE_ONLY`, including a recommended range and hard maximum. They never authorize orders.

## Telegram

Canonical signal events are converted into the existing alert types:
- `strong_buy`
- `crypto_spot_buy`
- `crypto_futures_long`
- `crypto_futures_short`
- `intelligence_report` for state changes/rescan events

The production transport remains an injected sender so V3 does not create a second Bot API authority. Dedicated stock/crypto room routing fails closed if the destination is missing.

## Safety boundary

Always:
- `executionAuthority=NONE`
- `privateTradingApiAllowed=false`
- `realOrderAllowed=false`

Actual account reads, orders, cancels, amendments, transfers, withdrawals, and live auto-trading belong to a separately released Execution Gateway.

## Standalone validation

```bash
node --test signal-intelligence-v3/tests/*.test.mjs
node signal-intelligence-v3/scripts/verify-contract.mjs
```

## Standalone cycle

```bash
node signal-intelligence-v3/scripts/run-cycle.mjs \
  --input candidates.json \
  --output snapshot.json \
  --telegram-events telegram-events.json
```

The input is canonical deterministic evidence from the existing Scanner/Profit/Risk pipeline. The output can be consumed by both the application and Telegram without recalculating signals independently.

## Draft: public-only stock candle metadata path

The V3 stock Scanner actually invokes `MarketDataService.getCandlesMeta()`
through `ScannerProviderHealthTracker`, not just `getCandles()`.
The isolated V3 producer now binds **both** methods to the same Yahoo
public-only handler for the duration of each KR/US lane and restores them
on exit. An unavailable public response stays unavailable rather than
falling into a differently sourced app candle chain. Deterministic
regression tests assert both methods, restoration and fail-closed behavior.

This binding fix alone does not prove the three existing KR/US
`BLOCKED_DATA` lanes are resolved or that a source offers complete
timeframe/session coverage. Retain the strict no-signal/NO-GO state until
fresh source-backed real provider runs pass. No member Scanner, Paper,
production application, order or account code is modified by this Draft.

## Draft: KRX public roster exclusion is not verified all-symbol coverage

The public KRX inventory can explicitly exclude thousands of unsupported
alphanumeric listings while still reporting a fully attempted **eligible**
batch. These are distinct concepts. The Signal V3 stock producer now
propagates `rawTotalCount` and `explainedExcludedCount` into a
fail-closed `universe.partial` lane, together with aggregate counts only.
A truly incomplete source cannot be promoted from
`VALID_NO_TRADE` to full four-market coverage by merely rotating its
research-only cursor. This does not exclude an eligible stock from future
research, does not suppress provider errors, and never creates a trading
candidate or economic credit from the omitted stocks. Resolving complete
KR coverage requires a provider capability for the excluded symbols.

## Draft: diagnose intraday quality using existing exact-cycle candles

When a KR/US public lane is `BLOCKED_DATA`, the V3 producer now records
coarse `STALE_TIMESTAMP`, `MISSING_CANDLE`, `INVALID_OHLC`,
`ABNORMAL_SPIKE`, etc. issue-code counts and trusted/degraded/untrusted
counts from **the same already-fetched primary Yahoo candle arrays**.
The diagnostic window matches the Scanner mode's recent quality window
(240/320/400 candles), with session-aware checks. It adds zero provider
requests and omits all symbols, timestamps, OHLCV rows and raw exception
messages. It is diagnostic evidence only, never a trading signal, PASS or
excuse to bypass incomplete roster coverage.
