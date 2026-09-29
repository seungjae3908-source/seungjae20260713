# Agent Hub V5 Autonomous Engine — V5-3 through V5-7

This owner extends the merged V5 Task Memory and Natural-Language Gateway without weakening existing policy gates.

## V5-3 Existing Owner Resolver

- existing open PR/task/worker/path ownership is preferred over creating duplicate work;
- equal top candidates fail closed as `ambiguous`;
- closed owners are never reused.

## V5-4 Bounded Self-Healing

- only the existing safe auto-action allowlist may retry;
- maximum automatic retry count is bounded;
- the same failure fingerprint twice stops instead of retrying to pass;
- Merge, deploy, DB/Secret/Env, private trading API, force push, paid fallback, and order actions cannot enter the retry loop.

## V5-5 Evidence Engine

- evidence is bound to exact HEAD SHA and content digest;
- all six Required CI contexts must be explicit success on the same HEAD;
- missing evidence is `MISSING`, never numeric zero;
- stale-head evidence cannot satisfy a new HEAD.

## V5-6 Mobile Control Surface

`stock-analyzer/src/pages/agent-hub-control.tsx` provides a responsive command/approval control surface. It deliberately reports `Execution: NOT_CONNECTED` until a verified server-side control-plane connection exists. The page does not fabricate execution success or expose Merge/Deploy/trading authority.

## V5-7 Long-running Orchestrator

The state machine preserves goal/current step/FIRST_ZERO/remaining steps and supports bounded transitions through inspect → implement → validate → Draft PR → exact-head CI → human approval → merge → post-merge CI.

Ready/Merge/Staging require the existing human approval boundary. Production, DB/Secret/Env mutation, private trading API, live trading, real order/cancel/transfer/withdrawal, force push, Replit, and paid fallback remain outside this engine.

## Truth boundary

This work creates the autonomous control primitives and UI contract. It does not claim a deployed production control-plane connection; deployment and environment/secret wiring are separate explicit approvals.
