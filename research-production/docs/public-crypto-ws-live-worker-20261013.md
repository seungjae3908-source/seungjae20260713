# Actual public crypto WebSocket worker — guarded Draft (2026-10-13)

Canonical: [Hub #1102](https://github.com/seungjae3908-source/seungjae20260713/issues/1102) · [Research workroom #1775](https://github.com/seungjae3908-source/seungjae20260713/issues/1775).

## Implemented

- `bin/public-crypto-websocket-worker.mjs --execute` is a real outbound
  WebSocket worker using Node.js **>=22.4** native WHATWG WebSocket.
  All endpoints are fixed to Upbit Korean KRW spot candle.1m and Bitget
  Classic v2 USDT-FUTURES candle1m public market feeds. NO authenticated
  trading or account endpoints, private feeds, paper/real orders, REST GET,
  member delivery, DB, systemd changes, Telegram or Replit.
- Operator must explicitly set **four** gates:
  `RESEARCH_PUBLIC_WS_LIVE_ENABLED=true`,
  `RESEARCH_PUBLIC_WS_OPERATOR_APPROVED=true`,
  `RESEARCH_PUBLIC_WS_SOURCE_RIGHTS_CONFIRMED=true`,
  `RESEARCH_PUBLIC_WS_HOST_CAPACITY_CONFIRMED=true`.
  A protected private 0600 sealed roster manifest, an existing absolute 0700
  sidecar root and `RESEARCH_PUBLIC_WS_PRODUCER_SHA` matching the **actual
  checked-out git HEAD** are mandatory. `--dry-run` never opens a socket,
  accesses the filesystem or creates a worker.
- Upbit uses one `candle.1m` realtime subscription per group of <=40
  symbols; native WebSocket doesn't expose control-frame PING, so sends
  documented plain text `PING` and validates `{status:'UP'}` only when
  awaiting transport heartbeat. Bitget Classic v2 uses the exact
  `op:subscribe` + per-symbol ACK and lowercase text `ping/pong` protocol.
  A missing ACK/PONG expires through the existing 30s/15s supervisor gates.
  The worker does not classify quiet candles as an outage by itself.
- The actual event loop is serialized and bounded at 4096 pending events.
  Max frame size 256KiB, bounded native socket send buffer, per-socket
  5m in-memory coalescing, <=3 pending shards/socket. Each real packet is
  normalized with the existing strict 1m source/PIT guard. Only after
  >=5s beyond a closed 5m interval can the worker gzip+SHA-seal an
  immutable `PROVISIONAL_ONLY` sidecar with original update counts.
  Disk availability is read with `statfs` before every write (>=5GiB).
  An error or failed write HALTs, disconnects, preserves recovery debt,
  and NEVER silently promotes records into canonical REST source.
- A source-only private journal writes a SHA256-verified, fsynced
  0600 START receipt **before any public socket opens** and a separate
  STOP receipt only after graceful stop. On restart it reads all prior
  session START receipts and conservatively reconstructs REST audit
  proposals for every formerly subscribed symbol through the latest
  closed UTC minute. Any unobserved, crashed, or unflushed shard stays
  `sourceVerified=false`. No REST is called and no artificial no-trade
  candle is synthesized. Bounded retention (32 runs) fails closed for
  manual archive/REST disposition, not silently purged.
- `auditPlan({limit,startIndex})` yields source-only, max-16-at-once,
  bounded REST backfill proposals. The separate owner-approved REST
  source collector must independently perform actual requests/readback.
  No OOS/FullCost/Paper approval is produced.

## Approval-only on-host invocation (DO NOT RUN before protected release)

```sh
# Required on the explicitly approved, isolated Vultr research host:
# - Node >=22.4
# - Git checkout at exactly the approved commit
# - pre-existing private manifest and pre-existing 0700 sidecar root
# - free disk >5GiB, inode/RSS/socket counts and IP budget measured
# - operator-approved provider rights for actual usage/republication
# - single worker per source root, enforced by Linux flock
cd /approved/research-checkout
flock -n /approved/private-root/public-ws-worker.lock \
  node research-production/bin/public-crypto-websocket-worker.mjs --execute
```

The example contains deliberately nonfunctional placeholder directories.
Do not create or deploy these files by CI, and do NOT turn on the gates
as part of Draft validation. Keep operational `LIVE_TRADING=false`,
`AUTO_TRADING=false` and `executionAuthority=NONE` unchanged.
No GitHub workflow in this Draft activates the runtime or writes host env.
The production systemd unit must use its own isolated service account,
`flock`, private data root, and crash restart policy after separate
host validation. The worker itself is not yet installed.

## Remaining real-world release blockers

1. **Actual host evidence:** test 1, then 40, then the full permitted roster
   against venue per-IP connections/messages; monitor Node RSS/CPU, 24h
   disconnect/reconnect and 5m gzip page counts. Test SIGKILL/reboot
   recovery, disk-full, inode exhaustion, journal corruption, lock
   contention and stale roster with exact active commit.
2. **Data-rights and venue drift:** Upbit/Bitget public access is not proof
   of commercial redistribution rights. Bitget Classic v2 may migrate
   to UTA/v3; existing exact v2 subscriptions MUST NOT be silently
   rewritten or declared compatible without new protocol QA.
3. **REST actual finality:** only a future separately approved,
   rate-limited REST owner can verify immutable closed original
   1m candles and classify no-trade/gaps. No automatic OOS/Paper
   authority or provenance backdating.
4. **Four-market scope:** this worker covers only Upbit KRW spot and Bitget
   USDT perpetual futures. Licensed KR/US stock minute history/PIT,
   discontinued listings, FX, exchange calendars and corporate actions
   remain separate.
5. **Independent economics:** genuine historical availability, OOS/WF,
   full costs and Paper settlements are still NO_GO.

Docs: https://docs.upbit.com/kr/reference/websocket-candle ,
https://docs.upbit.com/kr/reference/websocket-guide ,
https://www.bitget.com/api-doc/classic/contract/websocket/public/Candlesticks-Channel ,
https://www.bitget.com/docs/uta/quick-start .

No Replit or Replit Agent. Draft source only. No merge, Staging, Production,
host deployment, real orders, private account calls or Telegram sends.

## Dormant isolated service definition (source only; not installed)

The source tree now includes `deploy/research-production-public-crypto-ws.service`.
This is a **static**, non-installed systemd unit with no `[Install]` target.
The existing core activation script does NOT add or enable it. It is not a
server change or proof of an active collector.

A separately reviewed operator must establish the private research-owned
`/var/lib/investment-research-production/public-ws` (0700) and immutable
`/etc/investment-research/research-public-ws-roster.json` (0600, readable
by `investment-research`) without using app-owned data directories. The
required root-managed configuration
`/etc/investment-research/research-public-ws.env` must be preexisting and
must attest the **four** independent public-source approvals and the exact
checked-out `RESEARCH_PUBLIC_WS_PRODUCER_SHA`. Presence of this text file
alone is not evidence that any approval, venue rights or host capacity exists.

The service uses a fixed roster and sidecar root, an exclusive Linux
`flock` owned by the research user, explicit NO-LIVE/NO-ORDER environment,
40% of one CPU, <=512 MiB cgroup RAM, a narrow read-write sidecar path and
strict filesystem/kernel sandboxing. A deliberate worker exit 2
(`HALTED_MANUAL_REVIEW`) or lock-contention code 75 must NOT automatically
restart; abnormal crashes have a three-attempt, ten-minute restart ceiling.
All provisional 1m observations still require independent REST finality,
historical PIT, genuine KR/US data licensing and postdeployment 24-hour
recovery/quotas before being used for OOS, Full Cost or Paper evidence.

The unit file and parser/approval-boundary tests are committed **only to
a Draft source branch** initially. No server file is installed, no service
is started/enabled, no environment/roster is populated, no WebSocket opens
and no provider/network quota has been measured by this code-only change.
No Replit or Replit Agent is used.
