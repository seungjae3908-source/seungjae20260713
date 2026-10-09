# Spot Forward 4H alignment plan — 2026-09-27

## Decision target

Preserve the existing canonical strategy definition:

- CRYPTO_SPOT / SWING primary timeframe = 4H

and align the Forward Recommendation Observer Spot lane to that identity.

Do NOT silently create a new 60m Spot SWING strategy.

## Why this is the lower-semantic-change path

Existing runtime capability already supports 4H:

- `scannerStrategyTimeframeAllowed('swing','4H') = true`
- Crypto scanner `CryptoTimeframe` includes `4H`
- Upbit spot candle path maps `4H -> /v1/candles/minutes/240`
- Upbit historical owner already collects `minutes/240`

The current mismatch is therefore an Observer lane identity problem, not a provider capability gap.

## Current conflicting contracts

Canonical Scanner:
- CRYPTO_SPOT SWING = 4H

Forward Observer:
- SPOT_SWING_60M
- lane timeframe = 60m
- crypto scan hardcodes `timeframe: '60m'`
- spot settlement fetch hardcodes `candles/minutes/60`
- coverage currently claims SWING 60m only

Forward metadata:
- promotion identity timeframe must exactly equal lane timeframe
- current result: `PROMOTION_TIMEFRAME_MISMATCH`

## Minimal active-lane patch when separately approved

### 1. forward-recommendation-observer-runtime.service.ts

Change lane timeframe from one global constant to per-lane canonical values:

- KR_STOCK SWING -> 60m
- US_STOCK SWING -> 60m
- CRYPTO_SPOT SWING -> 4H
- CRYPTO_FUTURES SWING -> 60m

Recommended lane ID:
- rename `SPOT_SWING_60M` -> `SPOT_SWING_4H`

Do not keep a misleading 60M ID with a 4H payload.

Coverage should report actual unique timeframes:
- ['60m','4H']

and continue:
- strategies=['SWING']
- fullStrategyCoverage=false

### 2. run-forward-recommendation-observer-cycle.ts

`scanCryptoLane()`:
- use `lane.timeframe`
- do not hardcode 60m

Future bars:
- Spot 60m path must become timeframe-aware
- Spot 4H -> Upbit `minutes/240`
- Futures stays 1H for its 60m lane
- outcome bars must preserve exact observation identity timeframe

### 3. forward-observer-canonical-metadata.service.ts

Allow the lane timeframe union needed by canonical lanes:
- 60m
- 4H

Keep exact-match enforcement:
`identity.timeframe === lane.timeframe`

Do not weaken the check.

### 4. tests

Required:
- Spot 4H canonical promotion attaches paperCandidate
- Spot 60m promotion mismatch still fails closed
- KR/US/Futures 60m behavior unchanged
- state cursor validation uses the new Spot lane ID
- coverage lists both 60m and 4H
- future-bar source for Spot uses 240-minute candles
- no cross-SHA predecessor state mixing
- no private API/order authority

### 5. workflow summary

Replace the inaccurate:
`SWING 60m only`

with exact lane coverage:
`KR/US/Futures SWING 60m + Upbit Spot SWING 4H`

Safety envelope stays unchanged.

## State migration

Forward Observer artifacts are immutable and research-SHA scoped.

A code change produces a new research SHA, so the new lane schema must not reinterpret an old `SPOT_SWING_60M` cursor as 4H history.

Expected behavior:
- new SHA -> clean new state when no exact-SHA predecessor exists
- old artifact remains historical evidence only
- zero cross-credit
- no cursor conversion unless a separately versioned migration is explicitly designed

## Files expected to change in a future active-lane repair

Core:
1. `api-server/src/services/forward-recommendation-observer-runtime.service.ts`
2. `api-server/src/scripts/run-forward-recommendation-observer-cycle.ts`
3. `api-server/src/services/forward-observer-canonical-metadata.service.ts`

Tests:
4. `api-server/src/services/forward-recommendation-observer-runtime.service.test.ts`
5. `api-server/src/services/forward-observer-canonical-metadata.service.test.ts`

Workflow/reporting:
6. `.github/workflows/forward-recommendation-observer-cycle.yml`

Potential downstream contract checks must be re-run, but no Scanner strategy profile change is required.

## Out of scope for #1407

This document does not mutate any of those active files.

PR #1407 remains:
- research-only
- Draft
- no schedule dispatch
- no Staging/Production
- no Paper activation
- no live/private/order authority
