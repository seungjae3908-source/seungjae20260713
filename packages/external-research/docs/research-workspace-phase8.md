# Phase8 — reuse existing YouTube, Gemini and Groq configuration

Owner #1042 / Hub #1102. Parent 982320b236ca04cfa4140d506694b9b6fe3f359f.
The user has already connected these services. Missing credentials in an assistant
container are NOT evidence of missing credentials on the user's server.

## Effective runtime readout

The existing authenticated Research Center workspace router adds GET
`/api/research/video/evidence/workspace/providers`, with its existing
requireAuthenticated and canManageMembers guards plus an explicit current request
capability check. It reads THIS API process's effective process.env, not the user's
browser or a copy of a PM2 dump. No environment file path is accepted by HTTP.
Response contains three provider identities, configuration states and check time.
It contains no key, key length/hash, model value, raw environment, path or error.
PRESENT means syntactically present, never a working/authorized/paid/free account.
Model defaults are not inferred; quota, billing and actual calls stay NOT_CHECKED.
HTTP errors remain unavailable, not "all keys missing". No cross-user caching.

Existing keys are YOUTUBE_DATA_API_KEY, GEMINI_API_KEY/GOOGLE_API_KEY, GROQ_API_KEY.
AI_CHAT_API_KEY is associated only with an explicitly selected canonical Gemini
or Groq provider. Conflicting aliases are reported and video execution blocks;
unknown generic-key mapping blocks video rather than inferring a provider.
All-three coexistence is normal. Selecting Gemini sends only that key to the
existing V7 runner in a temporary object; it does not remove global env keys.
The selected video model remains the separately reviewed V7 spec, not the generic
chat model, because text-model configuration is not video capability evidence.
YouTube key presence is metadata-access configuration, not a third video LLM.

## Existing server execution entrypoint

The runnable `run-existing-research-providers-v8.mjs` wraps the existing V7 runner.
It adds no API client, strategy, backtester, auto-approval, public execution route,
PM2 action or new server job. No imported CLI runs on the API's module import.
Provider readiness module is free of CLI/network/file imports; runtime invocation
requires its explicit canonical runner dependency supplied by the CLI.

Read-only selected-process check (no network, files or key values in output):

    node packages/external-research/scripts/run-existing-research-providers-v8.mjs --preflight

An authorized operator may explicitly choose an existing private environment file
instead of inherited env. It is an ALTERNATIVE, not a merged or guessed fallback:

    node packages/external-research/scripts/run-existing-research-providers-v8.mjs --preflight --existing-env /absolute/existing/private.env

A deployment-path example is /opt/stock-app/.env, but actual existing path and
process loading must be checked before use; the program never creates this file.
This reads a bounded same-user, non-symlink, private regular file, using Node's
util.parseEnv. No shell source/eval, interpolation or process.env mutation. A file
inspection does not establish that an already-running process loaded that file.
Secure parent paths/cooperative same-UID remain assumptions, as in earlier phases.

V7 prepare (no secret access unless the optional env-file was explicitly selected):

    node packages/external-research/scripts/run-existing-research-providers-v8.mjs --spec /absolute/spec.json --output-root /absolute/private-output

Explicit V7 one-shot call after the existing separate plan approval:

    node packages/external-research/scripts/run-existing-research-providers-v8.mjs --spec /absolute/spec.json --output-root /absolute/private-output --execute --approval /absolute/approved-call.json

Add `--existing-env` only to use that reviewed existing file. The in-process API
readout never offers this path selector or an execute action. Existing V7 approval,
model/clip limits, immutable reservation, one-call bound and no fallback survive.
No key is sent to the chat or saved into code/results. No provider request is sent
by preflight. An actual request would remain MODEL_OBSERVATION/review-pending.
This command has NOT been run against the user's server or real provider here.

## User-visible readout

Research Center -> 영상 -> 전략·백테스트 shows YouTube/Gemini/Groq cards. It
clearly distinguishes 설정 확인, 현재 실행환경에서 미확인, 설정 충돌 and unknown
readout. Refresh resets state; failed refresh cannot leave old success displayed.
The fetch has timeout/unmount cancellation. Strategy results remain usable when
provider diagnostics fail. No call-verification or quota numbers are invented.

## Test and integration boundaries

Temporary synthetic env/files/credentials, native HTTP with injected auth and
V7 synthetic HTTP are used. The successful video bridge test actually calls the
existing V7 functions and preserves duplicate/expired-approval checks, but it does
NOT call Gemini, YouTube or Groq. Existing 332 tests are preserved.
Initial separate-process test detected a Node CLI collision with --env-file
(handled by Node before application error handling). Renamed to --existing-env,
then repeated the subprocess test; no relaxed assertion or test deletion.
Full app tests add provider cards at four widths and unavailable/refresh/forged
response cases. Authentication and API responses are synthetic, not production.
Actual final counts and exact CI results belong in the completion report, not
pre-assumed by this spec. No model-performance or profitability conclusion.

## Remaining work

Deploy or run in an authorized existing server environment only after release
approval; read THIS runtime's statuses, review an exact real video request, then
execute once through the existing key/approval path. No key re-registration needed.
Durable queue/heartbeat/recovery, real result publication/readback and strategy
adoption remain separate missing runtime capabilities, not completed by readiness.
No 24h activation, schedule changes, Ready/Merge/deploy, real orders/private trading
API, Paper activation, Telegram send or Replit in this increment. #1350 untouched.
