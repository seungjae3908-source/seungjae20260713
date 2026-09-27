# Current Scanner quality evidence readiness — 2026-09-27

## Verdict

Strict producer-ready markets: **0 / 4**

This is a current evidence-readiness result, not a strategy profitability verdict.

The quality producer requires one exact strategy/symbol/timeframe/direction identity to bind all of:
1. immutable datasetSnapshotHash;
2. eligible historical dataset audit;
3. leak-free purged OOS + Walk-forward folds;
4. exact fold-window backtest results with actual trade rows;
5. canonical 8-component transaction-cost evidence;
6. stock PIT / removed-name universe audit for KR/US.

No missing evidence is converted to zero, current values, aggregate summaries, replay credit, or another candidate's evidence.

## KR_STOCK — BLOCKED

Evidence present in code:
- four-market backtest engine supports KR_STOCK;
- purged walk-forward owner exists;
- stock point-in-time universe bias audit owner exists;
- Dataset Snapshot owner exists;
- Scanner eight-component cost adapter exists.

Current missing exact artifact chain:
- no repository-persisted immutable dataset snapshot manifest for an exact KR Scanner profile/symbol was found;
- no exact KR per-symbol purged OOS/WF fold result packet with actual trade rows was found;
- no current exact KR stock PIT removed-name audit artifact was found;
- canonical economic truth still reports FULL_COST_READY=false.

FIRST_ZERO:
`KR_SCANNER_EXACT_DATASET_AND_OOS_WF_PACKET_MISSING`

## US_STOCK — BLOCKED

Same owner capabilities exist as KR_STOCK.

Current missing exact artifact chain:
- no repository-persisted immutable exact US Scanner dataset snapshot manifest found;
- no exact US per-symbol purged OOS/WF trade packet found;
- no current exact US PIT removed-name audit artifact found;
- Full Cost is not currently proven READY.

FIRST_ZERO:
`US_SCANNER_EXACT_DATASET_AND_OOS_WF_PACKET_MISSING`

## CRYPTO_SPOT — BLOCKED

Evidence actually present:
- Long-History V1–V6 contains observed historical CRYPTO_SPOT research for BTC/ETH;
- Upbit 4H historical collection exists;
- #1408 fixes the Forward Spot identity to canonical SWING 4H in a validated Draft.

Why this still cannot become Scanner quality:
- Long-History docs are development/validation optimization summaries, not the producer's exact purged-fold packet;
- committed Long-History results do not bind the Scanner strategy identity to datasetSnapshotHash;
- no exact consumer-compatible per-symbol OOS/WF trade bundle is persisted;
- canonical 8-component transaction-cost evidence is not proven READY as one exact identity packet;
- final holdout is explicitly not used for selection and must not be borrowed as Forward/OOS credit.

FIRST_ZERO:
`SPOT_SCANNER_EXACT_PURGED_OOS_WF_IDENTITY_PACKET_MISSING`

## CRYPTO_FUTURES — BLOCKED

Evidence actually present:
- Long-History includes BTCUSDT/ETHUSDT LONG/SHORT research;
- fixed public BTCUSDT 15m backtester-path evidence producer exists;
- public funding/archive owners exist;
- multi-market backtest engine supports LONG/SHORT with execution-aware costs.

Why this still cannot become Scanner quality:
- fixed backtester-path evidence is trade-path evidence, not exact Scanner OOS/WF quality;
- its own contract preserves missing entry/exit contribution evidence and profitabilityProven=false;
- Long-History optimization summaries are not exact purged-fold result packets;
- no exact datasetSnapshotHash + Scanner Promotion identity binding for those results was found;
- canonical Full Cost economic truth remains not proven READY;
- LONG and SHORT quality must remain direction-specific.

FIRST_ZERO:
`FUTURES_SCANNER_EXACT_OOS_WF_COST_IDENTITY_PACKET_MISSING`

## Cross-check against current economic truth

Recent canonical Hub reports continue to preserve:
- FULL_COST_READY=false
- EVIDENCE_COMPLETE=0
- PROFITABILITY_PROVEN=false
- profitability credit=0
- executionAuthority=NONE

A separate Research adoption artifact reported OOS N=99 / Walk-Forward N=99 but also:
- allInCostComplete=false
- admissionGrade=false
- Final Holdout N=0

That evidence is not silently transferred into a Scanner strategy identity.

## What can be done now

The code chain is now prepared in Drafts:
- #1408: Spot Forward 4H identity repair
- #1410: immutable exact quality artifact consumer
- #1411: fail-closed quality artifact producer

The next genuine evidence work is not another score/threshold change. It is to materialize real producer inputs from canonical owners, beginning with one exact market/symbol/profile, then expand only after it passes.

Recommended first proving lane:
- CRYPTO_FUTURES BTCUSDT LONG, because existing historical OHLCV/funding/backtester-path owners are strongest there;
- still requires a genuine dataset snapshot binding, purged OOS/WF fold result packet, and complete canonical 8-component cost evidence before the producer may emit quality status=verified.

No quality.json is materialized from current evidence in this audit because doing so would require inventing or cross-crediting missing evidence.
