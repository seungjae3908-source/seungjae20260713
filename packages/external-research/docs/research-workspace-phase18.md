# Phase18 bounded canonical evaluation execution contract

Phase18 development adds the admission contract for the first real canonical research evaluation. This Draft does **not** execute the compiler or backtester.

A valid request is bound to the exact current SHA, Phase16 human decision digest, Phase17 config digest, the exact Phase17 readiness receipt digest, and an independently produced current-main runtime dependency proof. The Phase16 decision and full Phase17 config are revalidated at contract-check time.

The Phase17 receipt must be no older than 10 minutes, match the exact manifest/package/reviewed-rule/config/decision identities, and still carry zero provider/compiler/backtest authority. An old READY receipt cannot be revived merely because the human decision has not expired yet.

The current-main runtime proof must independently verify these implementation paths and identities:
- #550 bounded formula compiler: `market-prediction-lab/src/autonomous-strategy-formula-generator-v1.js`
- #690 execution-equivalent canonical backtester: `market-prediction-lab/src/independent-strategy-backtest.js`
- #547 canonical statistical firewall: `market-prediction-lab/src/global-strategy-statistical-firewall-v1.js`
- #547 → #551 tournament adapter: `market-prediction-lab/src/research-tournament-statistical-firewall-adapter-v1.js`

Every dependency row is exact-SHA bound and carries the Git blob identity. A configured owner reference is not sufficient when its implementation is absent from the exact current SHA. Missing #547 core must return `CANONICAL_STATISTICAL_FIREWALL_NOT_PRESENT_ON_CURRENT_SHA`; missing the #547→#551 adapter must return `TOURNAMENT_STATISTICAL_FIREWALL_ADAPTER_NOT_PRESENT_ON_CURRENT_SHA`. Both keep compilerRuns=0 and backtestRuns=0.

The contract permits at most one bounded compiler run through owner #550 and one execution-equivalent canonical backtest run through owner #690. The #547 statistical firewall is mandatory and cannot be bypassed. Arbitrary executable code remains forbidden.

Final Holdout is locked until the final stage after selection freeze. It cannot feed the generator or selection loop. The one-shot reservation identity binds evaluation ID + exact source SHA + human-decision digest + canonical config digest + Phase17 receipt digest + runtime proof digest. Replay is forbidden.

Any future successful execution may produce only `RESEARCH_EVIDENCE_ONLY`. It cannot automatically adopt a strategy, activate Paper, activate live trading, claim profitability, grant private API authority, or create execution authority.

This Phase18 Draft is contract-only: compilerRuns=0 and backtestRuns=0 in validation. The later operational executor must generate the runtime proof from the exact deployed/current-main tree rather than trusting request JSON, consume the reservation with an exclusive immutable record before any compiler call, and preserve every Phase17 dataset identity and no-feedback constraint.
