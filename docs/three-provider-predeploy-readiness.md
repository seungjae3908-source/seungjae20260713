# Three-provider predeploy readiness

Canonical provider authority:

- KR stock: Toss Securities
- US stock: Toss Securities
- Crypto spot: Upbit
- Crypto futures: Bitget

This branch does not send private provider requests and does not submit orders. It defines the evidence that must be complete before provider connectivity and execution validation can proceed.

Required evidence includes user-scoped vault configuration, account identity, provider permissions, private-read contract coverage, order/cancel contract coverage, reconciliation, idempotency, risk gate, kill switch, and exact-head CI.

Production deployment, credential registration, private API calls, and order submission remain outside this Draft scope.
