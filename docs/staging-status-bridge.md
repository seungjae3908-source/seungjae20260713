# Staging Status Bridge

## Purpose

The status bridge provides a narrow, auditable, read-only command that reports the exact `staging-verdict.json` associated with an immutable staging target SHA on control issue `#23`.

It does not dispatch, deploy, rerun, approve, cancel, or modify staging. It cannot reach production.

## Exact command

```text
/status-staging <exact-40-character-main-contained-sha>
```

The SHA must be exactly 40 hexadecimal characters and must be contained in current `main`. Equality with the newest `main` SHA is intentionally not required because the inspected staging verdict may belong to an earlier immutable main commit.

## Authorization

The command is accepted only when all of these are true:

- issue number is exactly `23`;
- issue title is exactly `Staging Readiness Control`;
- issue remains open;
- the comment is an issue comment, not a pull request comment;
- the author login is exactly `seungjae3908-source`;
- GitHub reports the author association as `OWNER`;
- the event is a newly created comment;
- the comment begins with `/status-staging `;
- the command and SHA format are exact;
- the requested commit is contained in current `main`.

## Read-only artifact lookup

The workflow has `actions: read`, `contents: read`, and `issues: write` only. It:

1. verifies the requested immutable SHA is contained in current `main`;
2. searches for the exact artifact name `staging-verdict-<SHA>`;
3. directly fetches the artifact source Run ID;
4. verifies the source is the official `.github/workflows/staging-readiness.yml` workflow on `main` for the requested SHA;
5. downloads `staging-verdict.json`;
6. reports target/deployed SHA, total, passed, failed, skipped, browser errors, HTTP errors, PM2 status, restart count, `release_ready`, and the final verdict.

The bridge has no `actions: write` permission and contains no dispatch, rerun, approval, cancellation, staging-secret, production-secret, production-path, or production-workflow operation.

## Report meaning

- `release_ready=true`, `failed=0`, and `skipped=0`: the defined staging quality gate completed and the artifact is eligible for independent Production Deploy verification.
- `release_ready=false`: production promotion is blocked.
- no artifact: the application may or may not have deployed, but complete release validation evidence is absent, so production promotion is blocked.

A status report never grants production approval. Production independently downloads and validates the same exact-SHA verdict artifact before the protected production environment Job can start.
