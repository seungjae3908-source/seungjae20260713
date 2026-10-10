# Production Telegram workers: protected read-only observability

## Why this audit exists

The six-room PM2 Vault binding and 6/6 single TEST delivery are confirmed, but one-shot sends do not prove that scheduled market report workers or personal execution-event notifications have produced fresh sends.

Production Supabase read-only aggregates, 2026-10-11 KST:
- notification_deliveries: three historical DEAD_LETTER/TELEGRAM_HTTP_403 rows, all before the current Telegram connection;
- current Telegram connection: ACTIVE, connected later than those 403 rows;
- zero notification_deliveries SENT rows after reconnect (zero SENT in 7 days).
These observations do not establish that 403 continues or that post-reconnect personal notification succeeds. Historical failures must not be replayed without explicit authorization.

## Scope

This Draft does not modify an existing worker or deploy the application. It adds:
- ops/telegram-production-worker-readonly-audit.mjs: one-shot read of exact PM2 metadata, deploy marker, whitelisted loopback /api/health fields, existing Telegram market report state and signal subscriber state.
- .github/workflows/telegram-production-worker-readonly-audit.yml: owner-only Release Control #1555 protected production workflow.
- tests for redaction, stale SHA failure, bounded file reads and no-send behavior.

After a separately authorized PR merge, the owner can use the exact command:

    /run-telegram-worker-readonly <exact-current-main-sha> <actual-deployed-production-sha>

The workflow then requires a separate GitHub protected production review. The Draft PR does not dispatch this workflow.

State may contain Telegram chat IDs and signal identifiers. This audit publishes no raw keys, IDs, paths, HTTP bodies, tokens or credentials. It reports only safe classifications, counts, timestamps, booleans and error codes. It rejects unsafe file locations and oversized/symlinked files.

## Interpretation

- A market report ledger entry means accepted OR duplicate-suppressed, not proof of a fresh Bot API message. Proof level is PERSISTED_LEDGER_ONLY.
- A fresh personal worker tick with no pending events cannot prove a delivered personal alert.
- Only new personal SENT evidence with an actual delivery event and separate user confirmation can close the personal alert chain.
- A historical 403 predating a new ACTIVE connection should not trigger false recovery. A new 403 after that connection requires recovery. Prior DEAD_LETTER evidence stays intact.
- This read-only audit sends zero Telegram messages and makes zero DB writes, PM2 restarts, webhook edits, private provider requests, orders or withdrawals.

## Authorization boundary

Replit and Replit Agent are prohibited. No Ready/Merge/Production or Staging deployment, no LIVE or AUTO authority changes. The work remains Draft pending explicit user approval and exact-HEAD CI evidence.
