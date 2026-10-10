# Vultr 2 vCPU / 4 GiB: lightweight opportunity watch (Draft)

This **additive, not activated** Research Production worker continuously observes public
crypto ticker snapshots and optional **externally verified public** stock snapshots.
It is NOT a live strategy engine, trained ML system, full order-flow collector, OOS
verdict, real Paper fill, or brokerage order channel. No Replit, private provider
keys, account balances, orders, transfers, withdrawals, or trading privileges.

## Why split it from the hourly Forward timer?

The existing `research-production@forward.service` runs once per hour.
The new `research-production-market-watch.service` is an independent always-on
Node process, with a **120-second baseline interval**, bounded public HTTP
calls, a **40% one-core CPU quota** and **512 MiB cgroup memory ceiling**.
On host memory/disk/CPU pressure it skips collection rather than taking
resources needed by the running investment app. `Restart=on-failure` is
part of the service *definition only*. Neither this PR nor existing server
installation scripts enable or start it.

The continuous scanner is **stage 1 discovery only**:
- Upbit: all eligible KRW markets advertised by the public market/ticker APIs.
- Bitget: public USDT-futures ticker aggregate (not proof of historical delistings).
- KR/US stocks: strictly optional, fresh public snapshot files under the research
  state root. When not connected, each stock market is explicitly `BLOCKED`.
- Watch: two consecutive fresh snapshots from the **same source**, >=0.7% price movement,
  liquid 24-hour turnover floor, 15-minute symbol/direction cooldown and
  at most 12 new research observations per market and cycle.
- No inferred RVOL, pressure, CVD, OI, real-time full L2, profit, learned
  model PASS, future signal, approved trading strategy, Paper or Live authority.
  Downward spot/stock movements are *observations*, never SHORT instructions.
- A missing/stale source is a visible gap; zero activity is not claimed as success.
- A subset of usable Bitget tickers is explicitly PARTIAL_TICKERS, not READY.
- Public HTTP JSON is streamed with a 4 MB decompressed payload ceiling.
- The observation time is measured after each collection cycle, not before HTTP requests.
- Daily cycle/discovery counters are **diagnostic only**, not 24-hour uptime proof.
- The systemd unit has a 3-restart/10-minute safety limit for repeated fatal errors.

## Optional public stock feed input (not connected yet)

Write atomically to:
`/var/lib/investment-research-production/market-watch-input/KR_STOCK.json`
or `US_STOCK.json`. The directory/file must be owned by the research
service, regular (not symlink), not group/world writable, with exactly one
hard link. Example (the numbers are **illustrative**, not actual quotes):

```json
{
  "schemaVersion": "research-stock-public-snapshot-v1",
  "market": "KR_STOCK",
  "source": "verified-public-feed",
  "asOf": "2026-10-09T04:00:00Z",
  "completeUniverse": false,
  "quotes": [
    {
      "symbol": "005930",
      "price": 82000,
      "turnover24h": 2000000000,
      "change24hPercent": 2.5,
      "asOf": "2026-10-09T03:59:58Z"
    }
  ]
}
```

`completeUniverse=true` may only be set when the real provider feed supplies
a verifiable, complete current eligible universe. Historical PIT universe,
corporate actions, pre/post-market coverage, subscribed real-time market
data and all-market streaming remain **unproven**. No fabricated feed is written
by this implementation.

## Data and diagnostics

- Latest read-only status:
  `/var/lib/investment-research-production/latest/lightweight-market-watch.json`
- Exact-SHA observation baseline and cooldown:
  `/var/lib/investment-research-production/watch/state-v1.json`
- Dated append-only research observations:
  `/var/lib/investment-research-production/watch/events/YYYY-MM-DD.jsonl`

Stock feeds must carry a quote-specific fresh `quotes[].asOf` timestamp, not
just an outer file creation timestamp. Two distinct stock data providers are
never compared for a synthetic price acceleration. The event log is
**at-least-once**: a crash after append and before cursor persistence can
replay an observation, so consumers must deduplicate by stable `eventId`
(binds source and quote timestamps). No autonomous Paper admission is granted.
An explicit raw-event retention/archive policy is needed before using this
as an enduring economic sample dataset.

Stored observations are untrusted research *discovery* samples. They do not
participate in the authoritative Formula PASS, TRAIN/Validation/OOS/Full Cost,
Paper, Journal or Telegram closed loop. An authenticated Research Center UI
readback is a separate review/implementation step (avoid copying raw files or
creating an unauthenticated output route).

## Prospective price-movement study — new Draft addition (NOT profitability)

After a provisional 2-minute public ticker detection, the same bounded worker
tracks real, independently timestamped **future public ticker snapshots** for
a 20-minute target. It records sampled favorable/adverse price excursions,
number of future observations, actual elapsed time, and explicit missing-data
blockers. This is **not** a candle-high/low, trade fill, executable entry,
market-neutral return, take-profit/stop-loss execution, net PnL, full-cost
result, OOS/walk-forward PASS, or proof of monthly 20%-100% performance.

- The first snapshot creates a **pending research observation only**.
- Following quotes must come from the **same market and public data source**,
  with strictly newer timestamps; no after-horizon price is counted.
- At least four future snapshots and a final quote within the last three
  minutes of the 20-minute target are required, with no sampled gap >6 min.
  If missing or the source changes, outcome is `BLOCKED_DATA` with no economic credit.
- Success is explicitly called `OBSERVED_COARSE` (not `PASS`/`SETTLED`); a
  DOWN observation in stocks or spot never implies permission for SHORT.
- Active future studies are limited to **1,024** per instance; excess discovery
  observations are counted as untracked, **never counted as successful**.
- Outcomes are appended to `watch/outcomes/YYYY-MM-DD.jsonl` with a
  deterministic `outcomeId`. Storage semantics are **at-least-once**, so any later
  research consumer MUST deduplicate by outcomeId across crash/restart.
- The existing read-only Research Center continues to show only market feed
  status and provisional discoveries; pending/complete ticker studies do not
  implicitly qualify a FormulaCandidate, AI review, Paper order or trading signal.
  This Draft does not create any queue consumer, change existing signal gates,
  or activate the systemd worker.

## Safe preflight and required follow-on steps

1. Confirm `nproc=2`, MemAvailable, disk floor >=5 GiB, swap activity,
   PM2/API p95, and CPU load under a real app workload.
2. Verify dedicated `investment-research` user, fixed Research release SHA,
   cgroup v2 CPU/memory controls, private state root and egress to public APIs.
3. Run `cd research-production && npm test` and
   `systemd-analyze verify research-production/deploy/research-production-market-watch.service`
   against the *exact* PR head.
4. Obtain separate production activation approval. Only then install, enable
   or start the service. Do not change the app or existing Research
   service/timers in this Draft.
5. Verify real 24-hour sample cadence, rate-limit handling, memory spikes,
   server restart, no duplicate observations, and app responsiveness.
6. Attach a licensed/verified KR/US market feed and then build a bounded
   RVOL/pressure/ORB/order-flow fine-screen and a separately gated
   FormulaCandidate producer. Never transform these provisional observations
   into automatic Paper/Live orders.

GitHub Actions stays for CI, expensive historical tests and release approvals.
Do not simultaneously run duplicate scheduled research publishers.


## Fail-closed local readback (no watch activation)

With the exact, separately approved Research Production checkout installed, the
local read-only status CLI can inspect the last saved observation. It does **not**
start the market watch, query trading providers, place orders, or mutate the DB:

```bash
sudo -u investment-research env \
  RESEARCH_STATE_ROOT=/var/lib/investment-research-production \
  RESEARCH_CODE_SHA=<EXACT_DEPLOYED_40_CHAR_SHA> \
  node /opt/investment-research/current/research-production/bin/lightweight-market-watch-status.mjs
```


The diagnostic reads only
`latest/lightweight-market-watch.json` (≤64 KiB, no symlink, no
group/world writes), validates source identity, time freshness, all four market
statuses, counts and explicit no-order/no-Paper authority. It returns only
sanitized status/counts; no raw symbols, API response, private account,
secret, filesystem path or provider credentials.

Outcomes: `MISSING` (no saved record), `INVALID` (bad identity,
unsafe file or forged safety), `STALE` (>6 minutes old),
`PARTIAL` (only some markets ready), `OBSERVING` (four fresh data feeds),
`THROTTLED` / `HOLD` (server resource protection). None indicates
24-hour uptime, TRAIN/Validation/OOS/Full Cost, successful Paper execution or
proven profitability. Stocks remain explicitly unavailable without an
independent authenticated/verified public market-data producer.

Because Research Center is an authenticated admin UI, adding this readback
to the app must separately route through its canonical loopback Research
Dashboard and the existing admin sanitizer. This PR only prepares the
**local** safe readback; it does not expose a new unauthenticated public HTTP
endpoint or edit member authorization.


## Read-only UTC daily sample cohort diagnostic (Draft, not scheduled)

A discovery JSONL file is **at-least-once** and may contain the same
`eventId` multiple times after a crash. Prospective outcome JSONL may repeat
`outcomeId`. Treating each log row as a new success would inflate sample size.

The read-only diagnostic below scans **one UTC event day** and that UTC day
plus the following day of outcome records, performs independent identity
checks and deduplicates stable event/outcome IDs:

```bash
sudo -u investment-research env \
  RESEARCH_STATE_ROOT=/var/lib/investment-research-production \
  RESEARCH_CODE_SHA=<EXACT_RESEARCH_RELEASE_SHA> \
  node /opt/investment-research/current/research-production/bin/lightweight-market-watch-cohort.mjs --day=2026-10-09
```

- **No write, scheduler, API request or activation.** Missing/invalid/unsafe
  files fail closed. Input JSONL is read sequentially, with 64 MiB/file,
  16 KiB/line, 45,000 lines/file and regular non-link file safety limits.
- For same-day release changes, discovery entries from a different valid
  Research SHA are kept out of the selected release's cohort. Outcome records
  without a matching selected discovery are never counted as successes.
- The output distinguishes unique discoveries, duplicate rows,
  `OBSERVED_COARSE` ticker observations, `BLOCKED_DATA`, and missing
  future outcomes. If a file is torn, tampered or changed during read, the
  report is `INVALID`, and the validated cohort counts are **null**.
- Outputs are aggregate only. Raw ticker symbols, prices, provider credentials,
  account data and paths are never projected. `economicEvidenceCredit`,
  `oosCredit`, `paperCredit` are always zero and no study result becomes
  a strategy approval or execution command.
- This is **not a retention/archival implementation**: logs remain on the
  dedicated research state root, disk protections still apply, and a
  separately approved retention/archive procedure is needed for long-term
  unattended operation. It is also not proof of 24-hour service uptime.
- The Research Center still displays live status plus preliminary counters.
  This local cohort diagnostic is not silently promoted to Formula PASS,
  AI/OOS evidence or browser-admin economics. No Paper/Journal/Telegram
  consumer has been added by this Draft.


## Bounded durable local writes (Draft — worker remains OFF)

The watch writer now enforces **64 MiB per UTC day and log category** for
`watch/events` and `watch/outcomes`, with a 2 MiB append cap, a 16 KiB
JSONL-row cap and a maximum of 1,024 rows per append. The existing UTC daily
cohort reader uses the same daily file and per-line limits. Unsafe symbolic
links, hard links, permissive file modes and oversized logs fail closed rather
than silently growing until the Vultr app disk is exhausted.

Event/outcome append data and the containing directory are synced before
advancing the watcher cursor. State/status JSON is written to an isolated
0600 temporary file, synced, atomically renamed and its parent directory
synced. This narrows a crash/power-loss window but **does not claim that the
underlying disk or provider is infallible**. A crash before cursor publication
can still replay an event; all consumers must deduplicate `eventId` or
`outcomeId`. Interrupted/truncated JSONL remains INVALID to the cohort
diagnostic and requires an independently approved repair/archive workflow.

These are safety caps, **not retention**: this Draft intentionally does not
delete, rotate, compress, upload or archive old samples, and does not write
to the app's DB. An audited backup/retention plan and real server 24-hour
disk/CPU/RAM monitoring are still required before unattended operation. If
a cap is hit, the watcher stops safely rather than discarding evidence to
continue producing green status. Research status is not a trading gate.


## 24-hour cadence witness: read-only local audit (Draft, NOT runtime proof)

This Draft adds one small **watch/cadence/YYYY-MM-DD.jsonl** record after each
successfully persisted market-watch cycle. Each entry contains only the
pinned Research SHA, the cycle timestamp, resource protection state and four
market status/count aggregates. It does not persist raw tickers, credentials,
account IDs, trading directives or artificial earnings. It uses the same
bounded, fsynced JSONL protection as events/outcomes. Daily source files are
**not** automatically deleted or archived.

The separate local CLI inspects only the previous/current UTC day, requiring
private regular files, a 2 MiB/day read ceiling, at most 2,000 rows/day,
consistent release identity, unique cycle times, and a trailing newline:

~~~bash
sudo -u investment-research env \
  RESEARCH_STATE_ROOT=/var/lib/investment-research-production \
  RESEARCH_CODE_SHA=<EXACT_INSTALLED_RESEARCH_SHA> \
  node /opt/investment-research/current/research-production/bin/lightweight-market-watch-cadence-status.mjs
~~~

A rolling window is diagnostically **PUBLIC_CADENCE_OBSERVED** only when there
are at least **600 valid distinct cycles in 24 hours**, first and latest
snapshots are within **6 minutes** of the window boundaries, no gap exceeds
6 minutes, and the host has zero HOLD or THROTTLED cycles. It reports
coverage gaps separately: partial/absent KR/US public sources cannot become
full-market readiness. The clock-window threshold is not a guaranteed 2-minute
SLA; the worker can adapt cadence to server pressure.

**Critical safety boundary:** cadenceWindowObserved means a locally
persisted *self-reported* cadence trace met simple thresholds. This is
**not independently verified uptime**. Both continuous24hProven and
completeFourMarketCoverageProven remain false even when the trace passes.
A real 24h rollout additionally needs approved service activation,
systemd/host logs, externally observed app latency and resource readings,
an independently attested release SHA, and licensed/fresh KR/US data.
This worker is still OFF in this Draft. Nothing enters the Formula PASS,
OOS, fee-adjusted returns, Paper, Journal, Telegram or Live authority chain.


## Read-only capacity census CLI (Draft, no runtime mutation)

The capacity projection now has a separate server-local **metadata-only**
file census. It DOES NOT start the market-watch worker, call provider APIs,
connect to the app DB, read event bodies, remove old files, modify backup
policy or place Paper/Live orders. This works only after installing a separately
approved Research checkout containing these tools:

~~~bash
sudo -u investment-research env \
  RESEARCH_STATE_ROOT=/var/lib/investment-research-production \
  RESEARCH_CODE_SHA=<EXACT_APPROVED_INSTALLED_RESEARCH_SHA> \
  node /opt/investment-research/current/research-production/bin/lightweight-market-watch-capacity-status.mjs
~~~

- Only fixed directories **watch/events**, **watch/outcomes**, **watch/cadence**
  are inspected. Each filename must be exactly YYYY-MM-DD.jsonl.
  Only file metadata is read; no raw ticker, event or account contents.
  Non-regular files, symlinks, hardlinks, unsafe permissions, malformed/future
  dates, oversized files or more than 366 entries per category fail closed.
- An unsafe path returns INVALID with a fixed error code, rather than
  exposing paths or provider exceptions. A missing category is explicitly
  reported; an empty watch means insufficient history. Nothing is created.
- Disk space comes from the actual local filesystem statfs, not assumed
  Vultr specifications. The forecast reserves **5 GiB** for the host,
  using mean bytes from seven **consecutive** completed UTC dates
  (excludes today). Each date must also have a private bounded cadence log:
  discovery/outcome files alone are not proof that the watch kept running.
  Any missing cadence/date keeps INSUFFICIENT_HISTORY and a null forecast,
  never an optimistic zero-byte day. Cadence file *presence* itself does not
  attest hourly uptime or complete market-source coverage.
  Exactly 5 GiB free is also HOLD, since no app disk margin remains.
  Runway is approximate, not an uptime or retention SLA.
- A report of OBSERVATION_ONLY is **NOT** permission to run indefinitely.
  Retention applied, archive verified, deletion allowed, continuous 24-hour
  proof, profitability proof all stay false; execution authority remains NONE.
  No archive/backup destination is configured.
- File-count and one-year window caps intentionally fail closed when more
  unarchived files accumulate. A separately approved and verified retention
  policy is required before long-running activation. The configured SHA is
  a diagnostic label, **not** an attested installed release identity.

This Draft is only CI-tested with fixtures. No real Vultr capacity census
has been performed, and the market-watch service remains OFF.
