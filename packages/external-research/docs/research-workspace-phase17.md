# Phase17 canonical evaluation readiness

Phase17 is a read-only preflight for the one canonical research evaluation permitted by Phase16. It does not consume the Phase16 binding and it does not run providers, compiler, backtester, Paper, trading or adoption.

A server-private fixed file named canonical-evaluation-config-v17.json must bind the exact current source SHA and the Phase15/16 manifest, package and reviewed-rule digests. It must also carry reviewed market/side/timeframe scope, cross-validation evidence identities, canonical-core and formula/tournament policy identities, frozen TRAIN/OOS/PURGED_OOS/WALK_FORWARD/COST_STRESS/REGIME_STRESS/FINAL_HOLDOUT dataset identities, and exact existing-owner runtime bindings.

Required existing-owner bindings are #551 stage checkpoint/resume, #821/#833 authentic canonical bundle source, #550 bounded formula compiler, #690 execution-equivalent canonical backtester, and #547 statistical firewall. All bindings are non-activating, non-deploying, deny final-holdout pre-access, arbitrary executable code, profitability claims and execution authority.

READY_FOR_CANONICAL_EVALUATION_ONE_SHOT is possible only while the Phase16 human binding is still valid. Missing or stale evidence returns BLOCKED with compilerRuns=0 and backtestRuns=0. A READY result is not the evaluation itself; actual one-shot consumption is a separate Phase18 boundary.
