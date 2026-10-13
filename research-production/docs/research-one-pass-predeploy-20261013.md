# Single-pass Research Center Drift and activation readiness — 2026-10-13

## Immutable integration sources
- Latest observed main: `eacf9173fdc42d0e88aa3930a8e66d26cb3b024c`
- Research collector / 1m immutable REST-WS / bounded AI TRAIN: #1867 `a343a08c34ea1f2ba6802ae46d8f951e1a8959cc` (62 exact blobs)
- PIT 4-market coverage API and UI: #1832 `66a12f115f720d5b83495773e39f593efa1055e3`
- Native 1m replay and Backtester: #1848 `c588e843d64d23af766884a2dc98ffac369f67df`
- #1832 plus #1848 import exactly 50 path blobs (zero overlap with #1867).
- Production/LIVE code retains its original `eacf9173fdc42d0e88aa3930a8e66d26cb3b024c` exact blob SHA.
- Separate #1756 natural observer scope is protected by Paper Forward; NOT merged here.

## One-pass work order
1. Source identity / dependency / safety / current main Drift audit (including pin checks).
2. Research-specific Node/API/RLS/4-market original candle, WebSocket, AI,
   OOS/cost and PC-mobile research browser QA; resolve FIRST_ZERO in batch.
3. On final frozen source only: same-head Full CI 26/26 and Required 6/6.
4. Production-protected Research-only Staging; authenticated browser and
   genuine provider/network and storage readback QA. No skipped stage as PASS.
5. Separate approved Production install and exact-SHA on-host audit.
6. Real 24h continuous WS/REST finality, kill/restart recovery, licensed KR/US
   original PIT/delisted stock history, signed TRAIN/OOS/WF/FX/full-cost
   actual Paper settlement. Block profitability admission without evidence.
7. LIVE automatic real orders are a separate 26-control production gate and
   NEVER implied by the Research Staging/Production code release.

## Remaining external blockers, cannot be faked by a green CI
- Licensed Korean / US minute data and historical delistings/PIT;
- Shared IP per-venue quotas / 429, host CPU, disk/inodes, 5 GiB reserve,
  backups/recovery and actual 24h archive readback;
- 760 example-symbol REST 120m throughput (16 per 5m < 38 modeled need);
  required parallel/REST audits need live budget before increasing concurrency;
- Proven scanner-as-of provenance, independent OOS/WF, all execution costs,
  Research SHA ↔ genuine Paper ledger match and first settled positions;
- Current protected Staging, Production installed SHA, and human approvals.

## Authority
This is **Draft CODE integration only**, not activation, user approval to
make real orders or proof of profitability. Fail closed on any unknown.
No Replit/Replit Agent, no DB/Secret/PM2/systemd/cron changes,
no provider private API, no Telegram actual send or financial mutations.
