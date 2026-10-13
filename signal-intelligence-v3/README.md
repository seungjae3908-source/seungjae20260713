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

### Manual public-evidence review in the app (Draft)

The signal-detail `AI 근거 검토` button calls the existing authenticated
`POST /api/market/scan/ai-review` endpoint only on explicit click. Ordinary scans
and automatic polling capture bounded public snapshots without calling a model.
The request accepts only `signalId` and a server-produced `evidenceKey`.
Snapshots are member-scoped, retained for at most five minutes or the card's
expiry, and checked before and after analysis. Client prices/facts, other-member
snapshots, expired evidence and revoked access do not authorize a review.

The existing AI provider chain is reused; configured providers may incur cost.
There is no new credential, provider migration or live model verification in this
Draft. Grounded structured summaries separate server facts, model inferences,
missing evidence and risks. They never update ranking/score, provide a profit
probability, set profitability PASS, place a Paper/real order or send Telegram.
Missing providers/invalid output are explicit unavailable results, not AI PASS.

### Public-cycle progress and publication

`public-cycle-progress-v2` permits research-only cursor advancement for a fully
attempted, error-free page from the market-matched roster even when source/data
coverage is incomplete. Such pages remain `BLOCKED_DATA`, never candidates or
valid zero trades. Provider failures/timeouts, missing execution fields and
cursor evidence mismatches hold the cursor. Roster floors only detect anomalous
truncation, not full-market or historical/PIT coverage.

The normal US app path and public runner share the strict Nasdaq Trader
`nasdaqlisted.txt` / `otherlisted.txt` parser when a configured Finnhub roster
is unavailable. Both schemas, final creation-time footers and source timeliness
must validate; HTML, tiny/truncated pairs and unknown fallback catalogs do not
become verified current rosters. The footer's New York time remains the search
index basis time, distinct from the download time. This current listing source
does not supply delisted/PIT history, corporate actions or licensed minute bars.

Producer state schema 4 binds each lane cursor to a SHA-256 of the ordered
eligible roster. Listing/source/order changes reset the lane to zero before
publication. Snapshot roster-binding version 1 also requires matching current
page and row provenance. Dynamic price/volume changes do not change this binding.

### Canonical automatic-trading handoff

The public runner can consume `SIGNAL_INTELLIGENCE_CANONICAL_HANDOFF_FILE`.
Scanner cards receive Profit/Risk/AI provenance only after an exact match on
signal, market, symbol, timeframe and direction against a digest-validated
`member-auto-trading-paper-handoff-v1` entry. It re-reads and validates the
handoff for each lane and immediately before publication, then rebuilds the
adapter input from the original card. Missing, expired, changed or ambiguous
evidence therefore produces no candidate; retained state cannot preserve a
stale profitability approval.

The background worker may opt into the published snapshot with
`MEMBER_AUTO_TRADING_SIGNAL_INTELLIGENCE_PATH` and its exact immutable release
SHA in `MEMBER_AUTO_TRADING_SIGNAL_INTELLIGENCE_SHA`. Its bridge is veto-only: it can
remove entries from the already validated canonical handoff but cannot inject,
replace, duplicate or mutate one. Omitting either path keeps the release
disabled and does not change deployment or real-order authority.

### Public provider connectivity diagnostic

`scripts/diagnose-public-providers.ts` probes only these public origins:
`query1.finance.yahoo.com`, `query2.finance.yahoo.com`,
`www.nasdaqtrader.com`, `api.upbit.com`, and `api.bitget.com`. When an HTTP(S)
proxy is configured, it checks the CONNECT tunnel first. A proxy CONNECT 403 is
reported separately from an HTTP 403 returned after reaching the provider, and
the report never reads credentials or calls private/order endpoints.

The stock scanner excludes open intraday candles and daily bars before regular
exchange-local close (US DST-aware); early-close calendars remain outside this
contract. Requested upper-timeframe candles receive their own OHLC/time/volume
quality checks and need 60 bars for the existing EMA60 context. Missing, stale,
invalid or insufficient context cannot be silently replaced by primary candles
or authorize an S/A plan. A blocked empty page is data-quality rejection, not a
verified zero-signal result.

Current lists/events require this cycle's page provenance; retained history is
kept in research rows, not reissued as fresh signals. Health distinguishes a
recent file timestamp from twelve verified current pages. Neither proves that
the whole roster was swept, profitability passed, or Paper is ready. Future
timestamps and a mismatching service revision fail closed. The standalone
fixture runner remains a contract test, not a live-market profit result.

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
