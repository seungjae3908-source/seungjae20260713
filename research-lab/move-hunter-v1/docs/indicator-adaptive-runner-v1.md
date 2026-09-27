# Indicator-Adaptive Runner V1

## Purpose

Use the already-merged canonical `adaptive-multi-evidence-market-features-v2` evidence as a position-management input for Move Hunter without creating another indicator engine.

Canonical inputs reused:
- EMA fast/slow direction and slope
- ADX / +DI / -DI
- Donchian position
- price structure persistence / higher-timeframe alignment
- ROC
- RSI
- MACD histogram
- momentum acceleration
- benchmark-relative strength
- relative volume
- signed volume balance
- price/volume disagreement
- realized volatility / range expansion-compression

No indicator receives independent trading authority. The canonical source itself remains `decisionAuthority=EVIDENCE_ONLY` and `executionAuthority=NONE`.

## States

### ACCELERATION
Typical evidence:
- EMA trend aligned
- positive directional EMA slopes
- ADX >= 25 with directional DI alignment
- ROC and MACD histogram aligned
- RSI strong but not exhausted
- momentum acceleration nonnegative
- supportive RVOL / signed-volume or benchmark relative strength
- no opposite price structure

Action:
- trail at 4 ATR
- no fixed profit target
- +10/+20/+50/+100 remain measurement milestones only

### NORMAL
Trend remains usable but not enough independent evidence for acceleration.

Action:
- trail at 3 ATR

### WARNING
At least two weakening conditions, such as:
- EMA fast slope weak
- ROC weak
- MACD histogram weak
- momentum decelerating
- price/volume disagreement
- RSI exhaustion
- ADX < 18

Action:
- trail at 2 ATR
- no same-close forced exit

### INVALID
Opposite price structure, or a combined opposite EMA + DI + ROC + MACD state.

Action:
- mark invalid only after the current candle has closed
- exit on the NEXT candle open
- never use the same candle close as a fantasy fill

## Causality

Closed-bar indicator state can only affect:
1. the trailing stop used on the next bar, or
2. a next-open invalidation exit.

Future/unclosed bars are rejected by the canonical Market Features V2 owner before Move Hunter sees the evidence.

## Portfolio support

The account replay accepts per-symbol indicator-control timelines and passes them into the same Runner engine.

Portfolio limits remain:
- 0.5% risk/trade by default
- 2% aggregate initial risk
- max 5 positions
- 20% symbol cap
- 40% theme cap
- 100% gross exposure
- no margin/short in the cash replay
- no real fills / no live authority

## Current evidence boundary

The fixed Runner policies already have archived observed-history evidence. The Indicator-Adaptive Runner does NOT yet.

It must not replace LONG_RUNNER_3ATR / DELAYED_BE_TRAIL as a preferred policy until:
- canonical indicator timelines are available for the exact historical/forward dataset,
- the same frozen state policy is replayed without tuning,
- account-level return/PF/MDD/capture/giveback/concentration are compared,
- genuinely unused chronological OOS or Forward evidence is collected.

No automatic promotion, Paper activation, live trading, order authority, or profitability claim is granted by this module.
