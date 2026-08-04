# Agent Hub Prompt Compiler Validation

- Baseline main SHA: `7b35f8c2dee8f2e3a2025d62422cfa886e6e7d68`
- Branch: `agent/prompt-compiler-v1`
- Policy version: `prompt-compiler-v1`
- Provider: `gemini-developer-api-free`
- Paid fallback: disabled

## Prompt structure

- `[ROLE]`
- `[GOAL]`
- `[EVIDENCE]`
- `[CONSTRAINTS]`
- `[OUTPUT_SCHEMA]`

The original `WORKER_REPORT` is never inserted into the system prompt. Parsed values and compressed logs are serialized as untrusted evidence only.

## Profiles

- `ci_analyzer`
- `code_fix_planner`
- `test_planner`
- `conflict_analyzer`
- `security_reviewer`
- `release_validator`
- `ui_reviewer`

## Compression fixture

A synthetic report containing 300 dependency-download progress lines, 100 duplicate success lines, and separate first/final errors produced:

- Before compression: `15,018` characters
- Retained evidence after compression: `2,746` characters
- Reduction: `81.72%`
- Final five-block prompt: `6,361` characters
- Retained evidence items: `20`
- First error, final error, error file/line, HTTP 502, HEAD, base SHA, CI Run, Job, and changed files: retained

## Gemini call policy

- deterministic `needs_context`: `0` model calls instead of the previous unconditional `1`
- deterministic `no_action`: `0` model calls instead of `1`
- low risk: `1` call
- medium risk: `2` independent calls; exact agreement required
- high risk: at most `1` analysis call and automatic `ready` is impossible

Representative five-case policy fixture (`needs_context`, `no_action`, low, medium, high): previous unconditional flow `5` calls, compiler policy `4` calls, a `20%` net reduction while adding independent verification for medium risk.

## Tests

- Long duplicate logs compressed: passed
- First and last errors retained: passed
- HEAD, CI Run, Job and changed files retained: passed
- Missing information returns `needs_context`: passed
- Unknown evidence ID blocked: passed
- Prompt injection isolated as untrusted evidence: passed
- Previous state delta only and changed HEAD stale marker: passed
- Low risk one call: passed
- Medium risk two-call agreement: passed
- Medium disagreement never ready: passed
- High risk automatic ready count zero: passed
- Gemini failure fail-closed: passed
- Free quota 429 has no paid fallback or retry: passed
- Secret input blocked before model: passed
- Missing output schema field blocked: passed
- Schema/state marker transport: passed

Total: `16/16 passed` locally before branch publication.

## Remaining limitations

- Log classification is deterministic regex-based and may request exact context for uncommon log formats.
- Compact state is stored in signed-by-policy Issue comment markers rather than a database.
- Medium-risk results must match exactly on safety-critical fields; disagreement returns `needs_context` instead of choosing one answer.
- Gemini free-tier 429 or outage blocks the task; there is no paid fallback or automatic retry.
- Profile selection uses an explicit report profile when valid, otherwise deterministic evidence/keyword rules.
