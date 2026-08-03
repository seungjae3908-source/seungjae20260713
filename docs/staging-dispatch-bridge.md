# Staging Dispatch Bridge

## Purpose

The bridge accepts one owner-only command on issue `#23` (`Staging Readiness Control`) and dispatches `.github/workflows/staging-readiness.yml` from `main`.

It never reads staging secrets and never targets production.

## Commands

Preflight is the default and changes nothing on the server:

```text
/run-staging <exact-40-character-main-sha>
```

Explicit non-destructive deployment:

```text
/run-staging <exact-40-character-main-sha> --deploy
```

Deployment plus four-account browser validation:

```text
/run-staging <exact-40-character-main-sha> --deploy --full-validation
```

The existing staging-only destructive drill remains an additional explicit flag and must never be used without separate approval:

```text
/run-staging <exact-40-character-main-sha> --deploy --destructive
```

Flags may not be duplicated and no unknown text is accepted. `--full-validation` and `--destructive` require `--deploy`.

## Authorization and CI gate

The command is accepted only when the issue remains open, the author is exactly `seungjae3908-source`, GitHub reports `OWNER`, and the comment is a newly created issue comment rather than a pull request comment.

Before dispatch, the bridge verifies that the SHA exists in `main`, all six required status contexts succeeded, and a successful `Application CI` push run exists on `main` for the same SHA.

## Dispatch inputs

The bridge forwards:

- `sha`
- `action` (`preflight` or `deploy`)
- `run_full_validation`
- `run_destructive_recovery_drill`

Omitting `--deploy` always results in preflight-only behavior.
