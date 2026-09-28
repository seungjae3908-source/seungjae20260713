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


## Capital-feasible portfolio replay on the same archived FIRST_RETEST signals

This second layer applies the same Runner exits to a bounded long-cash model account.

Frozen account constraints:
- initial capital: KRW 10,000,000
- risk per accepted trade: 0.5% of current equity
- aggregate initial risk cap: 2.0%
- max simultaneous positions: 5
- per-symbol gross cap: 20%
- per-theme gross cap: 40%
- total gross exposure cap: 100%
- same-bar intrabar exits do NOT fund new entries at that same bar open
- fractional crypto units allowed
- no leverage
- cost: 0.15% per side
- 4h close marks used for MTM drawdown

This is still observed-history research and is not actual fill evidence.

| Window | Policy | Account net | MTM MDD | Trades | Win rate | PF | Best modeled trade |
|---|---|---:|---:|---:|---:|---:|---|
| PRIOR_H1 | TIGHT_DEFAULT | +15.327% | 15.293% | 175 | 28.00% | 1.308 | SUI +~KRW879k |
| PRIOR_H2 | TIGHT_DEFAULT | +0.037% | 14.739% | 124 | 24.19% | 1.001 | NEAR +~KRW567k |
| RECENT_6M | TIGHT_DEFAULT | +13.582% | 13.478% | 192 | 23.96% | 1.271 | PEPE +~KRW756k |
| PRIOR_H1 | LONG_RUNNER_3ATR | +20.415% | 15.123% | 155 | 21.94% | 1.462 | SUI +~KRW853k |
| PRIOR_H2 | LONG_RUNNER_3ATR | +2.318% | 15.700% | 112 | 16.07% | 1.073 | RENDER +~KRW1.097m |
| RECENT_6M | LONG_RUNNER_3ATR | +26.079% | 13.431% | 176 | 15.91% | 1.558 | NEAR +~KRW1.416m |
| PRIOR_H1 | DELAYED_BE_TRAIL | +15.990% | 16.473% | 148 | 23.65% | 1.323 | SUI +~KRW844k |
| PRIOR_H2 | DELAYED_BE_TRAIL | +13.307% | 14.984% | 100 | 22.00% | 1.360 | RENDER +~KRW1.211m |
| RECENT_6M | DELAYED_BE_TRAIL | +25.688% | 16.812% | 161 | 19.25% | 1.512 | NEAR +~KRW1.372m |
| PRIOR_H1 | NO_BE_TRAIL_3ATR | +11.762% | 17.172% | 148 | 23.65% | 1.222 | SUI +~KRW844k |
| PRIOR_H2 | NO_BE_TRAIL_3ATR | +11.341% | 15.451% | 99 | 22.22% | 1.297 | RENDER +~KRW1.207m |
| RECENT_6M | NO_BE_TRAIL_3ATR | +28.197% | 17.944% | 156 | 23.08% | 1.545 | NEAR +~KRW1.399m |

Capacity rejections are material. For example, LONG_RUNNER_3ATR accepted 155 / 112 / 176 positions in H1/H2/Recent while rejecting additional signals because of position, same-symbol or risk/cash capacity. Therefore candidate-level averages cannot be multiplied by signal count to claim account returns.

### Concentration warning

Observed profits remain highly dependent on a few very large winners.

LONG_RUNNER_3ATR:
- PRIOR_H1: top single winner contributed about 41.8% of modeled net PnL; top 3 about 94.8%.
- PRIOR_H2: net result was only +2.318%; the largest winner was several times larger than final total PnL because many other trades lost.
- RECENT_6M: top single winner contributed about 54.3% of modeled net PnL; top 3 slightly exceeded final net because the remaining book was net negative.

DELAYED_BE_TRAIL and NO_BE_TRAIL_3ATR show similar concentration. This is exactly why a large return on observed history is not enough for adoption.

### Current research interpretation

- TIGHT_DEFAULT is more likely to clip large moves and failed to produce meaningful account growth in PRIOR_H2.
- LONG_RUNNER_3ATR kept all three modeled account windows positive and materially expanded the best modeled winner, but its H2 margin was thin and winner concentration is high.
- DELAYED_BE_TRAIL produced positive account returns in all three observed windows and was less dependent on early break-even exits, but MDD remained about 15–17%.
- NO_BE_TRAIL_3ATR produced the largest RECENT_6M account return among these frozen comparisons, but also the highest recent MDD and more open-profit giveback.

No policy is promoted from this table. All policies remain frozen research candidates for unused data and genuine Forward.

## Required next evidence before any adoption

1. strict point-in-time 3-year data readiness for each market/profile;
2. full-market Recall@K, not a static survivor universe;
3. genuine unused chronological OOS or Forward;
4. full cost / partial-fill / settlement evidence;
5. concentration stress:
   - remove top 1 and top 3 contributions descriptively,
   - sector/theme cluster stress,
   - liquidity/capacity stress;
6. account-level daily distribution:
   - median/worst/no-trade/negative days,
   - daily +3/+5/+10% attainment frequencies,
   - MDD and tail loss;
7. only then evaluate Paper adoption.
