# Strategy Hypothesis Foundation

`StrategyHypothesisV1` turns validated `ResearchPaperV2` records into an immutable, falsifiable research-hypothesis contract. It does **not** produce entry/exit rules, executable strategies, backtest outcomes, profitability claims, promotion decisions, trading authority, or orders.

## Trust boundary

- Every referenced paper is validated by the merged `ResearchPaperV2` validator and pinned by `paperId` plus `metadataHash`.
- `hypothesisId` is derived from canonical hypothesis configuration, never from a paper ID. Evidence can be added without changing the hypothesis identity.
- `familyFingerprint` is only a similarity-candidate signal. A collision never authorizes automatic identity, dedupe, or merge.
- Falsification requires an observable, metric, operator, threshold, evaluation window, minimum observation count, and explicit rejection statement.
- Missing, tampered, unknown-license (when required), unresolved-correction, retracted, or strongly contradictory evidence cannot produce `APPROVE_FOR_RESEARCH`.

## Decision semantics

`HypothesisDecisionV1` is a separate immutable record. Its only verdicts are:

- `APPROVE_FOR_RESEARCH`
- `REJECT`
- `MISSING_EVIDENCE`
- `CONFLICTED`

`APPROVE_FOR_RESEARCH` means only that the hypothesis may proceed to further research. Every decision fixes `executableStrategyCreated` to `false` and `tradingAuthority` to `NONE`.
