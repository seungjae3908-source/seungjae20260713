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

## Draft: cache and first-fetch KRX public roster completeness now agree

The shared ScannerUniverseService previously returned `partial:false`
on both fresh and cached `krx-symbol-master` results even when it
explicitly excluded 2,837 listed alphanumeric codes. V3 subsequently
blocked that contradiction, but other clients could misinterpret a
reachable eligible-only page as **entire market complete**.
Both fresh/cached public-source metadata now marks a known
raw-vs-eligible discrepancy as `partial:true`, including inconsistent
counts. This does **not** expand the covered roster or grant any order
or alert authority. Verified source-size equality retains `partial:false`.

## Draft: distinguish KRX product finder lineage from confirmed ETF type

KRX officially distinguishes ETF, ETN and ELW security products; the
existing app KRX provider calls a generic securities-product finder
and uses `assetType='ETF'` as a fallback if the name has no recognizable
marker. Therefore the earlier 2,730 `ETF` classification is an
**app heuristic**, not an exchange-confirmed count of genuine ETFs.
The V3 public exclusion audit now separately counts source-finder
lineage (stock finder vs securities-product finder vs unknown)
and exposes explicit `instrumentClassificationVerified=false`,
`securitiesProductSubtypeVerified=false` without logging any
ticker or name. Trading/Paper/Telegram candidate gates are unchanged
and full-roster coverage remains blocked pending official subtype
metadata and public/private provider permissions.

## Draft: prevent empty Yahoo candle pages from hiding an alternate public venue

V3's `withProviderFallback` formerly treated a successful HTTP response
containing `[]` candles as successful data; thus an unavailable KRX
suffix could mask the valid alternative. V3 now treats an empty array
as a deterministic **invalid data response**, probes at most one other
public Yahoo venue when exchange information is unknown, and fails
closed if both are empty. Known KOSPI/KOSDAQ records only use their
verified exchange suffix, never silently route to the other board.
U.S. class-share alternate symbols remain bounded. No external
private provider or order authority is used. Unit tests cover empty,
error, known-exchange and ambiguous-venue cases; source confidence,
stale/partial classification and Telegram gates are unchanged.

## Official KRX ETP subtype integration prepared (disabled by default)

Official KRX service categories are distinct `etf_bydd_trd`,
`etn_bydd_trd`, `elw_bydd_trd` through the KRX Data Marketplace.
The new `readApprovedKrxEtpSubtypes` helper is not called by
the production scanner. Its default is disabled, has no KRX key
in GitHub and performs ZERO requests without explicit enable and a
service-authorized `AUTH_KEY`. It only sends three GET requests to a
fixed official KRX host for one pinned trading date, never calls broker
accounts, and does not log tokens or full response records. Tests use
injected offline mock responses exclusively.

A dated row can explain ETF/ETN/ELW subtype, but cannot prove every
listed security is actively tradable, provide 15m/60m intraday candles,
or grant a market-wide V3 PASS / Paper / LIVE permission. Any
nonmatch/conflict stays UNKNOWN/CONFLICT. Do not enable without a
separately approved KRX service application and read-only key source.

## Draft: never cache a one-sided KRX finder response as full-market roster

The existing KRX public master loads stocks and securities products
using TWO independent finder POSTs. It silently returned `[]` for a
failed/malformed finder and let the other successful page represent the
whole exchange, poisoning the normal 24-hour universe cache.
`assertKrFinderSourcesReady` now requires plausible nonempty volume
and well-formed listing rows from BOTH finder sources before building
or caching a live KRX master. On failure the existing
`ScannerUniverseService` last-good or curated fallback paths remain
`partial/stale`, not full scan successes. The conservative minima
(1,000 stocks / 100 products) are a **source-outage guard**, not proof of
official full-universe totals; stronger authorized listing-by-listing
reconciliation is still needed. No private KRX/financial API calls,
session mutation, orders or new service activation.

## KRX date-scoped no-data guard (Draft)

A correct-looking 200 HTTP reply with an empty `OutBlock_1` (for
example, on a nontrading day or without a permitted service response)
is now `PROVIDER_DATA_INCOMPLETE`, not official verification of zero
ETF/ETN/ELW. Duplicated conflicting subtypes or noncanonical codes
yield `DATE_EVIDENCE_PARTIAL`; the reconciliation consumer remains
fail-closed and cannot treat such evidence as a verified product source.
Response byte bounds are checked, no key or source row leaves the
pure diagnostic receipt. Current application worker still never
invokes this official adapter unless separately authorized.

## Draft: TLS-only public KRX master fetch

The legacy `getKrUniverse` finder URL used plain HTTP for both stock
and securities-product lists. An on-path modified response could
misclassify, omit or inject listed instruments, even with subsequent
row-count checks. The endpoint and same-origin Referer now use HTTPS,
and `redirect:'error'` fails closed rather than allowing a downgrade
or untrusted redirect to replace the KRX roster. Source errors remain
`partial/stale` via the existing last-good/fallback path; no invented
tickers or candles, secret/API key, deployment or trading change.

## Draft: cross-cycle bounded eligible-roster page progress

The real V3 publicly observable cycle scans only 20 KR / 20 US / 5
Spot / 10 Futures instruments per market-strategy batch. A single
healthy small batch MUST NEVER masquerade as a complete all-symbol
search. A pure 12-lane `public-v3-roster-progress` counter persists
**only safe aggregates** in the existing v2 cycle state and snapshot:
contiguous *eligible cursor* progress, blocked vs data-ready attempted
pages, held/retried batches, provider exclusions and wrap counts.
Failure/partial attempts cannot become trusted candidates or
profitability results. The counter resets if the roster provider or
source counts change, never stores symbol IDs or OHLCV, and permanently
asserts `rosterMembershipVerified=false`,
`fullMarketUniverseCovered=false`, `economicAuthority=NONE`.
Even a completed 4,010-code eligible KRX traversal cannot claim the
2,837 excluded raw listed instruments were scanned. Provider source
membership can change at the same count, so this is **cursor-only
research progress**, not unique-instrument OOS proof. No new calls
or runtime/trading privileges.

## Draft: safe cursor recovery after exchange delistings shrink the roster

The V3 cursor is persisted across cycles, while a fresh KRX/Nasdaq/Upbit/
Bitget roster may become smaller after delistings. The shared scanners
clamp an out-of-range cursor to the new total and complete zero items;
without recovery V3 would hold the OLD cursor forever and never reach
the surviving symbols. `recoverShrunkPublicV3Cursor` now resets only
when the genuinely public, same-market, nonstale roster has plausible
size and zero reported provider errors/timeouts. The recovery cycle
is explicitly `BLOCKED_DATA` /
`ROSTER_SHRUNK_RESTART_RESEARCH_ONLY`: retains prior research,
does not adapt or announce candidates, does not claim any roster PASS,
and does not grant Paper/Live authority. Curated/last-good/stale,
undersized, malformed and failed source pages may NOT silently rewind.
No extra requests or private provider operations are introduced.

## Draft: stable public V3 crypto cursor despite live 24-hour rank changes

**Root cause found:** both Upbit and Bitget public ticker universes are
normally sorted by 24h trading value, which can change between two
sequential V3 research cycles. V3's persisted index cursor then samples
different symbols at a given page boundary, causing repeat/miss even
though the universe `totalCount` is unchanged. Only when
`memberId === 'signal-intelligence-v3-public-only'`, the crypto scanner
now copies and sorts validated unique ticker identities by stable ASCII
symbol order **before slicing the next cursor page**. Normal member
search results, market liquidity ranking, Forward/Paper, and live order
selection remain untouched. Malformed or duplicate symbol rows fail
closed rather than claiming all-market coverage. Mocked two-cycle
regression tests prove 6/6 unique spot and futures symbols are visited
despite adversarial trading-rank reorderings, and ordinary members
retain their original rank order.

This fixes one real all-symbol coverage defect but NOT changing listing
membership, missing Upbit day candles, costs/OOS, full-market historical
coverage, Telegram source 503 or live activation. No public request or
trading authority was added.

## Draft: restore shared Paper scanner, isolate V3 crypto sort at bundle build

The shared crypto scanner sorts by 24h turnover; across repeated V3
cursor pages, rank changes omit or repeat symbols. A first Draft fix
patched the shared `crypto-signal-scanner.service.ts`, which correctly
failed the separate Paper Forward changed-path gate and changed the
authoritative Paper runtime package digest. These protections are
deliberate and were **not bypassed**.

The shared crypto scanner and its tests are now restored byte-for-byte
to original `main`. The standalone V3-only
`scripts/build-public-producer.mjs` loads that shared scanner through
an esbuild transform and injects stable ASCII alphabetical symbol
pagination **only** for `signal-intelligence-v3-public-only`.
Ordinary member/Forward/Paper/LIVE use the unmodified backend and
original liquidity ranking. Malformed or duplicate V3 symbols fail
closed. The identical V3-only builder is used by the actual public
cycle QA and by the independently approved release activation script.
Exact source-marker and one-module-build assertions fail closed if the
underlying scanner changes; offline tests cover rank flips, duplicate
symbols and unchanged shared source. No private API, order, Telegram
send, deployment or service mutation is introduced.

## Bitget V3-only public symbol regression

A real-public producer run of the isolated V3 builder surfaced an
overstrict test-only regex for futures ticker strings: it rejected
legitimate upstream ticker formats before scanning, producing
three `FUTURES_* SEARCH_FAILURE` lanes. The public stable sorter now
preserves all nonempty, trimmed bounded upstream identities (including
exchange-defined punctuation) while rejecting duplicates, controls,
oversized or empty IDs. It never returns ticker IDs in diagnostics.
Only this V3-specific helper changed: main/Paper/LIVE scanner source,
market-symbol mapping, trading rank and order authority remain intact.
The next real public validation must show futures pages are no longer
blocked by `PUBLIC_V3_CRYPTO_ROSTER_INVALID`; mock tests alone do not
close that real provider requirement.

## Draft: Research Watch → Signal V3 private read-only access preflight

The 120-second Research Watch and Signal V3 are distinct services.
Research Watch runs as investment-research with a 0750 research root;
Watch owns private 0700 subdirectories and 0600 snapshot files.
Signal V3 uses a separate configurable service user, which may not be
allowed to traverse or read those files. A healthy Watch is therefore
not proof that Signal V3 can use its signals.

All Watch intake and extra off-page research are disabled by default.
The independently approved operating variables are:

    SIGNAL_INTELLIGENCE_V3_WATCH_HANDOFF_ENABLED=true
    SIGNAL_INTELLIGENCE_V3_WATCH_RESEARCH_SHA=<verified-Watch-SHA40>
    SIGNAL_INTELLIGENCE_V3_WATCH_OFFPAGE_RESEARCH_ENABLED=true

Only in a separately authorized read-only environment QA, under the
**actual Signal V3 service user**, run:

    SIGNAL_INTELLIGENCE_V3_WATCH_RESEARCH_SHA=<verified-Watch-SHA40> \
      node signal-intelligence-v3/scripts/preflight-watch-bridge-readonly.mjs

The script returns sanitized source status only; permission-denied,
missing Watch publication, unsafe file, invalid JSON, stale/invalid
release and verified source are not conflated. It never starts the
Watcher, queries live exchanges, changes ACLs or sends Telegram.
Do not change service UIDs, group membership or open the Research root
without separate owner approval and a least-privilege design.

Source observations are never profitability OOS PASS, Paper approval,
full-market historical coverage or real Telegram receipt. Replit banned.

## Draft: restart-safe 12-lane public Scanner checkpoint and malformed Yahoo source fallback

Signal V3 now writes a bounded, SHA-bound, service-owned checkpoint journal
before persisting its updated twelve market/timeframe cursors and signal
snapshot. File and directory fsyncs enforce durable atomic file publishes.
After a crash between cursor and snapshot writes, the next flock-serialized
cycle replays the exact same snapshot and exits without additional public
provider requests. Corrupt, inconsistent, symlinked, old-release and
otherwise unsafe journals fail closed until operator reconciliation. This
does not promise exactly-once Bot API delivery or economic OOS validation.

Malformed or absent Yahoo candle responses may use the existing permitted
alternate public instrument symbol, rather than declaring a non-array
response a completed candle fetch. The quote path still accepts quote objects.
There are no additional requests for previously complete source pages or
any source-quality threshold exceptions. Neither the 2496 excluded KRX
product codes nor genuine Yahoo/Upbit candle gaps are claimed resolved.
No fabricated no-trade candles, backtest PASS, Telegram sends or orders.
 
## Draft: V3 Yahoo candle integrity and quota-preserving fallback

The standalone V3 Yahoo binding verifies every already-returned public candle's
strictly increasing timestamp, finite positive OHLC, consistent high/low
bounds and nonnegative volume before accepting the first candidate source.
An invalid first symbol can fall back to the existing approved Yahoo venue.
It never interpolates missing bars or bypasses session/data-quality gates.
Explicit paired HTTP 404/410/422/400 errors skip fruitless same-alias
retries; a 429 blocks the entire public provider attempt immediately rather
than spending quota on an alias. Mixed errors can still retry conservatively.
The scanner/public source is still not proven for the entire KR/US roster.
V3 journal cleanup now fsyncs its parent directory to prevent stale replay
of a completed checkpoint after a power loss.

V3 stock source-page integrity is scoped to the same recent 240/320/400
real Yahoo bars consumed by the current strategy, rather than rejecting
current evidence due to an unrelated historic out-of-window anomaly in a
10-year 1D series. Historical OOS requires separate independently validated
full-history datasets and is not inferred from these bounded current bars.

## Draft: cause-focused current-page and research evidence diagnostics

V3 reports an aggregate `blockerTriage` derived from the same 12 public
market/strategy lanes and canonical economic blockers, differentiating
provider failures, unsupported KRX roster codes, observed candle quality
gaps and missing verified Paper/OOS/full-cost inputs. Per-timeframe KRX
roster exclusions are deduplicated at market level. This adds no public
requests, instrument identifiers, raw candle samples, signal admission,
fake performance evidence, Telegram sends or execution authority.

## Draft: Preserve truthful Yahoo public-source failure evidence on blocked CI

The exact-head public provider runner now records bounded Yahoo-specific
terminal fetch categories (429, other 4xx, 5xx, timeout, empty source, malformed
response, unsupported timeframe or other) from already-attempted V3 stock
candles/quotes. No extra HTTP requests, raw exceptions, URLs, tickers, member
data or symbols are added to diagnostic artifacts. This can explain provider
failures that Stock Scanner previously counted without retaining reasons.

If the genuine public cycle fails its strict zero-provider-error KR gate,
the diagnostic artifact uploader still runs and captures available run/snapshot
files for offline review. **The CI job still FAILS and signals remain NO-GO.**
The deploy artifact uploader and exact-pass gates are NOT bypassed. This change
does not repair real Yahoo availability, full KRX instrument coverage, sparse
US/Upbit candles or absent independent OOS/full-cost evidence.

## Draft: closed Yahoo bar selection and exact malformed reason categories

The V3-only Yahoo stock public scanner now excludes only observed trailing
**forming** daily (before KR 15:30 KST or US 16:00 America/New_York)
and intraday bars (before the source interval has elapsed). It does not
manufacture candles or ignore malformed completed source bars. The remaining
closed candles must all pass the existing strict OHLCV and source quality gate.

The same actual first/alternate public source responses now emit bounded
structural source reason counts: timestamp format/duplicate/order/future,
invalid OHLC price/range or volume, empty/oversized/non-array source, and
clock errors. These include neither symbols nor candle values and never
grant a scanner/Telegram/Paper/profitability PASS. Any genuine malformed
completed daily bar remains a failed source-health check; detailed reasons
are preserved in the existing no-deploy failed-run diagnostics.

## Draft: exact candidate/publication lineage and cross-market safety

The new V3-only current-page publication proof rejects candidate rows whose
market, timeframe, strategy identity, source venue, original signal ID,
immutable research SHA, cost-policy identity, quant/risk status, positive
economic edge or verified-backtest *structure* does not match the exact
current source lane. It compares each published list copy with the canonical
snapshot row and every NEW_CANDIDATE event with that same canonical row.
A forged or reused row ID cannot gain an economic result or create an alert.
This is defence in depth **not independently authenticated OOS**.

The canonical adapter also rejects asset-class/venue misrouting
(Upbit Spot price as Bitget Futures or vice versa), action/side contradictions,
missing trustworthy data-quality receipts and unknown/non-A/S signal grades.
These restrictions apply only to the Signal V3 public Draft; shared member,
Paper and LIVE code are unchanged.

**Remaining real-data blockers** are separate: the KRX public-only Yahoo
source excludes 2,496 alphanumeric instruments; 15m/60m Yahoo stock series
contain unverified actual session gaps; sparse/no-trade Upbit 15m must
not be fabricated; and validated independent OOS/WF/full-cost receipts
do not yet exist for the retained research candidates.
KRX data-service agreements and third-party redistribution conditions
need separate authorized verification, not assuming a free private-use
key grants rights to a commercial member-facing service.
See https://openapi.krx.co.kr/contents/OPP/DATA/OPPDATA003.jsp and
https://openapi.krx.co.kr/contents/OPP/INFO/OPPINFO005.jsp .
