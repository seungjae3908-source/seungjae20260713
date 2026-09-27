# Current genuine Forward readiness — 2026-09-27

Read-only inspection only. Existing Forward runtime/services/schedules were not modified or dispatched.

## Latest Forward Recommendation Observer

- Run: 36205192010
- conclusion: SUCCESS
- source SHA: 84fb0cc86e71bbd13274b80c8af927511b79b482
- artifact: 10893552862
- artifact digest: sha256:548ea4deba35388991fcff41dc922b58dbd5bd931a9c11296b5a37064a4223bd
- current main at inspection: 183ca1b2eb0bc2e7b27784623bdd9b51f3240d47

The Observer artifact is therefore not an exact-current-main run.

## Actual observation truth

state.json:
- observations: 0

summary.json:
- total: 0
- pending: 0
- settled: 0
- createdThisCycle: 0
- settledThisCycle: 0

Lane detail:

### KR_SWING_60M
- scannerOutcome: VALID_ZERO_SIGNAL
- scannedCards: 0
- readyObservations: 0

### US_SWING_60M
- scannerOutcome: VALID_ZERO_SIGNAL
- scannedCards: 0
- readyObservations: 0

### SPOT_SWING_60M
- scannerOutcome: CANDIDATES_AVAILABLE
- scannedCards: 3
- readyObservations: 0
- blocked: 3
- blocker: CANONICAL_PAPER_CANDIDATE_REQUIRED = 3

### FUTURES_SWING_60M
- scannerOutcome: CANDIDATES_AVAILABLE
- scannedCards: 10
- readyObservations: 0
- noTrade: 10
- blocker classification: SCANNER_GRADE_NOT_FORWARD_OBSERVABLE = 10

## Momentum Guard consequence

`forward-momentum-guard.mjs` is ready to consume genuine `ForwardRecommendationObservation` records, but there are currently no observations to classify.

Therefore:
- genuine Forward Momentum Guard N = 0
- no eligible/ineligible Forward comparison exists
- no Forward performance conclusion
- no OOS credit
- no profitability credit
- no promotion/adoption

## Evidence separation

Current-main `Public Forward Liquidity Successor Scheduled Capture` runs exist and are successful, but they are a different evidence contract. They are NOT silently converted into Forward Recommendation Observations and receive zero Momentum Guard Forward credit in this lane.

## Next evidence boundary

The next valid evidence event is a genuine existing-owner Forward Recommendation Observer artifact that contains one or more identity-valid observations. Momentum Guard evaluation must bind the feature snapshot to the exact observation:
- strategy/version/parameter/research SHA
- market/symbol/timeframe/direction
- exact decision timestamp

No separate Forward schedule or duplicate observer is introduced by Move Hunter.


## Structural FIRST_ZERO diagnosis

Current-main source audit reveals two code-contract bottlenecks that explain why genuine Forward observations remain at N=0.

### 1. Scanner grade path does not receive backtest evidence

Current crypto Forward lane:
`api-server/src/scripts/run-forward-recommendation-observer-cycle.ts::scanCryptoLane()`

calls:
`rankScannerCandidates({ cards, market, strategy, limit })`

without a `backtests` map.

Current stock Scanner ranking call also omits `backtests`.

But:
`scanner-candidate-ranking.service.ts::gradeCandidate()`

returns `B` immediately when backtest evidence is absent or fails minimum quality.

Forward Recommendation Observer accepts only signalGrade S/A.

Therefore the current source graph makes S/A structurally unreachable through these ranking calls unless the ranking input is wired to verified backtest/OOS evidence.

This does NOT justify fabricating or bypassing OOS/Walk-forward evidence.

### 2. CRYPTO_SPOT SWING timeframe identity conflict

Current canonical Scanner profile:
- CRYPTO_SPOT SWING primary timeframe = 4H

Current Forward Observer lane:
- SPOT_SWING_60M timeframe = 60m

`forward-observer-canonical-metadata.service.ts` requires:
`identity.timeframe === lane.timeframe`

and otherwise emits:
`PROMOTION_TIMEFRAME_MISMATCH`.

Thus Spot paperCandidate cannot be canonically attached on the current 60m lane while the canonical Spot SWING profile remains 4H.

No value is silently rewritten.

## Safe repair boundary

These are existing Scanner/Forward owner issues, not Move Hunter Runner issues.

Potential repairs require a separate owner/approval because they touch active product lanes:

A. Wire the existing verified scanner backtest metrics into candidate ranking without weakening any S/A quality gate.

B. Resolve Spot timeframe identity by one explicit canonical choice:
- preserve Spot SWING=4H and align the Forward Spot lane to 4H, or
- create/approve a genuine 60m Spot SWING canonical profile with its own OOS/Walk-forward/cost evidence.

Move Hunter #1407 does not perform either mutation.
