# Parent Integration Seam

The sidecar is intentionally deployed before parent integration.

## Scanner

The parent Scanner may call `POST /v1/evaluate` with a short timeout. On timeout or service unavailability, preserve the canonical Scanner candidate and attach `INTELLIGENCE_UNAVAILABLE`; do not convert absence into a negative score. When available, apply only the bounded `scanner.adjustment` and explicit `hardBlockReason`.

## Auto-trading

The parent auto-trading service must not call this sidecar as an order executor. It may consume `autoTrading.mode` as follows:

- `PAPER_ONLY`: never allow a new live trade because of intelligence evidence.
- `BLOCKED_RISK`: reject the intelligence-dependent trade candidate.
- `ELIGIBLE_FOR_PARENT_GATE`: continue to the existing Profit/Risk/Portfolio/Approval/Execution gates; this is not approval.

## Rollout

1. Deploy sidecar loopback-only.
2. Observe public crypto evidence and normalized stock inputs.
3. Record WITH-vs-WITHOUT intelligence Paper/Forward outcomes.
4. Promote only evidence-backed feature families.
5. Add a tiny read-only parent adapter in a separate ownership-audited PR.

This sequence ensures the current Scanner and Production deployment train are not coupled to sidecar rollout.
