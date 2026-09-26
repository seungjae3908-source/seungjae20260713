# Phase16 human rule-digest binding

Phase16 turns the Phase15 read-only human review into an explicit, narrow research-evaluation binding. It does not run providers, compiler, backtester, Paper, trading, or adoption.

The repository owner must post an exact command on the canonical Central Hub after this workflow is merged to main:

`/research-workspace-one-shot-bind-for-research <current-main-sha> <manifest-digest> <package-digest> <reviewed-rule-digest>`

The workflow requires:
- exact current main and Required CI 6/6,
- no active Production deployment,
- a matching GitHub Actions bot Phase14 REVIEW_REQUIRED receipt from the same SHA and exact three digests,
- Gemini=1 / Groq=1 and HUMAN_RULE_DIGEST_REVIEW,
- Production PM2 stock-app online on the exact SHA,
- all trading/order authority disabled,
- the server-private Phase15 review to recompute the same immutable package and rule digest.

Binding is allowed only when Groq disposition is CONTINUE, missingRuleKinds is empty, and all required rule kinds (ENTRY, EXIT, STOP_LOSS, POSITION_SIZING, EXECUTION_ASSUMPTION) are present and ACCEPT_AS_CLAIM. CONTEXT observations do not grant or block the research-evaluation binding.

The human command explicitly acknowledges that source truth and whole-video truth are not verified, AI agreement is not profitability evidence, the binding is research-only, and automatic adoption is forbidden.

The only server mutation is an O_EXCL 0600 file named `human-rule-digest-decision-v16.json`. Existing files are never overwritten. The binding expires after 30 minutes and permits at most one later `CANONICAL_RESEARCH_EVALUATION_ONE_SHOT`.

The Phase16 receipt fixes providerCalls=0, compilerRuns=0, backtestRuns=0, automaticAdoption=false, profitabilityProven=false, executionAuthority=NONE. The next phase must separately validate and consume the binding; Phase16 itself cannot start canonical evaluation.
