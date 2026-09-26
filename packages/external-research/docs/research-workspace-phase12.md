# Phase12 provider one-shot capture

Phase12 deliberately separates the first real provider capture from compiler/backtester continuation.

1. A reviewed manifest pins the exact YouTube source, Gemini video plan and Phase10 orchestrator plan.
2. Gemini is allowed at most one reviewed call through the existing V7 durable reservation path.
3. Groq receives a deterministic adversarial request derived from that Gemini receipt. A separate exact-plan approval permits at most one Groq call.
4. The Groq response must cover every observation index with ACCEPT_AS_CLAIM, CHALLENGE or AMBIGUOUS. It cannot invent missing rules or numeric performance.
5. The provider result is persisted as a review package containing a candidate reviewed-rule digest.
6. The run stops at REVIEW_REQUIRED. A human must review and bind that exact digest before Phase11 compiler/backtester continuation.

A crash after either provider reservation must never cause a blind retry. No schedule, automatic adoption, profitability promotion, trading authority, Paper/live order path or paid fallback is added.
