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
