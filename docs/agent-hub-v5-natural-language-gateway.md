# Agent Hub V5 Natural-Language Gateway

The V5 natural-language gateway converts short user text into a bounded, non-authoritative intent envelope.

It may provide:

- normalized user goal
- new vs resume mode
- a resumable task identifier and prior bounded task context
- worker and action hints for the existing coordinator
- a command digest for audit correlation

It does **not** produce `[HUB_COMMAND]`, authorization, risk, approval, merge, deploy, database, secret, paid-fallback, private-API, live-trading, order, transfer, or withdrawal authority.

The existing Coordinator and deterministic Policy Engine remain authoritative for all execution decisions.

Resume behavior is fail-closed: `이어서 해` / `continue` resolves automatically only when exactly one non-terminal task is available, or when a specific `task_id` is supplied. Multiple resumable tasks require an explicit task id rather than guessing.
