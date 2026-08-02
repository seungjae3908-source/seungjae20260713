# Staging Dispatch Bridge

## Purpose

The GitHub connector used by the project can read and write repository data but cannot call the GitHub Actions `workflow_dispatch` endpoint directly. This bridge adds a narrow, auditable control path without weakening the existing `Staging Readiness` workflow.

The bridge does not deploy staging itself. It validates one owner command and then calls the existing `.github/workflows/staging-readiness.yml` workflow through GitHub's workflow-dispatch API.

## Control issue

Only issue `#23`, titled `Staging Readiness Control`, is accepted.

The issue must remain open and the command must be a newly created issue comment. Pull request comments and comments on any other issue are ignored.

## Exact command

```text
/run-staging <exact-40-character-main-sha> --destructive
```

Example:

```text
/run-staging f2cdbd1a8ae42d2fd6a5caba3e875f057053021c --destructive
```

No abbreviated SHA, alternate flag, additional text, or missing `--destructive` flag is accepted.

## Authorization

The dispatch job runs only when all of these conditions are true:

- comment author login is exactly `seungjae3908-source`;
- GitHub reports the comment author's association as `OWNER`;
- issue number is exactly `23`;
- issue title is exactly `Staging Readiness Control`;
- issue is open;
- the comment is on an issue, not a pull request;
- the event is a newly created comment.

The privileged `actions: write` and `issues: write` permissions exist only on the issue-comment dispatch job. Pull request validation runs with read-only permissions.

## Revision and CI validation

Before dispatching, the bridge:

1. parses an exact 40-character SHA;
2. verifies that Git can resolve it as a commit;
3. verifies that it is contained in `main`;
4. requires all six successful status contexts:
   - `application-ci/verified`
   - `browser-ui/verified`
   - `database-rls/verified`
   - `security-integration/verified`
   - `ai-privacy/verified`
   - `futures-public-network-smoke/verified`
5. requires a successful completed `Application CI` workflow run produced by a `push` event on `main` for that exact SHA.

Status strings alone are not sufficient.

## Dispatch boundary

The bridge dispatches only:

- workflow: `staging-readiness.yml`
- ref: `main`
- input `sha`: validated SHA
- input `run_destructive_recovery_drill`: `true`

It does not read staging secrets. The existing staging workflow owns the `staging` GitHub environment, its secrets, server connection, isolated path, isolated PM2 process, isolated ports, staging database, browser tests, and destructive recovery drills.

The bridge contains no production secret names, production paths, production workflow target, production deployment call, or production database action.

## Result comment

After GitHub accepts the dispatch request, the bridge writes an acknowledgement to issue `#23` containing:

- target SHA;
- dispatched workflow;
- `main` ref;
- destructive drill state;
- confirmation that production deployment was not executed;
- source command comment ID.

A successful acknowledgement means GitHub accepted the dispatch request. The actual staging result must still be verified from the `Staging Readiness` workflow jobs and logs.

## Failure behavior

Malformed, unauthorized, stale, non-main, or unverified requests fail or are skipped without dispatching staging. The bridge does not substitute another SHA, disable the destructive drill, retry with altered inputs, or fall back to production.
