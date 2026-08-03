# Phase 10 staging readiness and production approval gates

## Purpose

Phase 10 prepares an isolated staging environment and gathers evidence for a later production decision.

A successful staging run does **not** by itself grant production approval. The workflow does not deploy production, change the production database, or enable real trading.

## Production deployment gate

Production deployment is manual only. The workflow does not run on a push to `main`.

A production request must provide an exact 40-character commit SHA. Before the `production` environment approval step, the workflow verifies that:

1. the revision exists as a commit;
2. the revision is contained in `main`;
3. the latest commit statuses are successful for:
   - `application-ci/verified`
   - `browser-ui/verified`
   - `database-rls/verified`
   - `security-integration/verified`
   - `ai-privacy/verified`
   - `futures-public-network-smoke/verified`;
4. a completed, successful `Application CI` workflow run exists for the exact SHA from a `push` event on `main`.

Status contexts alone are not accepted as sufficient CI provenance.

The repository administrator must separately configure and directly verify the GitHub `production` environment with required reviewers, deployment-branch restrictions, and self-review prevention where available. If those settings cannot be inspected, production approval remains on hold.

## Staging isolation

Staging uses only:

- GitHub environment: `staging`
- secret names beginning with `STAGING_`
- installation root: `/srv/seungjae-staging`
- PM2 process: `seungjae-staging`
- live port: `18080`
- canary port: `18082`
- a staging-only HTTPS URL
- a staging-only database URL
- a server-only staging AI provider key

The staging workflow rejects production identifiers, the production URL, production paths, production process names, and missing isolated values.

## Required staging secrets

```text
STAGING_SSH_HOST
STAGING_SSH_USER
STAGING_SSH_PORT
STAGING_SSH_PRIVATE_KEY
STAGING_SSH_KNOWN_HOSTS
STAGING_BASE_URL
STAGING_DATABASE_URL
STAGING_AI_API_KEY
STAGING_PENDING_EMAIL
STAGING_PENDING_PASSWORD
STAGING_ASSOCIATE_EMAIL
STAGING_ASSOCIATE_PASSWORD
STAGING_REGULAR_EMAIL
STAGING_REGULAR_PASSWORD
STAGING_ADMIN_EMAIL
STAGING_ADMIN_PASSWORD
```

Secret values must never be committed, included in artifacts, printed in logs, returned by APIs, or exposed in the frontend bundle.

The workflow writes the staging URL, database URL, and AI key to a temporary mode-`600` file, copies it over SSH, sources it remotely, and deletes it. These values are not placed in the SSH remote command line. Release directories do not retain `.env.staging`; only the active staging runtime receives one atomic mode-`600` file.

## Immutable staging deployment

The staging workflow accepts only an exact SHA that is contained in `main`. The remote host fetches that SHA, resolves it again, and refuses deployment if it differs.

The application receives:

```text
APP_ENV=staging
DEPLOY_SHA=<exact SHA>
```

The workflow verifies the health endpoint and the SHA stored under the staging deployment state directory. Deployment locking uses a non-inherited `flock` wrapper so a canary or long-lived PM2 process cannot retain the lock after the deployment command exits.

## Non-destructive default

`run_destructive_recovery_drill` defaults to `false`. In that mode the workflow deploys the requested staging revision and runs the real account and browser verification, but skips the database apply/rollback/reapply drill and the staging file delete/restore, failpoint rollback, and previous-SHA recovery drills. Destructive checks run only when the repository owner explicitly supplies `--destructive` after separate approval.

## Explicitly approved migration drill

When `run_destructive_recovery_drill` is explicitly `true`, the staging database drill must perform:

1. backup;
2. Phase 7 through current migration apply;
3. schema and residual-object inspection;
4. user, role, capability, and RLS verification;
5. rollback;
6. existing-data verification after rollback;
7. reapply;
8. user, role, capability, and RLS re-verification.

No migration is applied to the production database.

## Four-role verification

Real staging accounts must verify all four enforcement layers: visible controls, direct URLs, backend APIs, and database RLS.

- `pending`: approval-waiting experience only
- `associate`: basic information allowed; futures and AI denied
- `regular`: futures and opt-in AI analysis allowed; real orders denied
- `admin`: member management allowed; automatic access to another user's private journal denied

Missing accounts or mock-only verification cannot produce a successful staging-readiness result.

## AI provider verification

The provider key exists only on the staging server. Verification covers:

- zero outbound calls before consent;
- zero outbound calls when membership is denied;
- successful opt-in request;
- 429, 5xx, timeout, and invalid JSON;
- no provider secret in frontend, response, logs, or artifacts;
- zero actual orders and zero private exchange calls;
- the documented process-local rate-limit limitation.

## Browser verification

The real staging URL is tested at:

- 1440×900
- 390×844
- 360×740

Checks include login for all four roles, refresh and session recovery, role changes, AI preview and consent, local result handling, no horizontal overflow, no console errors, and no uncaught exceptions.

## Explicitly approved backup and recovery

The staging deploy script creates an isolated source backup and SHA-256 checksum manifest before promotion. Failed post-promotion verification restores the previous staging snapshot, runtime SHA, active release metadata, and PM2 process.

When separately approved, the explicit staging-only destructive drill requires a real previous SHA that differs from the target SHA and verifies:

1. the original backup checksum;
2. rejection of a deliberately corrupted copy of the backup;
3. deletion and restoration of the active staging frontend entry file from the immutable release;
4. an intentional `after-promotion` failure and automatic rollback;
5. recovery of the real previous staging snapshot and previous SHA;
6. redeployment of the requested target SHA;
7. redeployment of the same SHA again;
8. recovery time and a zero application-file loss window;
9. real PM2 or application logs exist and contain no credential pattern, configured staging Secret, account email, or password.

Missing previous-SHA evidence, missing logs, damaged checksum acceptance, skipped checks, failed health recovery, or any incomplete drill causes the workflow to fail.

## Verdict policy

A successful staging workflow means only that the staging evidence passed. It records:

```text
운영 배포 승인 보류
```

Production approval can be considered only after direct verification of the GitHub `production` environment reviewers, deployment-branch restrictions, and self-review protection, followed by a separate user decision.

Phase 10 does not merge itself and does not execute production deployment automatically.
