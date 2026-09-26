# Phase18 bounded canonical evaluation execution contract

Phase18 development adds the admission contract for the first real canonical research evaluation. This Draft does **not** execute the compiler or backtester.

A valid request must be bound to the exact current SHA, Phase16 human decision digest, Phase17 config digest, and a fresh Phase17 `READY_FOR_CANONICAL_EVALUATION_ONE_SHOT` receipt. The Phase16 decision and full Phase17 config are revalidated at contract-check time so a stale or expired decision cannot be revived by an older READY receipt.

The contract permits at most one bounded compiler run through owner #550 and one execution-equivalent canonical backtest run through owner #690. The #547 statistical firewall is mandatory and cannot be bypassed. Arbitrary executable code remains forbidden.

Final Holdout is locked until the final stage after selection freeze. It cannot feed the generator or selection loop. The one-shot reservation identity binds evaluation ID + exact source SHA + human-decision digest + canonical config digest, and replay is forbidden.

Any future successful execution may produce only `RESEARCH_EVIDENCE_ONLY`. It cannot automatically adopt a strategy, activate Paper, activate live trading, claim profitability, grant private API authority, or create execution authority.

This Phase18 Draft is contract-only: compilerRuns=0 and backtestRuns=0 in validation. The later operational executor must consume this exact contract without widening maxCompilerRuns=1 or maxBacktestRuns=1 and must preserve all Phase17 dataset identities and no-feedback constraints.
