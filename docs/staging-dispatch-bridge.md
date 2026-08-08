# Staging Dispatch Bridge

## Purpose

The bridge accepts one owner-only command on issue `#23` (`Staging Readiness Control`) and dispatches `.github/workflows/staging-readiness.yml` from `main`.

It never reads staging secrets and never targets production. API acceptance is not deployment evidence: the bridge reports success only after GitHub returns and independently verifies the actual workflow Run ID for the requested revision.

## Commands

Preflight is the default and changes nothing on the server:

```text
/run-staging <exact-40-character-current-main-sha>
```

Every staging deployment candidate must run the complete account and browser validation gate:

```text
/run-staging <exact-40-character-current-main-sha> --deploy --full-validation
```

A deployment command without `--full-validation` is rejected. A successful application deployment without complete validation is not release-ready and cannot be used for production promotion.

The staging-only destructive recovery and log-redaction drill remains an additional explicit flag:

```text
/run-staging <exact-40-character-current-main-sha> --deploy --full-validation --destructive
```

Flags may not be duplicated and no unknown text is accepted. `--full-validation` and `--destructive` require `--deploy`.

## Authorization and immutable revision gate

The command is considered only when the issue remains open, the author is exactly `seungjae3908-source`, GitHub reports `OWNER`, the comment is a newly created issue comment rather than a pull request comment, and the body begins with `/run-staging `.

Before dispatch, the bridge verifies that the SHA is exactly 40 hexadecimal characters, exists in `main`, equals the exact current `main` SHA, has all six required status contexts in `success`, and has a successful `Application CI` push run on `main` for the same SHA. Historical or stale main revisions cannot be deployed through this bridge.

## Dispatch inputs

The bridge forwards:

- `sha`
- `action` (`preflight` or `deploy`)
- `run_full_validation`
- `run_destructive_recovery_drill`

Omitting `--deploy` always results in preflight-only behavior. Selecting `--deploy` always requires `run_full_validation=true`.

## Run creation confirmation

Before creating a new dispatch, the bridge checks repository workflow runs for an existing queued or in-progress official `Staging Readiness` workflow_dispatch run for the same exact current `main` SHA. When one exists, it reports that Run ID and does not create a duplicate.

The dispatch request pins GitHub REST API version `2026-03-10`, sends the recommended GitHub JSON media type, and sets `return_run_details: true`. A valid response must have HTTP status `200` and include a positive integer `workflow_run_id`.

The bridge then fetches that exact Run ID and independently verifies that it:

- uses event `workflow_dispatch`;
- uses branch `main`;
- has `head_sha` equal to the requested exact current `main` SHA;
- is `.github/workflows/staging-readiness.yml`.

Only then does it post `Staging readiness workflow run created` with the actual workflow Run ID, run link, status, full-validation flag, destructive-drill flag, source command comment ID, and bridge Run ID.

A response without valid run details or a returned Run that does not match the exact workflow, event, branch, and SHA fails the bridge. The bridge does not use timestamp polling as a substitute for an exact Run ID and never treats an empty or deprecated API response as successful workflow creation.
