# Production Telegram workers: protected read-only observability

## Why this audit exists

The six-room PM2 Vault binding and 6/6 single TEST delivery are confirmed, but one-shot sends do not prove that scheduled market report workers or personal execution-event notifications have produced fresh sends.

Production Supabase read-only aggregates, 2026-10-11 KST:
- notification_deliveries: three historical DEAD_LETTER/TELEGRAM_HTTP_403 rows, all before the current Telegram connection;
- current Telegram connection: ACTIVE, connected later than those 403 rows;
- zero notification_deliveries SENT rows after reconnect (zero SENT in 7 days).
These observations do not establish that 403 continues or that post-reconnect personal notification succeeds. Historical failures must not be replayed without explicit authorization.

## Scope

This audit does not modify an existing worker or deploy the application. It includes:
- ops/telegram-production-worker-readonly-audit.mjs: one-shot read of exact PM2 metadata, deploy marker, whitelisted loopback /api/health fields, existing Telegram market report state and signal subscriber state, plus one bounded GET to the configured local-only signal source to validate its public non-trading envelope and count events without returning contents.
- .github/workflows/telegram-production-worker-readonly-audit.yml: owner-only Release Control #1555 protected production workflow.
- tests for redaction, stale SHA failure, bounded file reads and no-send behavior.

After a separately authorized PR merge, the owner can use the exact command:

    /run-telegram-worker-readonly <exact-current-main-sha> <actual-deployed-production-sha>

The workflow then requires a separate GitHub protected production review. The Draft PR does not dispatch this workflow.

State may contain Telegram chat IDs and signal identifiers. This audit publishes no raw keys, IDs, paths, HTTP bodies, tokens or credentials. It reports only safe classifications, counts, timestamps, booleans and error codes. A signal source status READY means a validated local safe public signal envelope, not a signal-to-Telegram delivery. It rejects unsafe file locations and oversized/symlinked files.

## Production root regression (2026-10-11)
The first protected Production audit run #38096662006 reached PM2 safely, verified the online process
and matching deployed PM2/marker SHA, but returned PRODUCTION_IDENTITY_MISMATCH before reading
health or ledgers. The audit incorrectly required PM2 cwd to be /opt/stock-app/api-server;
the existing Production deployment and six-room PM2 binding both require /opt/stock-app.

The fixed diagnostic requires BOTH the canonical /opt/stock-app PM2 cwd and
/opt/stock-app/api-server/dist/index.mjs entrypoint, plus exact deployed SHA and marker.
Default market-brief and signal-subscriber ledger paths now follow the actual PM2 cwd
(/opt/stock-app/.runtime), with constrained read-only allowlists for this directory,
the historical api-server/.runtime directory, and /opt/stock-app-data. Source files,
env files, secrets and other paths remain disallowed. Error classifications distinguish
PM2_NOT_ONLINE, PRODUCTION_SHA_MISMATCH, PM2_CWD_MISMATCH, and PM2_ENTRYPOINT_MISMATCH
without exposing raw paths or process environment values.

Run #38096662006 sent zero messages and made zero DB/PM2/financial mutations.
A new exact-main protected audit run and human production-environment review remain
necessary to establish fresh market, signal and personal-delivery observations.

## Signal source response classification

The protected production audit Run #38097651870 confirms PM2 and six-room
configuration but not continuous messages: both persisted Telegram worker
ledgers are ABSENT, the personal delivery tick is fresh but unconfirmed,
and the local Signal V3 query was classified UNREACHABLE.

Signal V3 deliberately returns HTTP 503 for a missing or stale public
snapshot. The old audit classified every non-200 HTTP response as a
network outage. The corrected one-shot audit uses three distinct labels:
UNREACHABLE for a genuine GET transport error or timeout, HTTP_503 for a
reachable service returning HTTP 503 (snapshot may be unavailable), and
HTTP_ERROR for any other non-200 HTTP response. READY still requires the
validated public-only V3 envelope and reports only a count.

This change does not inspect or publish response bodies, issue POST requests,
rebuild data, restart systemd/PM2, deliver Telegram messages, change account
permissions or submit trades. Another protected QA approval will be needed
after an independently approved merge before making an operational claim.

## Signal V3 process, timer, health and scheduled-brief evidence
The preceding read-only audit showed a fresh personal delivery worker tick but no
confirmed member SENT event, no on-disk market or signal Telegram dedupe receipts,
and a Signal V3 endpoint whose HTTP failure classification was insufficient.
With only those facts, it is unsafe to label the V3 daemon down, the snapshot stale,
or the Telegram delivery path broken.

The owner-protected one-shot V2 diagnostic now also reads the three fixed systemd
units (V3 server, five-minute public scanner timer, scanner oneshot). Only safe status
labels ACTIVE, INACTIVE, FAILED, NOT_FOUND, UNKNOWN or UNAVAILABLE are reported.
A separate bounded loopback GET /health on the same configured Signal V3 source
validates the public-only, no-trading health envelope and returns only status,
validated service SHA and booleans for snapshotReady/snapshotFresh. The health
error text, provider events, account data and raw systemd metadata are discarded.

It also reports the sanitized PM2 process start time. A missing market briefing
ledger is not, by itself, proof of a failed scheduled brief: an after-window PM2
restart or a worker that has not attempted a due report can produce ABSENT.
The actual scheduled slot and uptime must be compared without attributing
a fabricated send receipt.

Read-only service inspection and GET health cannot activate systemd, populate an
absent research snapshot, create a trading signal, or prove that a Telegram
message was delivered. If V3 is inactive or missing, any activation requires
separate explicit authorization, and restored delivery still requires later
real persisted receipts and member confirmation.

## Interpretation

- A market report ledger entry means accepted OR duplicate-suppressed, not proof of a fresh Bot API message. Proof level is PERSISTED_LEDGER_ONLY.
- A fresh personal worker tick with no pending events cannot prove a delivered personal alert.
- Only new personal SENT evidence with an actual delivery event and separate user confirmation can close the personal alert chain.
- A historical 403 predating a new ACTIVE connection should not trigger false recovery. A new 403 after that connection requires recovery. Prior DEAD_LETTER evidence stays intact.
- This read-only audit sends zero Telegram messages and makes zero DB writes, PM2 restarts, webhook edits, private provider requests, orders or withdrawals.

## Authorization boundary

Replit and Replit Agent are prohibited. The audit requires separate code-review/merge approval
and a protected production-environment approval for each invocation. No Staging/Production app
deployment, LIVE/AUTO authority change, financial action, Telegram send, database write or PM2 restart
is authorized by running this audit.
