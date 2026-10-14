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


## Independently launched worker state-root precondition fixed

A real dormant-install defect was found: `ops/run-telegram-isolated-worker.sh`
requires the private `/opt/stock-app-data/telegram-isolated-v1/state` directory
before it can acquire its exclusive owner lock or launch. The protected
installation path formerly prepared only `release` and `incoming`, so a
perfectly sealed bundle could later be non-startable on a fresh host.

The install script now creates `state` as mode `0700` while it holds the
shared deployment and Telegram owner locks, **after** verifying old PM2
identity but before materializing an executable release marker. It refuses
existing symlinks, non-directories, group/world-accessible directories, and
unwritable directories, rather than changing or deleting existing operator
data. The directory remains EMPTY: no sender is started and no delivery
ledger is migrated or written. Fake-PM2 full shell regressions verify
positive mode 0700 and both unsafe existing-directory cases. This is
source-level and hermetic QA only; the actual Production directory has not
been inspected or changed.

Real live deployment still requires an independently authorized
LIVE-preserving old-app owner switch and two same-process stopped-lane
proofs. A dormant directory is NOT cutover authorization.


## Launch-time fail-closed shell rehearsal (source-only)

The same protected-install PR now tests the ACTUAL dormant launcher shell,
`ops/run-telegram-isolated-worker.sh`, with a sealed manifest, mock PM2,
mock loopback health, and a fake Node executable that **never imports or
runs Telegram production worker code**. It proves:

- With a verified same-process isolated owner and two fresh stopped-lane
  health checks, the shell reaches the final mocked Node boundary only.
- Old `TELEGRAM_WORKER_OWNER=embedded`, an in-flight sender, altered
  sealed bytes, missing private state root, missing owner approval and
  a mismatched release SHA block before any sender is launched.
- Real LIVE trading flags in the fake PM2 remain intact throughout.

The test uses only disposable temporary paths and does not touch PM2,
Telegram Bot API, providers, orders, Production secrets, or databases.
A mock success is NOT real live sender startup or Bot acceptance; actual
host cutover remains a separately protected, owner-authorized operation.

## Independent owner-only 1:1 Telegram TEST (read-only database)

The October 14 human-confirmed six-room test (#38496644075) proved six
group messages accepted and received. It did NOT prove personal 1:1 delivery
or generate a durable notification_deliveries.SENT event. A read-only
production SQL preflight verified exactly one Vault-bound approved owner,
one ACTIVE private owner connection and zero personal SENT rows.

The Draft now contains an independent protected workflow:
- ops/telegram-owner-personal-test-send.mjs
- .github/workflows/telegram-owner-personal-test-send.yml
- .github/tests/telegram-owner-personal-test-send.test.mjs
- .github/tests/telegram-owner-personal-workflow-contract.test.mjs

AFTER a separately authorized merge onto exact current main, the verified
repository owner can request exactly once on Release Control #1555:

    /run-telegram-owner-personal-test-send <exact-current-main-SHA>

It additionally requires an independent protected Production approval.
The workflow requires exact source identity, first attempt only, actual
unchanged PM2+marker, Telegram activation flag, Vault-bound owner/approved
active connection and no other ACTIVE member connection, bot getMe and a
private getChat with exactly the matched chat ID. SQL is BEGIN READ ONLY
with default_transaction_read_only=on and project-identity verification.

Only after all gates it can POST a single non-trading personal TEST.
There is no timeout retry, no auto-revocation of Telegram connection,
no DB/user execution event/notification SENT insertion, no PM2 restart,
no broker orders, no activation of the isolated standalone worker.
GitHub receives only sanitized status and 0/1 attempt/accept counts.
Bot API acceptance is not a human read receipt or a genuine trade alert.

This source-only PR does NOT send or deploy anything. The live job must
be SKIPPED for pull_request. The existing user UI also has a TEST button
at POST /api/user-integrations/telegram/test but may revoke on 403;
this independent one-shot route deliberately leaves the link intact.
Replit and Replit Agent remain prohibited.


## Production October 14 source-backed delivery diagnosis and NO-REPLAY watchdog

An owner-approved, GET/read-only Production Telegram audit #38498750929
completed successfully at 2026-10-14 02:07 UTC, using main c9ed902e
and actual older app deployed marker 3e104bbe. It proved PM2/marker
match and Bot activation flags true, but NOT continuous sending.

- The scheduled brief worker remains RUNNING in health, while last completed
  tick was 2026-10-13 06:49 UTC (15:49 KST); the KR closing due window
  begins 15:50 KST. This is a possible in-flight stall, NOT a proven cause.
- Brief ledger 16 entries, none added in the preceding 24h; last due
  report was DEDUPED_ONLY (attempted0, accepted0), not a new send.
- Personal worker last tick was fresh but no genuine member SENT receipt.
- Signal V3 localhost returned HTTP503 with older-than-60m public snapshot.
  Its systemd server/timer were active, but cycle last exit was NOT_OBSERVED.
  Subscriber Telegram ledger was ABSENT. Never invent source freshness.

New code in api-server/src/services/telegram-intelligence-worker.service.ts
adds a bounded no-replay health watchdog: timestamp and fixed-safe stage
codes PLAN, PUBLIC_BRIEF_READ, LEDGER_LOOKUP, RESERVE_UNCONFIRMED,
BOT_POST, DURABLE_RECEIPT_WRITE, IDLE. A tick still in flight more than
ten minutes is marked stalled, tickOk=false with safe code
TELEGRAM_BRIEF_IN_FLIGHT_STALLED. It does not alter in-flight promises,
unlock a reservation, issue a second Bot POST, or restart PM2. Once the
original tick finishes normally, the health status can recover by result.
The watchdog helps determine WHAT is stalled on a newly deployed app
but cannot magically fix the previous server revision, its source data,
or guarantee a stalled remote POST was accepted. The current running
app has not been updated and remains a production NO-GO for automatic
delivery until a separate live-trading-preserving release is approved.

Stall regression assertions are consolidated into the existing Telegram
notification test (already in dedicated QA AND canonical application phase9).
They verify time-bound stall
detection and a pending original Bot POST whose durable unconfirmed
reservation prevents a second invocation. No network, Bot, PM2,
database or real trading mutation occurs in these tests.
Replit and Replit Agent remain prohibited.
