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

## Draft: Bitget Futures V3 public-only 60m incomplete-batch budget

A live-public 20-instrument 60m futures batch returned `SEARCH_FAILURE`,
`responseDataState=partial`, 0 provider errors and 0 timeouts.
The scanner supports 12s total and Bitget V3 has a conservative public
IP-group request pacer, so a partial batch may reflect unstarted or unfinished
work instead of HTTP failures. V3-only Futures stage-2 is now capped at 10
instruments per run, preserving the full 820-symbol discovery roster and
cursor rotation by the actual requested count. No shared member, Paper or
real futures setting is modified. A new bounded
`publicExecutionDiagnostic` records requested, started, completed,
deadline and item-failure aggregate counts, never symbols, headers or payloads.
A new true public run is required to determine whether the constraint solves
the observed 60m failure; no guarantee of success from mock CI.

## Draft: Crypto "green" candidate batch with invalid-data failures is blocked

A genuine V3 Spot 1D public cycle had `CANDIDATES_AVAILABLE`, zero
provider/timeouts, and `partial=false`, but its existing Crypto Scanner
also reported one `invalid_data` failure (a fulfilled worker returning a
null candidate, potentially because fewer than five candles were available).
Previously that failure was concealed by the status classifier and the
research cursor advanced. The isolated V3 classifier now requires an explicit
failure array. It returns `BLOCKED_DATA` for any invalid-data/item-mapping
row or `SEARCH_FAILURE` for provider errors/timeouts/malformed items,
and holds the research cursor rather than silently skipping that symbol.
Only a fully completed zero-failure source batch may advance and be adapted
into Signal V3/Paper-ready candidates. No shared member/real execution code
or profitability/quality threshold is relaxed. Missing candles must be
verified from a genuine public provider; they cannot be manufactured.

## Draft: per-cycle source epoch and truthful current-page health

A rotating roster cursor is reused after a full pass and cannot prove
a candidate was actually rediscovered on the latest pass. Every V3 public
cycle now generates a UUIDv4 `sourceCycleId`; new candidate provenance
and all twelve lane coverage rows share that ID. Read-only publication
requires **same cycle, same lane, same cursor, genuine source**. Retained
prior-cycle research rows and prior-epoch alerts never count as fresh
publication, even after cursor wrap. Missing/mixed cycle IDs fail closed.

Full-profile /health separately marks `snapshotCurrentPageSourceReady=false`
and `snapshotFresh=false` when source checks fail. This is not whole-roster
coverage or a Production runtime check. No Bot API send, secret access, user
order, DB, PM2/systemd or deployment action is authorized in this Draft.

## Draft: safe manual rescan state location and future/invalid-clock guards

The V3 systemd timer sets both the state directory and snapshot path, but
the server's `/internal/rescan` child previously passed only the snapshot
path. The public-only producer would therefore resolve `cycle-state.json`
relative to its executable directory, which could be unwritable in a
protected server. The child now inherits the exact parent
`SIGNAL_INTELLIGENCE_STATE_DIR=dirname(STATE_FILE)` and an explicit
public-only flag, without enabling any trading/private-provider authority.
A local mock producer verifies all child env fields; it does not call
actual exchanges or start a real rescan on Staging/Production.

The server also rejects nonnumeric/excessive freshness threshold settings
and future-dated snapshots more than 5 seconds ahead. A future timestamp
cannot turn an untrusted V3 signal into a fresh 200. Production runtime
`SNAPSHOT_STALE` / 503 resolution still requires separately approved
real read-only systemd/snapshot evidence after deployment; these Draft code
tests alone do not prove the operational root cause was repaired.

## Draft: bounded invalid-item research rotation avoids whole-market starvation

A five-coin Spot 1D page had zero HTTP errors/timeouts but one
`invalid_data` item (insufficient public candles) and four other completed
items. Holding cursor zero would prevent scanning the rest of the Spot
roster until this single coin acquired enough daily history, potentially
for days. Only a fully started and completed zero-provider-error page with
explicit `invalid_data` may now rotate the *research-only* cursor as
`BLOCKED_INVALID_DATA_RESEARCH_ROTATION_ONLY`. It stays `BLOCKED_DATA`
and contributes no V3 Telegram candidates, no Paper or real authority.
Provider errors, malformed, incomplete and stale batches still hold
the cursor. The invalid instrument is revisited when rotation wraps;
missing historical candles remain unproven rather than fabricated.

## Draft: stock session-gap and KRX exclusion root-cause evidence

The stock scanner's existing session-aware quality rule compares
15m/60m bar intervals without an exchange-specific intraday schedule.
The bounded V3 public scan now calculates **diagnostic-only** counts
using exchange-local regular-session clocks (KR 09:00–15:30 KST;
US 09:30–16:00 America/New_York, with DST) on already fetched candles.
Counts distinguish gap candidates inside a single regular trading
session from overnight/boundary/premarket/extended-hours gaps.
Exchange holidays, half-days, halts and individual vendor semantics
are **not inferred as verified**, and the original scanner quality
gate and `BLOCKED_DATA` remain unchanged.

The 2,837 public KRX exclusions are now summarized by code shape and
instrument/ETP class **without instrument IDs or names**. A numeric
six-digit ticker inside an exclusion or a mismatched stated total is
reported rather than silently forgiven. This information helps choose
a legitimate read-only source for nonnumeric KRX instruments but is not
a claim that any vendor universally supports them. No new provider
requests, chart fabrication, private access, release activation or
trading authority are introduced.
