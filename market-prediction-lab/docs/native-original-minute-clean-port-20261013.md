# Native 1m historical replay — main-descended Draft clean port

Date: 2026-10-13 KST. Source owner: Research Backtester PR #1848. **No Replit / Replit Agent. Draft/Drift only.**

## Provenance and dependency order
- Latest inspected main at construction: `032efa64ccd09d3c1049167c0009121a826596a9` (recheck at release).
- Already-tested **admin-only PIT original 1m inventory owner**: Draft #1832, exact head `66a12f115f720d5b83495773e39f593efa1055e3`, Full CI #38277202639 26/26 + required 6/6 SUCCESS. **Current #1848 is stacked on this Draft**. Base owner remains untouched.
- Gap/stop, cost, closed-bar MTM and native historical source provenance: historical #1848 source `22307646558accb0b3d64e29ba04ac9ff09b77cc`. 31 exact overlay paths with only original 1m offline model, replay, private archive/source audit, PIT membership, bounded work queue, historical selected-window/sweep, offline readback, CLI, and associated tests.
- Shared from the verified #1832/current-main tree WITHOUT overlay or ownership transfer: `market-prediction-lab/src/research-selected-window-v1.js` (identical to source blob `1313e6587a4e3689d0b82e02aeda426752d07678`), `canonical-paper-admission-bridge-v1.js` and `unified-profitability-promotion-gate-v1.js` (also exact blob identities).
- Only pre-existing shared utility changed in this branch is the additive `timeframes.js` 1m/3m/5m/30m period definitions. Research OHLCV resampling is not an authenticated trade signal, tick/OI/CVD feed or independent source right.
- **Never substitute all 197 stale upstream files** from long-diverged historical #1534/#1848 for current main. Prior old branch compare was 1,783 commits behind. Main/shared member/LIVE code preserved.
- Parent approval/merge order, if later requested: first #1832 Research PIT inventory, then new #1848 offline replay. #1867 source+AI TRAIN and #1756 Natural three-task observer remain separate owners with no overwritten code. After all approved merges, require new coherent exact-current-main CI (Required 6/6) before any protected Staging request.

## What this code can prove vs cannot
- **Offline only:** bounded original minute import closure, provenance checks, isolated private 1m source archive/period/PIT date read, modeled gap-stop open fills, direction gates (stocks/spot LONG-only; futures LONG/SHORT), fees/spread/slippage/latency/tax/futures funding policy, model closed-bar MTM.
- **NOT independently proven:** legal/licensed KR/US native 1m and delist-inclusive historical PIT universe; complete 24h Upbit/Bitget backfill throughput (760 dense crypto symbols -> at least 9,120 calls/day vs existing 4,608/day planner capacity); Vultr disk/inodes/backup and real archive activation; true scanner-time lookahead-freedom; frozen independent OOS/Walk Forward; live 8-part cost/funding/FX/margin/fill evidence; valid Paper SHA/settlements; economic profitability.
- 2026-10-12 read-only Natural Production Run #38258127017 reported 3 forward tasks BLOCKED_DATA, EVIDENCE_COMPLETE=0, PAPER_STATE_SOURCE_SHA_MISMATCH, supplemental cost missing. A green fixture test cannot repair those missing operating receipts.
- Staging Full QA #38240423046 failed on unrelated Paper holdings HTTP 400; exact-main #38250167075 only did preflight and skipped deploy/full validation. Neither is a fresh Research activation PASS.

## Offline verification and safety stop
- Use one SHA-pinned `Research Original Minute Gap and MTM Drift QA` on owner push. Validate source closure, modeled economics (11 checks), core historical replay, batch, candidate review, PIT queue and private archive/diagnostic regressions. No rerun-to-pass, no security guard weakening. Tests may write temporary fixture files only inside isolated GitHub runner.
- All approved evidence fields remain blocked/unproven: `profitabilityProven=false`, independent OOS PASS 0, Paper admission false, orders 0, executionAuthority NONE.
- Do not enable public data worker/cron, modify Vultr/PM2/systemd/DB/RLS/Secrets/Env, access private provider APIs, send Telegram, activate Paper/Live or deploy Staging/Production from this Draft. Human approval required at each operational release boundary.
