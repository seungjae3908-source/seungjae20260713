# Staging Status Bridge

## Purpose

The staging dispatch bridge can safely start the existing `Staging Readiness` workflow, but the connected GitHub tool does not provide a repository-wide workflow-run listing operation. The status bridge adds a narrow, auditable, read-only command that reports the latest matching staging run and its jobs to control issue `#23`.

It does not dispatch, deploy, rerun, approve, cancel, or modify staging. It cannot reach production.

## Exact command

```text
/status-staging <exact-40-character-current-main-sha>
```

For the current revision:

```text
/status-staging 678eb73a00330df722dcfa14c210d6f4f54560cf
```

The SHA must be exactly 40 hexadecimal characters and must equal the current `main` commit. This prevents an ambiguous lookup when several historical staging runs exist.

## Authorization

The command is accepted only when all of these are true:

- issue number is exactly `23`;
- issue title is exactly `Staging Readiness Control`;
- issue remains open;
- the comment is an issue comment, not a pull request comment;
- the author login is exactly `seungjae3908-source`;
- GitHub reports the author association as `OWNER`;
- the event is a newly created comment;
- the command and SHA format are exact.

## Read-only lookup

The workflow has `actions: read`, `contents: read`, and `issues: write` only. It:

1. verifies the requested SHA equals current `main`;
2. reads `Staging Readiness` workflow runs created by `workflow_dispatch` on `main`;
3. selects the newest run whose `head_sha` equals the requested SHA;
4. reads that run's jobs;
5. posts the run ID, run link, status, conclusion, verdict, and job results to issue `#23`.

The bridge has no `actions: write` permission and contains no dispatch, rerun, approval, cancellation, staging-secret, production-secret, production-path, or production-workflow operation.

## Report meaning

- `queued` or `in_progress`: staging verification has not finished.
- `completed / success`: the workflow completed successfully; detailed job logs still remain the evidence source.
- `completed` with any other conclusion: staging verification failed, was cancelled, or was interrupted. The failed job and logs must be inspected before another run.

A status report never grants production approval. Production remains separately blocked.
