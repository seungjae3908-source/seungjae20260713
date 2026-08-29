# Realtime Agent Hub Controller

## Purpose

This is a persistent event-driven control plane for Central Hub `#660`. It is intentionally **not** a second AI coding engine. It reuses the repository's existing control plane:

- coordinator: `.github/workflows/agent-hub-free.yml`
- coding worker: `.github/workflows/agent-hub-executor.yml`
- deterministic Hub parser/state snapshot: `scripts/agent_hub_state_v2.py`

The existing executor already invokes the repository's free-only Gemini CLI coding runner. This controller's worker adapter only sends the existing `agent-hub-wakeup` repository dispatch; it does not automate ChatGPT in a browser and it does not create a competing PR engine.

## Runtime flow

```text
GitHub webhook
  -> HMAC signature validation
  -> delivery-id dedupe
  -> remote #660 reconciliation
  -> SQLite persistent master queue
  -> priority resolver
  -> durable task lease
  -> agent-hub-wakeup adapter
  -> existing Agent Hub coordinator/executor
  -> PR/Test/CI/worker-report GitHub event
  -> reconcile
  -> next READY task automatically dispatched
```

Supported primary webhook events are `issue_comment`, `issues`, `push`, `pull_request`, `pull_request_review`, `workflow_run`, `check_run`, and `check_suite`. There is no hourly polling loop in the controller. On process start it reconciles `#660` immediately, so a READY task does not wait for another GitHub event.

## Persistence and duplicate protection

SQLite persists:

- canonical command version/comment digest
- task status and priority
- task leases
- controller lease/heartbeat
- outbound dispatch keys
- GitHub delivery IDs
- blocker and last reconcile/dispatch state

A restarted process reopens the same database. A still-leased `DISPATCHED` task is not dispatched again. If a task lease expires without authoritative result evidence, the task fails closed as `LEASE_EXPIRED_REQUIRES_REMOTE_RECONCILE` rather than starting a duplicate worker. Startup reconciliation also consumes worker reports that may have arrived while the process was down.

## Required runtime environment

`serve` requires:

- `GITHUB_REPOSITORY=seungjae3908-source/seungjae20260713`
- `GITHUB_TOKEN` with only the permissions required to read `#660` and send the existing repository dispatch
- `GITHUB_WEBHOOK_SECRET`
- optional `CONTROLLER_DB_PATH` (defaults to `/var/lib/investment-realtime-controller/controller.db`)
- optional `CONTROLLER_BIND` / `CONTROLLER_PORT`

Example commands:

```bash
python3 control-plane/realtime-controller/realtime_controller.py status
python3 control-plane/realtime-controller/realtime_controller.py reconcile
python3 control-plane/realtime-controller/realtime_controller.py serve
```

## Supervisor template

`systemd/investment-realtime-controller.service` provides `Restart=always`, `WantedBy=multi-user.target`, a durable `StateDirectory`, and a hardened DynamicUser service. It assumes a release path of `/opt/investment-platform/current` and an environment file at `/etc/investment-realtime-controller.env`.

**The service file is configuration only.** This PR does not install, enable, start, or restart it. It also does not register a GitHub webhook or write any Secret. Those remain separate server/Secret approval boundaries.

## Readiness truth

Code/tests alone do not make the controller operational. Keep `REALTIME_CONTROLLER_READY=false` until all of the following have real server evidence:

- persistent process is actually running
- GitHub webhook is actually registered and a real signed delivery is received
- `#660` command ingest is observed
- persistent queue/lease/heartbeat are observed on the server
- existing AI worker runner actually executes a harmless task
- CI/result event automatically causes the next task dispatch
- forced process restart proves no task/worker/PR duplication or loss
- event-loss reconciliation is proven against real GitHub state

Deterministic tests in this PR prove only the local control contracts: HMAC verification, delivery dedupe, SQLite durability, controller/task leases, fail-closed expired leases, missed-event startup reconciliation, and a result event causing a second task dispatch without chat input.

## Safety boundary

The controller has no direct trading, account, deployment, database, Secret, transfer, withdrawal, or order adapter. Its only worker action is the existing `agent-hub-wakeup` repository dispatch. Production deploy/activation, private trading API, live trading, real order create/modify/cancel, transfers, withdrawals, and destructive Production DB mutations remain outside this control plane and require their existing explicit approvals.
