# Research-only read-only preflight after the 2026-10-13 release failure

Production run 38333121613 failed before SSH or application/database mutation:
`LIVE_SERVER_GATE_NOT_OFF` for four providers. The failed `automation_research`
route replaces the shared application, not just the isolated Research server.
The shared-app LIVE guards are unchanged. This PR cannot deploy or activate
anything, disable LIVE, replace the app, restart PM2, or change a policy.

## Implemented correction

The read-only research path accepts the existing canonical post-merge release
proof AND independently rechecks the six pre-merge contexts and identical whole
Git trees. It rejects foreign/mixed status origins, stale main, a newer CI run,
wrong/missing source PR, changed tree, and active protected runtime mutations.
A new Full CI on the identical merged main is not required for this **audit**.
No statuses are synthesized. The previous deployment/activation authorizers and
their guard conditions are not edited or bypassed.

The actual command, posted by the owner on canonical Hub #1102, is:

    /run-research-isolated <exact-current-main-sha> --audit

`Research Isolated Read-Only Preflight` requires the existing `production`
protected-environment review before server access. That approval permits only
this read-only audit, **not** deployment. Current main/proof are revalidated after
approval and before remote access. The owner may stop here with no runtime change.

The workflow uses the existing `ops/research-activation-preflight.mjs` over pinned
SSH stdin; no server-side script or environment file is written. It inspects all
independent host, ownership, provider-presence/policy, source-input, cycle,
Dashboard, cost and functional-evidence checks. Missing and unknown information
remain missing/unknown. It additionally exposes Node >=22.4 and whether a future
core-only update would interrupt currently running AI/watch dependencies.
That latter blocker is not a claim that an intentionally running worker failed.

An audit may finish successfully while reporting blockers. The receipt explicitly
keeps `fullyFunctional=false`, `profitabilityProven=false`, `executionAuthority=NONE`
and records every prerequisite/remaining check. It is not a 24-hour continuity,
source license, provider response, independent OOS or Paper settlement proof.
The shared public app SHA is checked before and after, without expecting its
manual LIVE capability to be OFF or copying any trading credential.

Artifact: `research-isolated-audit-<sha>-<runId>/research-audit.json`.
Only sanitized check IDs/statuses and source identity are retained; no raw
account data, environment values, credentials or screenshots are uploaded.

## What is not included

The planned host-changing transport was blocked by the tool safety check and is
not included in this candidate. This command has no activation variant; an
activation request is rejected. No host-mutation script is repackaged or routed
through another tool. The completed scope is the safer read-only audit and CI
provenance repair. Research runtime deployment, coordinated AI/watch cutover,
new app UI deployment and full operating validation are still separate work.

After the real audit, use its observed blockers to choose the next authorized
repair rather than repeating the failed shared-app release. Replit/Replit Agent
are prohibited. Existing Trading, Paper, Telegram and Production guards remain
byte-for-byte unchanged by this candidate.
