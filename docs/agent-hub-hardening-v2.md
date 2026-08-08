# Agent Hub schema-v2 audit hardening

This document describes only the audit-blocker fixes layered on the existing PR #70 implementation.

## Prompt state

The existing five-block Prompt Compiler remains authoritative. A state adapter adds `previous_state`, `current_state`, and an exact `state_delta` to the existing `GOAL` block and preserves the same evidence compression, mandatory evidence, first/final error, and evidence-ID validation behavior. Compact state snapshots contain repository/worker/branch/status/SHA/PR/CI/change-list digests only.

## Deterministic risk verification

Profile selection and risk are separate. The first model response is parsed as untrusted evidence and evaluated by the Python policy engine. Only a deterministic final `medium` risk requires a second independent model response. Disagreement in proposal or deterministic safety fields returns a non-executable state.

## Immutable GitHub evidence

Completed reports accept only an exact-success workflow run whose `head_sha` matches the report for every author, including `github-actions[bot]`. Named PRs must be open, same-repository, and match the reported head/base identity. Changed reports require all six required commit statuses to be exactly `success`; neutral, skipped, cancelled, timed-out, and action-required results are not success.

Executor success is reported as `partial` until an exact-head required-CI report exists. An intentionally skipped executor job is not treated as a required status.

## Executor boundary

Read-only Gemini has only repository read/search tools. Code-change Gemini may use `write_file` and `replace` only inside the temporary local workspace. Gemini has no shell, GitHub write, arbitrary network, MCP, extension, skill, Secret, commit, push, PR, merge, or deployment tool. Deterministic workflow steps validate the diff before one commit and an owned Draft PR.

The hardened diff gate validates tracked and untracked files as regular UTF-8, rejects binary/symlink/delete/rename/copy changes, normalizes ASCII paths with NFKC stability and case-insensitive forbidden matching, enforces file/line limits, and rejects Bearer/Supabase/API-key material.

## Privacy boundary

Secret-like content and meaningful live-account, balance, buying-power, holding, position, average-price, open-order, order-ID, fill, or order request/response data are blocked before Gemini. The Issue result is a generic blocked record with model calls, artifact storage, and paid fallback all zero; no matched category or source fragment is copied.

## Legacy transition

The runtime gate accepts only sealed `schema_version: 2` commands. Schema-v1 accepted count is always zero. The read-only migration helper classifies historical comment IDs and creates a post-merge `[HUB_MIGRATION]` plan without executable report/command markers. It is not run before merge and does not edit Issue #62.
