# Public crypto 1m WebSocket pilot — Draft only (2026-10-13)

Repository: seungjae3908-source/seungjae20260713
Owner: #1859 (source); mirror identical blobs into #1867 (Research integration).
Hub #1102 · Workroom #1775 · Release Control #1555.

## Cost & source licensing

- Upbit public `wss://api.upbit.com/websocket/v1` provides `candle.1m` without private-account authentication.
  Source: https://docs.upbit.com/kr/reference/websocket-candle
- Bitget classic public `wss://ws.bitget.com/v2/ws/public` supports
  `{instType:"USDT-FUTURES",channel:"candle1m",instId:"BTCUSDT"}`
  without private trading credentials.
  Sources: https://www.bitget.com/api-doc/classic/contract/websocket/public/Candlesticks-Channel
  https://www.bitget.com/docs/classic/rest-api
- Public API access does not itself prove permission for commercial republishing,
  retransmission to members, permanent storage, derived signals, or use by
  automated investment services. Venue-specific data rights require review.
- Binance Vision historical archives are **NOT** an unrestricted live/paid-app
  shortcut: its 2026-08-26 dataset terms provide free access under a
  non-commercial license and require separate written commercial permission.
  Source: https://github.com/binance/binance-public-data/blob/master/TERMS_AND_CONDITIONS.md
- Broker feeds / Alpaca Basic are separate markets, not a substitute for
  full licensed US SIP or KR minute historical/delisted data.
  Source: https://docs.alpaca.markets/us/v1.1/docs/about-market-data-api

## Changes (offline / no connection)

1. New `public-crypto-websocket-minute-v1.mjs` verifies the existing sealed,
   current Upbit/Bitget rosters, rejects >15min stale membership, and computes
   bounded 40-symbol-per-socket, max 32 socket plans. Example 760 symbols
   => 20 proposed public sockets (8 Upbit, 12 Bitget). This is **NOT a vendor limit attestation**,
   or a claim the host can handle the actual message rate. Restricted roster
   members remain research-visible but cannot get trading authorization.
2. Upbit uses the true UTC candle start
   `candle_date_time_utc` (never last-trade `timestamp`) and accepts genuine
   `REALTIME` only. Bitget accepts `action:update`, `USDT-FUTURES`,
   `candle1m` and start timestamp from row 0; both ignore snapshots.
   No private WS endpoint, API key, order, or real provider connection.
3. Each incoming update remains **provisional**. Same-minute newer events
   must preserve the open, cumulative high/low and nondecreasing volume.
   Duplicate source timestamps cannot revise values without blocking.
   Rollover and unobserved minute slots require independent REST review;
   no fabricated zero-volume candles, no backdated `availableAtMs`.
4. Reconciliation with a later closed REST minute must match exact OHLCV,
   but does not automatically create a canonical original source page or
   OOS/Profitability/Paper credit. The already protected 120/180m REST
   archive writer remains the only potential canonical path subject to
   separately reviewed source rights and source receipts.
5. Safe local CLI (default `--dry-run`) accepts only a pre-existing private
   0600 JSON containing exact `upbit`/`bitget` sealed roster snapshots,
   and requires `RESEARCH_PUBLIC_WS_PLAN_ENABLED=true` for `--plan`.
   It prints counts/gate statuses only, never raw symbols, prices, credentials,
   connection tokens, URLs or subscription frames. **No actual WS runner**,
   no systemd timer and no production service is installed.

## Subsequent release blockers

- Host CPU/RAM, inbound WebSocket bandwidth, many channels/IP and reconnect
  policies; Upbit connect/message limits; Bitget recommended <50 subscriptions
  per connection, ping/pong, 429 and limits.
- Durable standalone WebSocket WAL/sidecar with immutable revisions and
  readback, interrupted-minute gap recovery, host restart replay, collector
  HA and 24h evidence, no authority to replace REST historic source lineage.
- Independent provider-closed 1m verification before native backtester;
  historical whole-universe PIT including delistings; stock market sessions;
  legal storage and commercial rights.
- Immutable TRAIN/OOS/Walk-Forward/FullCost and genuine Paper Settlement.
  Success in fixture tests DOES NOT satisfy live data availability or ROI.

Hard stop: Replit/Replit Agent prohibited. Draft only, no Ready/Merge,
Staging/Production, VPS/systemd/PM2/DB/Secrets changes, provider GET/WS traffic,
Paper or LIVE order, Telegram send, or profitability promotion.

## Draft v2 — transport supervisor and isolated compressed source-only sidecar

**Implementation:** `src/public-crypto-ws-supervisor-v1.mjs`,
`src/public-crypto-ws-sidecar-v1.mjs`; both are OFFLINE source-contract
components, with no real WebSocket constructor, network request, runtime
timer, worker installation or database access. The existing CLI now supports
an opt-in `--simulate` command using the same pre-existing private 0600
sealed roster manifest as `--plan`. Both print *counts only*; no raw bars,
source subscription payloads, secrets, portfolio data or private endpoints.

### Connection lifecycle, fail-closed

- A deterministic supervisor validates the actual current-roster plan
  (only `wss://api.upbit.com/websocket/v1` and
  `wss://ws.bitget.com/v2/ws/public`), rejects duplicate symbols,
  private endpoints, tampered symbols and invalid subscriptions.
- It proposes at most **one new connection per second globally**
  and times out handshake after 30 seconds, with 5-second
  exponential reconnect delays capped at 5 minutes and a manual
  review hold after repeated unsuccessful attempts. All actions are
  **intents** and include `neverExecuted:true`. No network is opened.
- `OPEN` requires an explicit subscription transmission receipt.
  Upbit has no guaranteed per-symbol ACK. Bitget remains in
  `AWAIT_ACK` until every expected channel subscription is
  acknowledged. Unsolicited/stale ACKs are refused.
- Upbit sends a WebSocket protocol Ping **frame** every 30 seconds
  in the dry simulation; Bitget uses the literal text message
  `ping` and requires a literal `pong`. Missing response for
  over 15 seconds requests a close/retry intent. **No candle activity
  does not indicate a dead connection**: a symbol may have no trades,
  and only independent transport heartbeat establishes liveness.
  No silent period becomes a fictitious zero-volume candle.
- Bitget candle updates may contain multiple one-minute rows. The
  bounded packet normalizer sorts and validates up to 32 rows,
  rejects duplicate minute indices and oversized packets (including
  in-memory object frames and binary websocket payloads), and feeds
  every row to the same provisional source/gap validator.
- A genuine rollover or connection loss adds a **bounded REST
  audit proposal** with market/symbol/window and
  `sourceVerified=false`. It is NEVER automatically treated as
  verified no-trade, a genuine OOS event or authority to submit a
  real/Paper order. Pending audits are bounded to 2,048 and cause a
  fail-closed state if that capacity is exceeded.

### Private provisional batches — NOT final market history

- Up to 2,048 WebSocket *updates* may be compacted into no more than
  480 distinct minute/symbol observations in a 5-minute shard batch.
  Same-minute older events, cumulative high/low regression, volume
  regressions, OHLC inconsistency, source-id swaps and unapproved
  accounts are rejected before persistence.
- A private, operator-approved **existing** 0700 root is required.
  Sidecar files are gzip-compressed, SHA256-sealed, written via
  create-exclusive temporary file, fsync, hard-link publication,
  and exact private readback. An already existing identical batch is
  reused; a revision conflict is blocked rather than overwritten.
  A 5 GiB free-space requirement is modeled, not attested on Vultr.
  Symlinks, world-readable files, unsafe folders and decompression
  bombs fail closed.
- Files are **research-only provisional sidecars**, not the
  existing 120m/180m immutable REST original source archive. They
  cannot generate OOS/Full Cost/Paper profitability credit.
  REST close/finality check, provider rights, signal-time evidence,
  host resource validation and approved native backtester admission
  are separate missing requirements. Tests use disposable local
  0700 fixture roots only; no production host writes.

### Official heartbeat references

- Upbit public WebSocket connections can idle-timeout after about
  120 seconds; official guide supports PING/PONG frames.
  https://docs.upbit.com/kr/reference/websocket-guide
- Bitget Classic WebSocket public guide recommends sending text
  `ping` every 30 seconds and checking literal `pong`, and
  suggests fewer than 50 channels per connection.
  https://www.bitget.com/docs/classic/websocket/intro

**Hard stop remains:** NO Replit, Ready/Merge, Staging/Production, PM2,
systemd, cron, live WebSocket/REST provider traffic, DB/Secret/permissions,
private broker calls, member re-publication, Paper/LIVE orders, withdrawals
or Telegram sends. All tests synthetic/offline. `executionAuthority=NONE`.
