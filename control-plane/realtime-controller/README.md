# Realtime Persistent Controller v1

Status: **repository implementation only — runtime activation not yet proven**.

This service is the persistent, event-driven wrapper around the repository's existing Agent Hub. It does **not** keep a web ChatGPT conversation alive and does not replace the existing coordinator, executor, policy, or worker registry.

## Existing infrastructure reused

- Central Hub / human-readable SSOT: GitHub Issue `#660`.
- Release control: Issue `#23` remains separate.
- Existing deterministic policy/worker registry: `.github/agent-hub/policy.json`, `.github/agent-hub/workers.json`.
- Existing coordinator: `.github/workflows/agent-hub-free.yml`.
- Existing bounded AI executor: `.github/workflows/agent-hub-executor.yml` using the repository's configured free Gemini runner.
- Existing compact state helper remains part of the Agent Hub control plane: `scripts/agent_hub_state_v2.py`.
- Existing server diagnostics prove PM2 is already the server process supervisor. A second supervisor must not be introduced without a new evidence-backed decision.

The active `REALTIME-CONTROLLER-01` lease currently lists a systemd service path. Discovery performed after that lease proved PM2 is the existing supervisor. Therefore v1 intentionally does **not** add or activate a systemd unit. A PM2 definition/activation must use an amended lease/path and explicit server-activation authority.

## Runtime architecture

```text
GitHub webhook
   -> HMAC SHA-256 + delivery-id + repo validation
   -> durable SQLite operational store
   -> command / event normalization
   -> reconcile #660 and exact main
   -> persistent MASTER_QUEUE
   -> dependency / priority / lease checks
   -> existing Agent Hub coordinator/executor wakeups
   -> worker / CI / check events
   -> verify success criteria
   -> reconcile immediately
   -> NEXT_EXECUTABLE
```

Primary wakeup is webhook/event based. The internal reconciliation timer is drift recovery only; it is not a cron-based development scheduler.

## Fail-closed command boundary

Only an `issue_comment` on Issue `#660` whose GitHub actor is present in `.github/agent-hub/policy.json` can become a controller command, and only when its body begins with a machine-readable `[COMMAND_UPDATE]` header block.

The header parser:

- requires exactly one `[COMMAND_UPDATE]` marker;
- accepts only an allowlist of header keys;
- requires `PUBLISHER=CENTRAL-COMMANDER` (or the historical `COMMAND_PUBLISHER` key);
- validates numeric `COMMAND_VERSION` and full `LATEST_MAIN` SHA;
- stops at the first blank line;
- treats all later prose as untrusted data;
- never passes issue/comment text to `exec`, `eval`, `shell`, or `bash -c`.

`[HUB_COMMAND]` comments remain governed by the existing Agent Hub and only map to registered worker dispatch. The controller does not invent shell commands from `COMMAND_UPDATE` content.

## Durable state

The controller uses a separate SQLite operational database, default:

`/var/lib/investment-realtime-controller/controller.sqlite3`

This is deliberately separate from application/financial databases. Repository discovery found no existing persistent controller store and `packages/db` is only a stub. The operational database stores controller metadata, webhook deliveries, tasks, workers, leases, errors, and checkpoints. WAL + `BEGIN IMMEDIATE` are used for restart-safe state and atomic lease acquisition.

No Production application database schema change is required.

## Task and worker safety

Task states:

`DISCOVERED -> PENDING -> READY -> CLAIMED -> IN_PROGRESS -> WAITING_CI -> VERIFYING -> COMPLETED`

with fail-closed side states `WAITING_DEPENDENCY`, `BLOCKED`, `FAILED`, `CANCELLED`, `SUPERSEDED`.

Mutable tasks require a lease. Exact/wildcard path overlap prevents two active leases from owning the same files. Expired leases are recovered on reconciliation. Repeated identical failures trip `LOOP_DETECTED` and stop automatic retry.

CI success alone never marks a task complete. It advances the task to `VERIFYING`; a successful worker report with matching CI SHA is still required by the current adapter.

## Worker adapter

The v1 adapter does not run arbitrary local code. It wakes the **existing** GitHub Actions Agent Hub executor with repository dispatch type `agent-hub-command-ready`, and only if the task is linked to a validated `[HUB_COMMAND]`.

Executor reports can wake the existing coordinator through `agent-executor-report-ready`.

This means the existing Agent Hub remains the code-execution authority and its branch, file, policy, diff, and Gemini safety gates remain in force.

## Webhook endpoint

`POST /github/webhook`

Required headers:

- `X-Hub-Signature-256`
- `X-GitHub-Delivery`
- `X-GitHub-Event`

Accepted events:

- `issue_comment`
- `issues`
- `push`
- `pull_request`
- `pull_request_review`
- `pull_request_review_comment`
- `workflow_run`
- `check_run`
- `check_suite`

Each accepted delivery ID is stored before processing. Duplicate deliveries do not execute a second transition.

Health endpoints:

- `GET /health/live`
- `GET /health/ready`
- `GET /status`

Status output contains no secrets and always reports the hard safety defaults.

## Kill switches

Environment flags default conservatively:

- `CONTROLLER_ENABLED=true`
- `DISPATCH_ENABLED=false`
- `AI_WORKERS_ENABLED=false`

So repository code can be installed/read/reconciled without automatically dispatching workers until activation is explicitly approved.

Hard safety truth:

- `LIVE_TRADING=false`
- `executionAuthority=NONE`
- `REAL_ORDER_ALLOWED=false`
- `PRIVATE_TRADING_API_ALLOWED=false`
- real orders = `0`
- Production deploy/activation = outside this controller

## Runtime environment

Required before actual activation:

- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_TOKEN` with minimum repository scopes needed for read/reconcile and repository-dispatch only
- `CONTROLLER_REPOSITORY=seungjae3908-source/seungjae20260713`
- `CONTROLLER_REPO_ROOT=<immutable/current checkout root>`
- writable `CONTROLLER_DB_PATH`

Optional:

- `CONTROLLER_HUB_ISSUE=660`
- `CONTROLLER_HOST=127.0.0.1`
- `CONTROLLER_PORT=8765`
- `CONTROLLER_RECONCILE_SECONDS=30`
- kill-switch flags above

Never place tokens or webhook secrets in repository files or logs.

## Local / CI validation

```bash
python3 -m py_compile control-plane/realtime-controller/realtime_controller.py
python3 control-plane/realtime-controller/tests/test_realtime_controller.py
```

The focused suite covers command authorization, HMAC verification, invalid signatures, delivery dedupe, repository identity, priority, dependency/cycle handling, atomic leases, file-conflict serialization, parallel non-overlapping leases, heartbeat/expiry recovery, restart persistence, Hub-command dispatch, kill switches, CI transition safety, worker-report verification, repeated-error loop detection, GitHub outage circuit breaking, and missed-event reconciliation.

## Evidence stop line

Do **not** report `REALTIME_CONTROLLER_READY=true` until all of these are actually proven on the non-Production server:

1. persistent controller process is running;
2. the existing supervisor is enabled to restart it after failure and reboot;
3. a real GitHub webhook delivery is received and HMAC-verified;
4. a real canonical #660 command is parsed;
5. a real task is claimed with a persisted lease;
6. the existing AI worker runner actually executes a safe non-Production task;
7. a real CI/check event resumes the task automatically;
8. controller restart restores state without duplicate dispatch;
9. a deliberately missed event is repaired by reconciliation;
10. duplicate delivery does not duplicate work;
11. authoritative evidence is posted to #660.

Repository tests and a green PR are necessary but are **not** evidence that the 24/7 runtime is active.
