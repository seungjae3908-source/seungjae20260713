# Phase9 — durable research queue and worker foundation (Draft only)

This increment continues #1042 after Phase8. It does not install or start a daemon, schedule, PM2 process, provider call, deployment or trading authority.

## What exists
- Private local file queue with immutable job identity and atomic queued -> running claims.
- Lease heartbeat and worker heartbeat are separate. Missing root is unavailable, not a measured zero.
- Expired pre-provider leases may be requeued within maxAttempts. A durable external-call reservation changes crash recovery to BLOCKED_UNCERTAIN; it is never blindly retried.
- Negative/insufficient research outcomes are terminal research results, not retry triggers.
- Runnable CLI supports explicit init/status/enqueue/once/loop. Merely merging code does not activate loop mode.
- The current executable task type reuses Phase8 V8 -> Phase7 video preparation/approved-one-shot flow. It mints no video approval and cannot select an env file from a queued job. An operator may explicitly select the existing-env source when launching the worker.
- Browser status is read-only/admin-only through the existing workspace router. It exposes counts and heartbeat state only, never job arguments, paths, keys, model names, output contents or approval IDs.

## Safety / truth
The queue is not a global exactly-once distributed system. It assumes one private local filesystem with cooperative same-UID workers. External reservation is deliberately conservative. If a process can have sent a provider request, recovery blocks for review instead of retrying. Queue retry is limited to selected technical pre-call errors and cannot be driven by PnL or strategy quality.

This phase does not automatically create YouTube/Gemini/Groq research jobs. Provider orchestration/planning remains the next bounded integration. It also does not prove provider configuration, quota, billing, AI quality, source semantics, OOS performance or profitability.

No Ready/Merge/deploy, DB/Secret/Env mutation, schedule/24h activation, Paper/Telegram/private trading API/orders or Replit.
