# Phase14 reviewed provider one-shot execution workflow

Phase14 adds the operator entrypoint for the already-developed Phase12 reviewed one-shot. The workflow is inert on pull requests except for contract validation. A real provider call can happen only after the workflow is merged to main and the repository owner posts the exact execution command on the canonical Central Hub.

The execution gate requires:
- exact current main SHA and coherent Required CI 6/6,
- no active Production deployment,
- a GitHub Actions bot Phase13 receipt from the same SHA that is no more than 20 minutes old,
- Phase13 status READY_FOR_REVIEWED_ONE_SHOT,
- exact Production deploy identity, safe trading flags and executionAuthority NONE,
- the existing server-private root and reviewed source/spec/manifest/Gemini approval/Groq approval files.

The workflow does not mint or edit approvals. It compiles the existing Phase12 runner from the exact deployed source, performs the one-shot once against the existing private root, and emits only a sanitized execution receipt. Provider call counts are bounded to Gemini <=1 and Groq <=1.

Expected terminal state is REVIEW_REQUIRED. Compiler, backtester and automatic adoption are always false. BLOCKED or BLOCKED_UNCERTAIN is a workflow failure and explicitly requires operator review with no blind retry. Raw provider evidence remains server-private; secrets and private paths are not emitted to GitHub artifacts or comments.

No schedule, workflow_dispatch, PM2 restart/reload/save, systemd mutation, trading authority, Paper activation, Telegram mutation, or order path is added.


Runtime hardening:
- The executable one-shot bundle is built on the GitHub runner from exact current main, hashed, copied only to a temporary Production path, hash-verified on the server, and deleted after the run. Production does not need pnpm/esbuild or a mutable source build step.
- Gemini/Groq credentials and the explicit Groq model are resolved from the single online PM2 stock-app environment only inside Production. Secret values are never returned to the Actions runner; only canonical provider values are passed in-memory to the temporary child process.
- The temporary child receives explicit false trading flags and executionAuthority NONE.
- A REVIEW_REQUIRED result is considered the expected success only when reason=HUMAN_RULE_DIGEST_REVIEW_REQUIRED, both provider calls are exactly one, packageDigest and reviewedRuleDigestCandidate are valid SHA-256 values, and automatic compiler/backtest/adoption are false.
- Gemini insufficient evidence is reported separately as SOURCE_EVIDENCE_REVIEW_NO_RETRY with Gemini=1, Groq=0 and no package digest. It is not treated as successful rule-digest review and must not be blindly retried.
