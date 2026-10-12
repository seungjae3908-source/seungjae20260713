# Four-market offline native 1m: private admin report bridge

**DRAFT ONLY.** This document is not approval to enter Drift, merge, deploy, install a server worker, access providers, change secrets or execute Paper/LIVE trading.

## Disconnection fixed

- Offline research CLI PERIOD/SWEEP writes a create-only run result with an arbitrary private filename.
- Admin GET `/api/research/video/evidence/workspace/original-minute-diagnostics?market=CRYPTO_SPOT` reads fixed private files `<MARKET>.json` (PERIOD) and optional `<MARKET>.SWEEP.json` under server-only `RESEARCH_ORIGINAL_MINUTE_DIAGNOSTIC_ROOT`. Legacy single-file SWEEP remains readable; new SWEEP publication does not replace PERIOD. Both must be 0600, never HTTP-selected.
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
- **Repeated publication of the identical immutable source/model evidence is denied**, even if the JSON file has different whitespace or extra private fields. A genuinely new result needs a changed reviewed model summary or immutable original-source lineage SHA, not a newer clock alone. The source-model digest stays in the private fixed report and is not disclosed to the browser.
- Existing market report files for another venue are invalid and cannot be overwritten as if they belonged to the requested market.
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
## Research result -> existing profitability/Paper acceptance gates (still blocked)

- New pure module `four-market-original-minute-candidate-review-v1.js` checks a retrospective original native 1m PERIOD receipt and an optional same-market/same-window PIT SWEEP. It calls both existing `evaluateUnifiedProfitabilityPromotion` and `resolveCanonicalPaperAdmissionBridgeCandidate` with honest missing independent evidence; no trial policy or Paper bundle is fabricated.
- Result status remains `RESEARCH_HOLD` with explicit missing historical full-PIT roster, source rights, original-time T-minus scanner, independent frozen OOS/walk-forward, dated full costs/fill quality, real future signal and Paper→settlement→Journal→Telegram blockers.
- New `CANDIDATE_REVIEW` mode of the private CLI writes a create-only read-only review receipt. It creates **no** canonical candidate, strategy promotion, Paper order, trade, API request or Telegram message.
- The administrator's retrospective PERIOD summary displays localized blockers returned by the *same* pure review module. Paper/Live is never enabled by reading or publishing a model.
- Even a modeled positive 100,000% return or apparently complete local member/date source receipts cannot satisfy independently observed forward evidence, profitable OOS or a current-time canonical Paper admission bundle.

Fixture-only regression command:

```sh
node --test market-prediction-lab/tests/four-market-original-minute-candidate-review-v1.test.js
```

STOP BEFORE DRIFT: Only after genuinely independent live-time, dataset, OOS and Paper evidence and a fresh explicit owner approval may a later stage consider promotion. This Draft bridge issues no trading authority.