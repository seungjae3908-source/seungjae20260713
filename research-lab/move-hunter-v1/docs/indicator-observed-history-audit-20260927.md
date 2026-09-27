# Indicator research outcome audit — 2026-09-27

## Classification

Already-observed historical research only. Not pristine OOS, not Forward, not profitability proof.

Inputs:
- FIRST_RETEST candidates from archived V7 artifacts
- exact archived 4h OHLCV sources used by V2/V4/V7
- BTC same-time 4h benchmark
- fixed LONG_RUNNER_3ATR initial risk / costs / account constraints
- canonical Market Features V2 formulas mirrored for closed-bar EMA/ADX/ROC/RSI/MACD/relative-strength/volume/structure states

## 1. Indicator-Adaptive Exit V1 — failed transfer

Policy tested:
- ACCELERATION => 4 ATR
- NORMAL => 3 ATR
- WARNING => 2 ATR
- INVALID => next-bar-open exit

Per-signal average net:
- PRIOR_H1: +0.637% vs fixed3ATR +0.460%
- PRIOR_H2: +0.057% vs +0.115%
- RECENT_6M: +0.276% vs +0.838%

Account replay:
- PRIOR_H1: +24.220% vs fixed +20.415%
- PRIOR_H2: -0.371% vs fixed +2.318%
- RECENT_6M: +0.148% vs fixed +26.079%

Conclusion:
- V1 is not robust.
- indicator invalidation repeatedly cut large winners in the recent window.
- it must not be a default exit authority.
- engine default `indicatorExitEnabled=false`.
- code remains research-only for future controlled comparisons.

A trail-only diagnostic without next-open forced exits also failed to dominate:
- PRIOR_H1 +15.812%
- PRIOR_H2 -2.129%
- RECENT_6M +9.580%

Therefore the problem is not only the INVALID forced-exit rule; dynamic trailing itself needs stronger validation.

## 2. Indicator Priority Overlay V1 — preregistered, also not robust

Frozen four components:
- TREND
- MOMENTUM
- RELATIVE_STRENGTH
- PARTICIPATION

No signal rejection; score only reordered same-time capacity competition.

Account results:
- PRIOR_H1: +23.103% vs existing priority +20.415%
- PRIOR_H2: -0.320% vs +2.318%
- RECENT_6M: +25.724% vs +26.079%

Conclusion:
- the composite score is not robust enough to adopt.
- equal weighting of tape-derived indicators does not create independent evidence.
- no composite-priority production path should be added from these results.

## 3. Component diagnosis

Observed FIRST_RETEST fixed-3ATR candidate results:

### MOMENTUM
Definition was preregistered before the priority test:
- ROC12 > 0
- MACD histogram > 0
- RSI14 >= 50 and < 82

MOMENTUM=true:
- PRIOR_H1: N293, avg +0.533%, PF 1.405
- PRIOR_H2: N179, avg +0.254%, PF 1.194
- RECENT_6M: N277, avg +0.959%, PF 1.733

MOMENTUM=false:
- PRIOR_H1: N22, avg -0.501%, PF 0.663
- PRIOR_H2: N13, avg -1.799%, PF 0.000
- RECENT_6M: N19, avg -0.935%, PF 0.462

This is the only component in this audit whose true/false split is directionally consistent across all three observed windows.

### PARTICIPATION
Definition:
- RVOL20 >= 1
- signed volume balance > 0
- no price-volume disagreement

It was helpful in H2/Recent but not cleanly monotonic in H1.

### TREND and RELATIVE_STRENGTH
Neither was monotonic across all observed windows. In H1 and Recent, their false groups contained some very large winners. Therefore they should not be hard gates based on this evidence.

## Next frozen hypothesis — unused data only

`MOMENTUM_GUARD_FORWARD_V1`

Candidate remains FIRST_RETEST + LONG_RUNNER_3ATR.

The guard may be evaluated only on genuinely unused chronological OOS/Forward:
- eligible if ROC12 > 0
- MACD histogram > 0
- RSI14 >= 50 and < 82
- no parameter grid
- no fallback threshold relaxation
- no leverage/risk increase
- no use of TREND/RS/volume as mandatory gates in V1
- compare against the exact unfiltered FIRST_RETEST baseline

Required outcomes:
- opportunity recall lost by guard
- account net return / PF / MDD
- top1/top3 concentration
- no-trade frequency
- missed large-winner audit
- costs/settlement
- Forward first-hit + MFE/MAE

The observed-history component table is hypothesis-generating evidence only. It cannot be counted again as OOS evidence for MOMENTUM_GUARD_FORWARD_V1.
