# Agent Hub schema v2 integration

This document describes the proposed Agent Hub behavior on Draft PR #70. It does not describe the currently deployed `main` behavior until the PR is separately approved and merged.

## Real execution boundary

Agent Hub does not remotely control ChatGPT conversations or independent chat rooms. A worker ID is a logical GitHub role. The actual transport is:

1. a trusted Issue #62 comment containing `[WORKER_REPORT]` schema v2;
2. deterministic report validation and evidence compilation;
3. an optional Gemini Developer API free-tier proposal;
4. deterministic Python policy and worker-registry enforcement;
5. a schema-v2 `[HUB_COMMAND]` comment;
6. `repository_dispatch` to a constrained GitHub Actions executor only for `status: ready`;
7. an isolated `agent/hub-*` branch and Draft PR for a validated code change;
8. a schema-v2 executor report back to Issue #62.

The executor cannot merge, deploy, change servers or databases, access live accounts, or place/cancel live orders.

## Integration ownership

PR #70 remains the integration base:

- deterministic action table;
- worker registry;
- command identity and expiry;
- stale, duplicate, running, retry, and scope gates;
- constrained executor and Draft PR behavior.

PR #71 is reused as the design source for:

- five prompt blocks: `[ROLE]`, `[GOAL]`, `[EVIDENCE]`, `[CONSTRAINTS]`, `[OUTPUT_SCHEMA]`;
- evidence IDs;
- duplicate/noise compression;
- first and final error preservation;
- file, line, HEAD, CI Run, Job, PR, and changed-file evidence;
- prompt-injection isolation;
- deterministic `needs_context` and `no_action` paths with zero model calls;
- independent proposal agreement for code-fix planning.

Gemini never decides status, risk, permission, approval, expiry, retries, branch or path authority, merge, deployment, or live-order authority.

## Registered workers

| Worker | Owns | Automatic code scope | Prohibited ownership |
|---|---|---|---|
| `ai-signal-scanner` | stock and crypto scanners, signals, completeness, alerts | scanner-specific source/tests/docs | orders, accounts, positions, trade execution |
| `approved-order-trading` | approved and paper order lifecycle, risk, idempotency | trade/order-specific source/tests/docs | scanner scoring, information room, chart engine, unapproved live orders |
| `market-information-room` | search, detail, news, disclosures, financial and flow information | information/search-specific source/tests/docs | scanner engine, chart engine, order system |
| `ai-chart` | candles, indicators, patterns, live chart state and windows | chart-specific source/tests/docs | scanner universe, information schema, accounts and orders |
| `test-runner` | typecheck, build, unit/integration/Playwright/security tests | tests only | product behavior changes or test relaxation |
| `integration-planner` | PR conflict and ownership plans | normal integration documentation only | merge, rebase, cherry-pick, Draft-ready, deployment |
| `security-inspector` | secrets, permissions, outbound and order-like API review | read-only | code mutation |
| `operations-worker` | separately approved read-only operational evidence | none automatically | SSH mutation, restart, PM2/Caddy, deploy, cleanup, DB/Supabase |
| `agent-hub-validation` | policy, schema, compiler, registry and executor review | none through the automatic executor | Agent Hub self-modification |

Agent Hub files remain globally prohibited to the automatic executor. Changes to policy, workflows, registry, compiler, or executor are made only in a human-reviewable Agent Hub Draft PR.

## Worker report schema v2

Required fields:

```text
[WORKER_REPORT]
schema_version: 2
task_id:
worker:
repository:
base_branch: main
base_sha:
branch:
status: completed | partial | blocked | failed | waiting_approval
head_sha:
pr_number:
changed_files:
checks:
ci_run_id:
summary:
remaining:
dependencies:
conflicts:
approval_required: yes | no
prohibited_actions_confirmed:
```

Missing fields, unknown workers, invalid SHAs, invalid CI Run IDs, default-branch work, or a failure to affirm prohibited-action separation returns `needs_context` or `blocked` without a Gemini call.

Completed reports require an actual 40-character HEAD and numeric CI Run. Human-authored completed reports must match the workflow run HEAD. Bot executor reports verify the workflow conclusion and separately verify the reported branch HEAD because repository-dispatch workflow runs are attached to `main`.

## Hub command schema v2

The command includes all required schema-v2 fields plus compatibility aliases consumed by the existing PR #70 executor. Compatibility aliases do not broaden authority.

Statuses:

- `needs_context`
- `ready`
- `waiting`
- `waiting_approval`
- `blocked`
- `stale`
- `expired`
- `superseded`
- `no_action`

Risk values:

- `low`
- `medium`
- `high`
- `prohibited`

Only `status: ready`, `risk_level: low`, and `execution_mode: read_only | code_change` can reach the executor.

## Prompt profiles

- `ci_analyzer`
- `code_fix_planner`
- `test_planner`
- `conflict_analyzer`
- `security_reviewer`
- `release_validator`
- `ui_reviewer`
- `scanner_reviewer`
- `trading_safety_reviewer`
- `chart_reviewer`
- `information_reviewer`
- `agent_hub_reviewer`

Profile-required evidence is checked before a model call. Unknown evidence IDs are rejected. Prompt-like instructions found in a worker report remain quoted untrusted evidence.

## Competition and lifecycle

- exactly one result per report comment marker;
- duplicate task and deterministic command identity tracking;
- exact branch HEAD verification before planning and again before execution;
- worker-level running lock;
- open-PR changed-file ownership lock for code changes;
- thirty-minute command expiry;
- superseded command tracking;
- one automatic retry maximum (`max_attempts: 2` including the first attempt);
- repeated failure moves to user approval;
- maximum three automatic continuation steps;
- automatic continuation stops after a Draft PR is created;
- old schema-v1 commands cannot pass schema-v2 validation.

Manual `workflow_dispatch` runs self-tests only and cannot consume a real pending Issue command. Scheduled runs remain the recovery mechanism. The executor no longer wakes the coordinator before its own workflow run has finished; the next scheduled coordinator run verifies the completed CI record.

## Model and data safety

- provider: `gemini-developer-api-free`;
- model: `gemini-3.1-flash-lite`;
- paid fallback: disabled;
- HTTP 429: immediate fail-closed;
- HTTP 502/503/504: at most one transient retry;
- all other errors: no automatic retry;
- secret-like input: model call count zero;
- email, phone, account number, order ID, and resident-ID-shaped values are redacted before compilation;
- actual account, balance, position, live-order, or external-AI-sensitive data is prohibited.

## Executor limits

- isolated `agent/hub-*` branch;
- one commit maximum;
- Draft PR only;
- per-worker file limit, never above twelve;
- 1,200 changed-line hard limit;
- delete, rename, copy, binary, symlink, non-UTF8, Secret, forbidden path, manifest, lockfile, workflow, policy, migration, auth, permission, operations, deployment, and generated-artifact changes blocked;
- read-only task requires a zero diff;
- Gemini receives no shell, web search, MCP, extensions, or network access;
- deterministic typechecks and API smoke run before a code-change commit and push;
- validation failure produces no commit, push, or Draft PR.

## Current integration limitation

PR #70 and PR #71 were created from different histories and are not merged or rebased here. This integration is added to PR #70 without merge, rebase, or cherry-pick. PR #71 remains open as comparison evidence. Latest-main compatibility must be proven by a new PR synthetic-merge Application CI run before any future Ready or merge request.
