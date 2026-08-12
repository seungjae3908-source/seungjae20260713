# Safe Parallel Work Runbook

This document defines the default coordination rules for parallel feature, research, CI, and release work in this repository.

## 1. Read current state before changing code

Before every change:

1. Resolve the latest `main` SHA.
2. List open Draft PRs and identify the owner of each touched path.
3. Check whether the target PR HEAD moved since the last inspection.
4. Check exact-HEAD CI status before adding another commit.

If either `main` or the target PR moves during inspection, re-evaluate before writing.

For recurring reviews, persist or record the previous observed `main` SHA, target PR HEADs, and relevant run IDs in the report context. The next review should compare against those exact identifiers instead of inferring change from timestamps alone.

## 2. Ownership and overlap rules

Treat an active Draft PR as the owner of the files it currently changes. Do not edit those files from another lane unless the work is explicitly a coordinated integration step.

Prefer, in order:

- existing owner PR for a directly related fix;
- a new isolated module or test file that does not overlap active paths;
- documentation-only work when all meaningful product paths are actively owned;
- observation only when any write would create conflict risk.

Do not create a duplicate implementation to bypass ownership.

An old PR description is not proof of current ownership state. Re-list changed filenames from GitHub before writing, because rebases, merges, cleanup commits, or branch updates can change overlap even when the PR title and body stay the same.

## 3. CI-first correction rule

For a failing PR:

1. Identify the exact failing job and step.
2. Confirm whether earlier typecheck/test phases passed.
3. Inspect the diff against the failing contract.
4. Change only the smallest owning file set that explains the failure.
5. Re-run exact-HEAD validation.

Do not weaken assertions, add arbitrary sleeps, inflate timeouts, skip tests, or re-run repeatedly to hide a deterministic failure.

Infrastructure-only failures must not trigger unrelated product-code changes.

A successful run is reusable evidence only when its tested SHA matches the current PR HEAD or current `main` SHA exactly. Historical success from an older HEAD must be labeled historical rather than current.

## 4. Safe automatic-improvement scope

Allowed low-risk work:

- regression-test coverage;
- deterministic validation helpers;
- documentation and ownership/runbook improvements;
- non-destructive performance work that preserves data freshness and safety contracts;
- narrowly scoped fixes inside the owning Draft PR.

Never perform automatically:

- direct changes or pushes to `main`;
- merge, auto-merge, or Ready-for-review transitions;
- Staging or Production deployment;
- PM2, Caddy, server, Secret, or environment changes;
- Production database or migration application;
- private brokerage/exchange/account calls;
- real order, cancel, amend, transfer, or withdrawal;
- enabling automatic live trading.

## 5. Merge and release evidence

A PR is not considered integration-ready merely because local tests pass. The preferred evidence is exact PR HEAD CI covering the repository's required status set.

After any merge to `main`, treat the new SHA as a new release baseline and verify its exact-main statuses before relying on earlier evidence.

Staging and Production readiness remain separate gates and are never inferred from a successful feature-branch CI run.

If `main` advances after a PR's latest green CI, report the PR as tested on its own exact HEAD but not yet proven against the new integration baseline unless its base relationship and conflict state are rechecked.

## 6. Research and trading safety

Research, backtest, Paper, Shadow, and live execution are separate stages.

Do not promote a strategy based only on win rate. Preserve cost, sample-size, out-of-sample, walk-forward, drawdown, expectancy, and provenance requirements. Missing evidence remains missing; do not fabricate substitute metrics.

AI and advisor components may explain or propose, but must not gain direct order authority through coordination work.

## 7. Hourly status reporting contract

Each status review should report:

- changes since the previous review;
- current `main` SHA and exact-main CI state;
- active Draft PRs and major CI changes;
- feature-area completion estimates explicitly labeled as evidence-based estimates;
- newly added work;
- blockers and overlap risks;
- the next three highest-value safe candidates.

When no conflict-free code change exists, report that fact and prefer observation over unnecessary churn.

The change summary should distinguish:

- `NEW`: SHA, PR HEAD, CI conclusion, or changed-file ownership changed since the previous review;
- `UNCHANGED`: exact identifiers are the same;
- `STALE_EVIDENCE`: a result is still historically useful but no longer matches the current SHA;
- `BLOCKED_BY_OVERLAP`: a candidate touches files owned by another active PR;
- `OBSERVATION_ONLY`: no safe write was justified.

## 8. Pre-write and post-write race check

Immediately before a write, re-read both the latest `main` SHA and the target PR HEAD. After the write, re-read them again.

Stop further writes in that review if:

- `main` moved unexpectedly;
- another actor moved the target PR HEAD after the pre-write check;
- changed-file ownership now overlaps another active PR;
- a new failing exact-HEAD CI signal appears that could be caused by the just-written change.

Do not "catch up" automatically with merge, rebase, force push, or cherry-pick. Re-evaluate first and keep the PR Draft.
