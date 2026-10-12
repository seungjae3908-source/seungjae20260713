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
   => 19 proposed public sockets. This is **NOT a vendor limit attestation**,
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
