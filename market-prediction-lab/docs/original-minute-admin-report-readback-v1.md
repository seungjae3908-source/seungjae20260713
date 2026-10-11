# Four-market offline native 1m: private admin report bridge

**DRAFT ONLY.** This document is not approval to enter Drift, merge, deploy, install a server worker, access providers, change secrets or execute Paper/LIVE trading.

## Disconnection fixed

- Offline research CLI PERIOD/SWEEP writes a create-only run result with an arbitrary private filename.
- Admin GET `/api/research/video/evidence/workspace/original-minute-diagnostics?market=CRYPTO_SPOT` reads a fixed `<MARKET>.json` under server-only `RESEARCH_ORIGINAL_MINUTE_DIAGNOSTIC_ROOT`.
- Explicit `PUBLISH` mode validates the source result and atomically publishes **only whitelisted model diagnostic fields** to the fixed 0600 market file. Raw OHLCV, trading credentials, account data, raw strategy parameters, file paths and detailed trades are excluded.

## Future use ONLY with a new explicit owner approval

Existing absolute private folders must be 0700 and source/input/result files 0600, regular, one hard-link, no symlinks. Sample protected 0600 `publish-request.json`:

```json
{
  "mode": "PUBLISH",
  "sourceResultPath": "/private/research/results/example-run.json",
  "reportRoot": "/private/research/admin-report",
  "market": "CRYPTO_SPOT",
  "allowLocalReportPublish": true,
  "allowReplaceExisting": false
}
```

Example after authorized offline source work:

```sh
node market-prediction-lab/scripts/run-four-market-original-minute-replay-v1.mjs \
  --input /private/research/publish-request.json \
  --output /private/research/publish-audit-unique.json
```

- `--output` must be a new name. CLI exclusively reserves it before any optional local STOCK_IMPORT or PUBLISH mutation to avoid a report being changed when the audit output already exists.
- Existing market report replacement separately requires `allowReplaceExisting:true`, and local publication timestamp must advance. Writers serialize with a create-only private per-market lock; a crashed stale lock requires manual investigation.
- The publisher uses private temporary files and an atomic same-directory rename, never in-place overwrite; invalid existing files, symlinks, hardlinks, private path ownership failures, fake OOS/actual-fill/Paper flags and malformed input fail closed.
- Blocked results may explicitly replace a positive model to revoke a stale summary. Report timestamp is local publication time, **not historical signal availability**. The UI marks reports older than seven days.
- The server's authenticated, authorized admin GET accepts market only, never a filename/root/strategy/order or user-provided local path.

## Regression tests (fixture-only, no real provider requests)

```sh
node --test market-prediction-lab/tests/research-original-minute-diagnostic-readonly-v1.test.js
node --test market-prediction-lab/tests/research-original-minute-diagnostic-publisher-v1.test.js
node --test market-prediction-lab/tests/four-market-original-minute-replay-cli-v1.test.js
```

The exact-HEAD PIT dedicated workflow also runs these. Application Fast CI covers backend HTTP and frontend browser readback/permission handling.

## Truthful release boundary

KR/US licensed all-security native 1m, independent historic PIT listings and delistings, complete Upbit/Bitget history, authoritative calendars/no-trade evidence and dated FX/cost/fill data, prospective original-time scanner validation, independent OOS/full-cost profitability, current-main long-history backtester integration and real automatic Paper→settlement→Journal→Telegram closure are still **not independently established** by this readback.

Published results remain `executionAuthority=NONE`, `profitabilityProven=false`, `OOSPassCount=0`, `actualFillCount=null`, `trueMarketWideRecall=null`, `paperAdmissionAllowed=false`. No Replit; no Drift/Ready/Merge/deploy/Live/Paper activation without new approval.