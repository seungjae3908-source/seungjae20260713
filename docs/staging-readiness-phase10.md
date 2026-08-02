# Phase 10 staging readiness and production approval gates

## Purpose

Phase 10 prepares an isolated staging environment and determines only one of two outcomes:

- `운영 배포 승인 가능`
- `운영 배포 승인 보류`

It does not deploy production, change the production database, or enable real trading.

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
   - `futures-public-network-smoke/verified`

The repository administrator must separately configure the GitHub `production` environment with required reviewers, deployment-branch restrictions, and self-review prevention where available. If those settings cannot be inspected, production approval remains on hold.

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

## Immutable staging deployment

The staging workflow accepts only an exact SHA that is contained in `main`. The remote host fetches that SHA, resolves it again, and refuses deployment if it differs.

The application receives:

```text
APP_ENV=staging
DEPLOY_SHA=<exact SHA>
```

The health endpoint should report the deployment SHA when supported. The workflow also verifies the SHA stored under the staging deployment state directory.

## Migration drill

The staging database drill must perform:

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

Missing accounts or mock-only verification cannot produce an approval-possible verdict.

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

## Backup and recovery

The staging deploy script creates an isolated source backup and SHA-256 checksum manifest before promotion. A failed deployment restores the previous staging snapshot and deployment SHA.

The full readiness workflow must also verify:

- backup checksum;
- rejection of damaged backups;
- delete and restore drill;
- failed deployment rollback;
- redeployment of the same SHA;
- recovery of the previous SHA;
- recovery time and data-loss window;
- no Secret, Authorization header, or personal information in logs.

## Verdict policy

`운영 배포 승인 가능` is allowed only when the real staging environment, four real accounts, server AI provider, migration drill, browser tests, backup and recovery drill, latest SHA, and all verification checks succeed with zero failures, cancellations, or skipped required checks.

Any missing environment, account, Secret, recovery target, or unverified GitHub production-environment protection results in:

```text
운영 배포 승인 보류
```

Phase 10 does not merge itself and does not execute production deployment.
