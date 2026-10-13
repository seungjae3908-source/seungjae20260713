# Create-only isolated Telegram package (not activation)

The running Production API currently embeds four Telegram send-capable lanes.
Its deployed source predates `TELEGRAM_WORKER_OWNER=isolated`. A separate worker
must **never** start while that old embedded worker may still send: this would
risk duplicate messages and could disrupt manually active trading if PM2 is
restarted indiscriminately.

The source-only QA creates a *dormant* candidate with exactly three items:

- `api-server/dist/telegram-isolated-worker.mjs` — standalone bundled worker
- `ops/telegram-legacy-owner-runtime-proof.mjs` — actual old-owner health verifier
- `ops/run-telegram-isolated-worker.sh` — owner/lease/financial safety launcher

It also writes `.deploy/telegram-sha256.manifest`, an exact SHA marker **last**,
and a non-authorizing preparation receipt. The destination must be new and
outside the checkout and `/opt/stock-app`. All files are verified as ordinary
single-link files, and paths/digests are checked. A mismatch leaves no valid
start marker. Runner build tests launch the bundle with *no node_modules* and
no approval, expecting the exact fail-closed exit 14, before packaging.

The PR/push workflow only prepares a GitHub Actions artifact. It has read-only
contents permission and **does not use Production secrets, access the server,
install any unit, deploy or restart PM2, send Bot messages, or modify trading**.
Artifact success proves packaging only, not runtime readiness, delivery,
rollout, safe human cutover, or real profitability.

A separately reviewed, protected install/handoff is still required. It must:

1. Verify an immutable approved SHA, the artifact's origin and digest, the
   existing production SHA, and which application workers actually run.
2. Install the sealed package in an isolated release root without touching
   `/opt/stock-app` or existing real/Paper orders or their permission flags.
3. Prove the old four sender lanes are stopped and in-flight sends drained,
   **twice** from the actual PM2/health process, preserving durable ledgers.
4. Hold the deployment and sender-owner leases correctly across atomic handoff,
   prevent a second sender, verify recovery, and stop on any ambiguous outcome.
5. Require separate human protected-environment approval for any live runtime
   change. Never disable manually active Spot/Futures execution just to turn a
   Telegram deployment gate green.

Real 6-room Bot acceptance, owned personal `SENT`, Signal V3 genuine fresh
12-lane data, trade→journal→notification, and anti-duplicate proof are separate
observable gates. The package alone satisfies **none** of them.

Replit and Replit Agent are prohibited.
