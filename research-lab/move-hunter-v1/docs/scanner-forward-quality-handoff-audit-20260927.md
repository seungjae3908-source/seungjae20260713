# Scanner S/A → Forward structural handoff audit — 2026-09-27

## Current FIRST_ZERO

`SCANNER_RANKING_CANONICAL_BACKTEST_QUALITY_PRODUCER_MISSING_OR_UNWIRED`

This is a source-graph diagnosis, not a profitability verdict.

## What Scanner S/A actually requires

`scanner-candidate-ranking.service.ts::passesMinimumBacktestQuality()` requires one per-symbol `ScannerBacktestQualitySummary` with all of the following:

- status = verified
- tradeCount >= minimumTradeCount
- expectancyPercent > 0
- profitFactor >= 1.05
- |maxDrawdownPercent| <= 25
- netReturnPercent > 0
- costsIncluded = true
- slippageIncluded = true
- lookaheadGuarded = true
- survivorshipGuarded = true
- oos = true
- walkForward = true

S grade additionally requires strong signal, trusted/actionable data, score >= 88 and risk <= 35.
A grade requires trusted/actionable data, score >= 72 and risk <= 50.

No missing field is allowed to become an optimistic default.

## Current runtime gap

### Crypto Forward lane

`run-forward-recommendation-observer-cycle.ts::scanCryptoLane()` calls `rankScannerCandidates()` without a `backtests` map.

The ranking owner returns B when backtest evidence is missing.

Forward Recommendation Observer accepts only S/A.

Therefore the current path is structurally fail-closed at B unless genuine verified backtest quality is wired.

### Stock Scanner

The current stock ranking call also omits a `backtests` map, so the same grade constraint exists there.

## Existing owners that are NOT sufficient by themselves

### api-server Backtest Engine

`api-server/src/services/backtest-engine.service.ts`:
- supports crypto-futures only
- hard maximum duration = 366 days
- cannot be relabeled as all-four-market Scanner quality

### scanner-backtest-metrics.service.ts

This is a calculator from already-produced trade outcomes.
It explicitly does not establish OOS admission/provenance/full-cost authority.
It must not mint `status=verified`.

### multi-market-backtest-engine.js

Useful canonical building block:
- supports all four markets
- execution-aware cost model
- next-candle entry
- stop-first ambiguity policy
- development / validation / locked final-holdout chronology

But its own result contract does not establish:
- Scanner-specific `oos=true`
- Scanner-specific `walkForward=true`
- survivorshipGuarded=true

So it cannot be directly converted to Scanner S/A without additional canonical evidence.

### walk-forward.js

Provides leakage-purged train/validation/test splitting using future-end timestamps.
It is a split owner, not a complete Scanner quality producer.

### stock-universe-bias-audit.js

Provides point-in-time membership / removed-name coverage for KR/US stocks.
It is required for stock survivorship protection but does not cover crypto and is not a complete Scanner quality packet.

### Strategy Promotion Center

Current source registry states:
- BACKTEST_ENGINE = AVAILABLE only after exact identity linkage
- PREDICTION_LAB = UNLINKED

Therefore Promotion Center currently cannot be treated as the missing Scanner-quality bridge either.

## Safe canonical bridge requirements

A future active-lane owner may emit a Scanner quality record only when it binds the exact:

- scanner strategyProfileId / strategyVersion
- parameterHash
- researchCodeSha
- market
- symbol
- horizon
- timeframe
- direction
- immutable dataset identity

and proves:

1. execution-aware backtest with measured/documented costs;
2. independent/purged OOS chronology;
3. walk-forward evidence;
4. lookahead guard;
5. PIT/survivorship guard where applicable;
6. trade/sample counts and metrics from the same identity;
7. no final-holdout selection leakage;
8. no replay/backfill result promoted as prospective evidence.

Only then may it populate the `backtests[symbol]` map consumed by `rankScannerCandidates()`.

## Spot separate blocker

Even if the S/A quality bridge is solved, Spot remains independently blocked:

- canonical CRYPTO_SPOT SWING primary timeframe = 4H
- Forward Spot lane = 60m
- Forward metadata requires exact timeframe equality

This is a distinct identity problem and must not be hidden by the backtest-quality repair.

## Move Hunter boundary

PR #1407:
- diagnoses these owners read-only,
- does not mutate Scanner ranking,
- does not mutate Forward Observer,
- does not alter canonical profiles,
- does not activate schedules,
- does not lower any S/A threshold,
- grants zero economic sample credit and zero execution authority.


## Direction-aware quality selection

Current `ScannerCandidateRankingInput.backtests` is keyed only by symbol:

`Record<string, ScannerBacktestQualitySummary>`

This is insufficient as a storage identity for CRYPTO_FUTURES because LONG and SHORT quality for the same symbol are different evidence.

Safe minimal future wiring:

1. store verified quality packets under an exact identity that includes direction;
2. for the current Scanner request, select the packet matching each card's exact direction/profile/dataset;
3. only then project to the existing symbol-keyed `backtests` map;
4. if one request contains both LONG and SHORT cards for the same symbol, fail closed instead of projecting.

#1407 implements this safety rule in:
- `src/scanner-quality-index.mjs`
- `test/scanner-quality-index.test.mjs`

This permits a minimal active repair without weakening the current ranking gate or borrowing opposite-side quality.
