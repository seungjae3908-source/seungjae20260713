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
