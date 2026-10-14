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


## Immutable support-source proof (follow-up)

A checkout whose HEAD matches the approved SHA is not, by itself, proof that
its working-tree launcher or quiescence verifier still matches that commit.
Preparation now compares each tracked `ops/run-telegram-isolated-worker.sh`
and `ops/telegram-legacy-owner-runtime-proof.mjs` blob against the exact
`HEAD:path` Git object before writing any output, and requires the actual
Git root to equal the supplied checkout directory. A generated standalone
bundle remains untracked by design but is compiled and startup-checked by the
pinned offline CI job. Any tampered support script fails closed before a
release directory is created. An exception after writing the last marker also
removes that marker and quarantines the incomplete release, never marking an
incomplete release ready. None of these checks installs or starts a service.


## Follow-up: inert create-only installation contract

The new \`ops/install-telegram-isolated-dormant-package.mjs\` materializes
a **non-running** candidate under
\`/opt/stock-app-data/telegram-isolated-v1/release/current\` (CLI target fixed).
It verifies the exact SHA marker, all three manifest digests, preparation
receipt, regular-file/anti-symlink/anti-hardlink properties, and uses an
exclusive directory creation with the final SHA marker written **last**.
An incomplete release is quarantined rather than automatically retried.
Offline regression tests use disposable local directories only.

This is source code and local CI verification, **not an executed Production
installation**. A local SHA+manifest does not authenticate artifact origin:
a future owner-approved protected workflow must verify the exact GitHub
Actions run, its successful immutable current-main provenance, and artifact
digest before copying anything to a server. This PR neither installs a unit
nor starts a process, restarts PM2, sends Bot messages, changes broker flags,
or modifies LIVE/Paper/DB/credential state.

No migration of the old embedded sender is possible merely by preparing or
installing a dormant bundle. The existing running app lacks the ownership
switch. A separately reviewed LIVE-preserving rollout and two independent
same-process quiescence proofs must come **before any isolated worker start**.


## Owner-protected dormant installation path (source-only, never a cutover)

A *separate*, strictly scoped, owner-protected workflow now exists at
`.github/workflows/telegram-isolated-protected-install.yml`. It is inert
until **merged into the exact current main** and invoked from Release Control
#1555 by the repository owner with an exact-main 40-byte SHA. A protected
Production environment review is an additional requirement; no comment
or approval has been issued by this Draft work.

Before any server mutation, the workflow checks current-main, successful
Required6/6 Full CI, post-merge provenance and exactly one **original**
successful current-main `push` run of the dormant package workflow.
A PR artifact, stale SHA, failed/retried run, expired/doubled artifact,
missing `sha256:` digest or untrusted repository is denied. It fetches the
original ZIP, verifies the GitHub-reported SHA256, and extracts only the six
allowlisted files with size, symlink, duplicate, manifest, SHA and inert-receipt
checks. A new immutable tar digest is checked again on the host.

The protected host operation holds the shared deployment lock and exclusive
Telegram owner lock, validates PM2 online/marker, copies only to the separate
`/opt/stock-app-data/telegram-isolated-v1/release/current` directory, and
requires an unchanged PM2 deployment/flags fingerprint before and after.
It never restarts PM2, changes trading/Paper state, starts a Telegram process,
sends a Bot POST, accesses a broker order route or alters a DB/secret.
Ambiguous provenance or partial installation fails closed.

**THIS DOES NOT ACTIVATE TELEGRAM.** Even if dormant installation later
succeeds, Production still contains legacy embedded senders. A separate
owner-reviewed live-trading-preserving application rollout and two-pass
actual legacy sender quiescence proof are needed before the standalone worker
can be started. No Replit / Replit Agent is used.


## Exact host-transfer authenticity hardening (follow-up)

The protected installer now verifies the latest main and exact tracked Git
blobs **again after SCP and directly before installing**. Its runner-side
guard executes over the authenticated SSH input stream rather than by running
an uploaded shell script from the host's writable ingress directory. The
host-side JavaScript installer is checked against the exact checkout's
SHA256 before execution. Any mismatch blocks installation. The post-merge
success context is also tied to the genuine exact-SHA post-merge GitHub
Actions workflow run, not a context name alone.

These are controls for a dormant, *not running* artifact. They do not prove
that the old embedded Telegram workers have stopped, that live trading can
tolerate a shared API restart, or that Telegram Bot POST and personal
notifications are accepted. None of those actions are authorized here.


## Full real-shell offline installation rehearsal

The protected install contract now runs the actual
`ops/telegram-protected-dormant-install.sh` through a hermetic local
simulation instead of relying only on source-string assertions.
`telegram-protected-dormant-install-e2e.test.mjs` creates a disposable
Git checkout, seals a real six-file package with the packager, creates
a tarball, rewrites absolute paths **only in isolated test copies**, and
runs the protected Bash installer with a deliberately fake PM2 command.
The fake PM2 declares manual LIVE flags *true* and an embedded sender;
installation must leave those flags and the existing app SHA unchanged.
It tests the actual Node create-only installer, archive checks, locks,
receipt, and duplicate target handling; rejects tampered installer bytes,
wrong tar checksum, missing approval and PM2 SHA/status mismatch.

This rehearsal never connects to the Production host, never calls a
real PM2, never sends to Telegram, never uses DB credentials, and never
executes broker operations. Its success is **not** proof that running
Production's old embedded sender can be quiesced or that live trading
can be restarted safely. That requires separate protected operational
proof and explicit owner approval.


## Production four-lane cutover audit — honest read-only NO-GO observation

`ops/telegram-cutover-readonly.mjs` plus the strictly owner-protected
`.github/workflows/telegram-cutover-readonly.yml` add a new, **non-activating**
preflight that intentionally accepts an older deployed Production SHA for
diagnosis. It uses the *actual* single `stock-app` PM2 instance, deployed
SHA marker, and two bounded loopback GETs to `/api/health` separated by
about one second. All decisions are based on exact process PID, start
timestamp, restart count, app marker, and four send-capable lane fields.

The exact current-main command, after a future separately approved merge,
is `/run-telegram-cutover-readonly <current-40-character-main-SHA>` in
Release Control #1555, followed by protected Production environment review.
It does not run in a PR and the Draft makes no request for approval.

The receipt has a hard-coded `activationReady=false` even when all four
existing senders are verified stopped. `LEGACY_EMBEDDED_SENDER_ACTIVE`
means the observed old app **cannot** be silently handed off merely by
starting a second process; `PM2_OR_MARKER_UNVERIFIED` and
`PM2_PROCESS_CHANGED` identify identity or restart races. Only exact
owner `isolated`, fresh health of the *same running process* twice, four
lanes NOT_STARTED with inFlight=0, and unrelated background workers
preserved can return `FOUR_LANES_QUIESCED_ONLY`. This is still NOT
authorization or proof of one-writer lock, Secret/Vault/Bot GET/POST,
Signal V3 freshness, member SENT or safe LIVE trading during a restart.

The audit never sends Telegram messages, modifies PM2, changes
LIVE/Paper/broker authorities, accesses private accounts, writes DB, starts
systemd, or records token/chat/member data. It requires no Replit.
