# Archived V7 Runner comparison — 2026-09-27

## Classification

- research only
- POST_SELECTION_EXPLORATORY / already-observed history
- NOT independent OOS
- NOT genuine Forward
- NOT account-level profitability proof
- no selected Champion
- executionAuthority=NONE
- actualOrders=0

This report reuses immutable archived source/results without changing PR #1350 or any deployment/runtime lane.

## Immutable inputs

- V2 recent source artifact: `10842828161`
  - ZIP SHA256: `3099e78aba40584612702b49ce868c9a6295ea8ca322272f545c1a52bdeeb64e`
  - source snapshot SHA256: `fabcae6eabe257f0e02bfd1af1f9dabb0b5e1e79494768dd08cb589166a13702`
- V4 prior-year artifact: `10844599643`
  - ZIP SHA256: `1042df64c7c1b1162d5d6d9a99126ddf27414bd1da89195f0ba733ac74ae7f91`
  - source SHA256: `210c53906ba37b3551cd488fff57d0d20626cad30e2fa1ce463d245fe1003451`
- V7 candidate artifact: `10846798437`
  - ZIP SHA256: `50226b49efa58e4fda3b74a0e24b70fa40b95e65338798e6ec11c8309d56559e`

Candidate windows:
- PRIOR_H1: 2025-03-25..2025-09-24
- PRIOR_H2: 2025-09-25..2026-03-24
- RECENT_6M: 2026-03-25..2026-09-24

Data scope remains bounded, not full-market:
- archived crypto universe: 21/22/22 usable names across the observed windows from 25 requested
- FET/LDO/BONK unavailable in the recent source
- 4h candles only for this comparison
- survivorship/PIT listing limitations remain

Cost assumption:
- 0.15% per side, matching the V7 research contract
- 0.30% round trip before any additional unmodeled live-market impact

## Frozen Runner policies

No parameter grid is searched after outcomes. These four policies are frozen as named research candidates.

| Policy | Initial stop | Break-even | ATR trail | Max hold |
|---|---|---|---|---|
| TIGHT_DEFAULT | 1.2 ATR + structure; 0.3–2.5% bounded | 1R | 2 ATR after 2R | 120 × 4h bars |
| LONG_RUNNER_3ATR | same | 1R | 3 ATR after 2R | 120 × 4h bars |
| DELAYED_BE_TRAIL | same | 2R | 3 ATR after 3R | 120 × 4h bars |
| NO_BE_TRAIL_3ATR | same | effectively disabled | 3 ATR after 2R | 120 × 4h bars |

There is no fixed percentage take-profit. +3/+5/+10/+20/+30/+50/+100% are measurement milestones only.

## FIRST_RETEST — per-signal results

These are independent candidate-level simulations, not a capital-feasible portfolio. Overlapping signals are not treated as simultaneous deployable positions here.

| Window | Policy | N | Win rate | Avg net/trade | Profit Factor | Avg MFE | Avg net capture | Largest net trade |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| PRIOR_H1 | TIGHT_DEFAULT | 315 | 30.48% | +0.629% | 1.482 | 4.785% | 13.30% | +47.812% |
| PRIOR_H2 | TIGHT_DEFAULT | 192 | 24.48% | -0.117% | 0.911 | 3.528% | 9.84% | +27.866% |
| RECENT_6M | TIGHT_DEFAULT | 296 | 27.03% | +0.674% | 1.512 | 4.802% | 11.34% | +43.512% |
| PRIOR_H1 | LONG_RUNNER_3ATR | 315 | 23.49% | +0.460% | 1.347 | 5.370% | 8.90% | +47.045% |
| PRIOR_H2 | LONG_RUNNER_3ATR | 192 | 18.23% | +0.115% | 1.086 | 4.524% | 7.08% | +58.430% |
| RECENT_6M | LONG_RUNNER_3ATR | 296 | 19.93% | +0.838% | 1.627 | 5.887% | 8.27% | +68.705% |
| PRIOR_H1 | DELAYED_BE_TRAIL | 315 | 26.03% | +0.335% | 1.208 | 5.820% | 9.72% | +47.045% |
| PRIOR_H2 | DELAYED_BE_TRAIL | 192 | 23.96% | +0.228% | 1.133 | 5.428% | 9.50% | +58.430% |
| RECENT_6M | DELAYED_BE_TRAIL | 296 | 23.65% | +0.816% | 1.517 | 6.484% | 9.86% | +68.705% |
| PRIOR_H1 | NO_BE_TRAIL_3ATR | 315 | 26.98% | +0.257% | 1.149 | 5.856% | 9.97% | +47.045% |
| PRIOR_H2 | NO_BE_TRAIL_3ATR | 192 | 23.96% | +0.122% | 1.068 | 5.410% | 9.37% | +58.430% |
| RECENT_6M | NO_BE_TRAIL_3ATR | 296 | 27.03% | +0.826% | 1.485 | 6.715% | 10.75% | +68.705% |

Across all 803 FIRST_RETEST candidate signals:
- TIGHT_DEFAULT: avg net +0.467%, PF 1.356, win 27.77%, max net +47.812%
- LONG_RUNNER_3ATR: avg net +0.517%, PF 1.388, win 20.92%, max net +68.705%
- DELAYED_BE_TRAIL: avg net +0.487%, PF 1.300, win 24.66%, max net +68.705%
- NO_BE_TRAIL_3ATR: avg net +0.434%, PF 1.251, win 26.28%, max net +68.705%

Descriptive observation only: LONG_RUNNER_3ATR produced positive average net return in each of the three observed windows while retaining much larger winners than TIGHT_DEFAULT. This does not make it a validated Champion because every window is already observed and the comparison is not a capital-feasible portfolio/OOS/Forward proof.

## Pattern families

The new pattern families were not stable enough to promote on this evidence.

CANDLE_RECOVERY:
- TIGHT_DEFAULT avg net: -0.212% / -0.894% / -0.246% across H1/H2/Recent.
- DELAYED_BE_TRAIL: +0.020% / -0.879% / +0.129%.
- The middle window remains materially negative.

CONFIRMED_STRUCTURE_BREAK:
- TIGHT_DEFAULT avg net: +0.956% / +0.237% / -0.539%.
- LONG_RUNNER_3ATR: +1.094% / +0.100% / -0.435%.
- It transferred poorly into the recent window.

Therefore candle/structure descriptors should remain candidate features/context for later models, not independent auto-entry authority.

## What the result means for Move Hunter

1. A low win rate can coexist with positive expectancy when losing trades are bounded and rare large winners are allowed to run.
2. +10% must remain a checkpoint, not an exit.
3. The exit problem is not solved: average net capture of MFE is still low, roughly 7–13% depending on policy/window.
4. Optimizing capture ratio alone is wrong; looser exits can lower capture ratio while increasing net expectancy by preserving extreme winners.
5. Candidate selection still matters more than adding more candlestick names. FIRST_RETEST transferred better than the new candle/structure families on these observed windows.
6. The next valid decision boundary is unused data / genuine Forward plus account-level capacity, full cost, settlement and drawdown.

## Next frozen research step

- keep all four Runner policies; do not delete losers
- do not auto-select a winner from these observed windows
- add a capital-feasible portfolio replay layer with one-symbol dedup, max positions, cash/gross exposure and aggregate-risk constraints
- preserve +3/+5/+10/+20/+50/+100 milestones without take-profit caps
- compare account net return, PF, MDD, opportunity rejection, peak-profit giveback and concentration
- then require genuinely unused Forward evidence before promotion
