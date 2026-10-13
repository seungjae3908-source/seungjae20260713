# Dormant public-crypto WebSocket service readiness — 2026-10-14

## Dormant isolated service definition (source only; not installed)

The source tree now includes `deploy/research-production-public-crypto-ws.service`.
This is a **static**, non-installed systemd unit with no `[Install]` target.
The existing core activation script does NOT add or enable it. It is not a
server change or proof of an active collector.

A separately reviewed operator must establish the private research-owned
`/var/lib/investment-research-production/public-ws` (0700) and immutable
`/etc/investment-research/research-public-ws-roster.json` (0600, readable
by `investment-research`) without using app-owned data directories. The
required root-managed configuration
`/etc/investment-research/research-public-ws.env` must be preexisting and
must attest the **four** independent public-source approvals and the exact
checked-out `RESEARCH_PUBLIC_WS_PRODUCER_SHA`. Presence of this text file
alone is not evidence that any approval, venue rights or host capacity exists.

The service uses a fixed roster and sidecar root, an exclusive Linux
`flock` owned by the research user, explicit NO-LIVE/NO-ORDER environment,
40% of one CPU, <=512 MiB cgroup RAM, a narrow read-write sidecar path and
strict filesystem/kernel sandboxing. A deliberate worker exit 2
(`HALTED_MANUAL_REVIEW`) or lock-contention code 75 must NOT automatically
restart; abnormal crashes have a three-attempt, ten-minute restart ceiling.
All provisional 1m observations still require independent REST finality,
historical PIT, genuine KR/US data licensing and postdeployment 24-hour
recovery/quotas before being used for OOS, Full Cost or Paper evidence.

The unit file and parser/approval-boundary tests are committed **only to
a Draft source branch** initially. No server file is installed, no service
is started/enabled, no environment/roster is populated, no WebSocket opens
and no provider/network quota has been measured by this code-only change.
No Replit or Replit Agent is used.

Historical source integrity: the original `public-crypto-ws-live-worker-20261013.md` is restored byte-for-byte; this document is additive and does not alter the frozen source hash or the worker.
