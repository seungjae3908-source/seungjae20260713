# V6 direct entry and priority research

Owner #1350 / Hub #1102. Preregistered before viewing new experiment returns at
Hub comment5826622916. V1–V5 files unchanged. Three new hypotheses; no parameter grid.

User target is net whole-account monthly3–10%, not six-month3–15%. Six-month
simple reference18–60% versus reinvested19.405–77.156%. Numeric target, monthly
consistency, drawdown and genuinely unused validation are separate decisions.

## Fixed comparison

- BASELINE: frozen V5 first-retest and full units held after2R with3ATR trail.
- SYMBOL_DAILY_TREND: same candidates but last fully completed UTC daily close
  above20day SMA with positive5day SMA slope. Require25consecutive complete days.
- RELATIVE_STRENGTH_PRIORITY: same candidates, change ONLY simultaneous entry
  priority after signal time. Score=(30x4h own logreturn minus BTC logreturn)
  divided by own30bar logreturn standard deviation. Tie:20bar average KRW
  close-times-volume, original relative volume, symbol. Missing input ranks after
  known scores; no invented probabilities or use of future exit paths.
- COMPRESSION_BREAKOUT: new first12bar high breakout after preceding12bar range
  shrinks to<=80%of previous12bar range, rvol>=1.2, same daily trend gate.

All use existing structure/ATR initial stop, risk0.5%pertrade/2%aggregate,
20%symbol/40%theme/5positions/no borrowing, same costs and V5 exits. Actual
exposure can differ, so this is not a claim of identical realized risk.
V3 replay is reused in an isolated namespace; exactly one guarded priority
expression is replaced. Default hook must match original replay byte-for-byte
in portfolio data, and recent baseline must match pinned V5 ledger/fills/audit/
equity/reasons before any output is accepted.

## Dates/data

Three nonoverlapping half-year windows:2025-03-25..09-24,
2025-09-25..2026-03-24,2026-03-25..09-24. Start flat KRW10m each; do not add
returns. All windows already observed; no independent OOS claim.
Pinned old V2/V3/V4 archives plus V5 ledger; zero fresh provider requests.
Missing FET/LDO/BONK/WLD history remains explicit, static survivor bias remains.
Daily bars require six complete consecutive4h candles; only information with
availableAt<=signal knownAt is used. Prior window coverage uses only its own
window/prehistory. Whole-series coverage exclusion remains a selection limit.

## Local economic result (all retained)

| Window | Baseline | Daily trend | Relative strength priority | Compression breakout |
|---|---:|---:|---:|---:|
| 2025-03-25..09-24 |12.112%|6.756%|12.455%|5.666%|
| 2025-09-25..2026-03-24 |-4.456%|-4.549%|-5.576%|-1.503%|
| 2026-03-25..09-24 |15.344%|0.033%|15.347%|-6.431%|

No arm reaches the user's minimum aggregate target, no arm passes all-window
monthly-equivalent/stress/30trade/12%MDD research screen. That12%screen is NOT
user risk-tolerance authorization. Month3/5/10%counts and negative/worst months
are retained. Six anniversary-month growth factors reconcile to account growth.
Fixed-quantity cost repricing is separate from full risk-resized cost replay.

Daily gate rejects56of the recent baseline's accepted entries (26winners,
30losers), whose original fixed-ledger PnL sums to+KRW1,480,009. This is
post-hoc contribution diagnosis, NOT a new portfolio excluding those trades.
RS-priority recent91entries share89IDs with baseline;2replace2. Improvement is
only0.003percentage point, not a meaningful goal achievement. Compression is a
whole new entry family plus daily gate; do not attribute its failure solely to
the range condition. No thresholds retuned after seeing results.

## Verification/stop line

91offline regressions (71preserved +20new), default replay equality, recent
V5baseline equality, two-run exact output reproduction, pinned hashes, no
future daily/rank inputs, cash/gross/position and monthly reconciliation.
Result SHA256:64b4f2f8bbcb91533f23a55d526b60d3fbda3a40bc7baebfb469c00a88ad95d6.
Dedicated CI must independently reproduce this output; do not claim CI success
until terminal readback.

Candle-only fills, static universe/PIT/thematic membership gaps, min-order/tick/
depth/latency/settlement, intrabar MDD, profit concentration, prior selection,
and genuine unused validation remain unresolved. NBERw24877/w25882 motivate
momentum hypotheses only, not these exact rules or future profit claims.
https://www.nber.org/papers/w24877
https://www.nber.org/papers/w25882

Decision:RESEARCH_HOLD_OBSERVED_HISTORY, selectedChampion=null,
profitabilityProven=false,independentOos=false,canonicalSampleDelta=0,
executionAuthority=NONE,actualOrders=0. No Ready/Merge/rebase/main/deploy,
operational schedule/Paper/Telegram/private API or Replit.
