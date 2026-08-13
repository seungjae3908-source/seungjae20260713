# Three-provider clean-port integration plan

Source ownership is intentionally split to avoid overwriting active work.

- Current main already contains Upbit spot and Bitget futures authenticated request builders plus pre-submission risk and reconciliation infrastructure.
- Draft PR #187 contains the Toss OpenAPI 1.2.13 request builders and broader broker-provider abstraction, but it is stale and conflicts with current main.
- This branch owns only canonical provider authority and predeploy evidence until the stale broker branch is reconciled.

Planned clean-port order after exact-head validation:

1. Preserve current-main Upbit and Bitget request builders.
2. Clean-port only the Toss OAuth/account/holdings/order/query/modify/cancel semantics from PR #187 into current-main-compatible isolated files.
3. Keep credentials user-scoped in the existing encrypted vault; no server-wide fallback.
4. Normalize account/holding/position snapshots without fabricating unavailable values.
5. Connect the canonical providers to existing pre-submission risk, idempotency, reconciliation, approval, journal, and portfolio seams.
6. Validate private connectivity in a non-ordering environment before any execution-capable deployment.
7. Stop at production predeploy until a separate explicit activation decision.

No private provider request or financial mutation is performed by this Draft.
