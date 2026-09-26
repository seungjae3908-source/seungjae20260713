# Phase7 — executable public-video research task (Draft; not activated)

Owner #1042 / Hub #1102. Resumes interrupted checkpoint5842374387; the base
is d28a72759c1494c488387dec123e732aa2a2930e. No general-chat guard was weakened.

## Delivered path

`run-research-video-v7.mjs` -> reviewed immutable video plan -> official Gemini
GenerateContent video part -> one bounded HTTP request -> raw response and
strict unverified observation receipt. This is a VIDEO-specific task adapter,
not a URL inserted into the previous text chat. It reuses existing credential
names, not the generic answerAiChat request builder. Qualitative Gemini/Groq
reviewers, text extraction, auth, publication, UI and backtesting stay unchanged.
Groq is not silently substituted for a video-capable provider.

The selected video must have the exact public YouTube watch URL (11-char ID),
a reviewer identity, duration and an explicit clip of at most 300 seconds.
The requested model and acceptable reported model versions are explicit; no
model is silently selected from documentation or changed after an error.
`fileData.fileUri` + `videoMetadata.startOffset/endOffset/fps` are sent to the
existing official `generativelanguage.googleapis.com/v1beta/models/...:generateContent`
API family. The key is a header only. No tools, trading calls, redirects, scraping,
caption permission bypass, file download or safety-setting overrides are added.

## Runnable commands (Node22; private local Linux filesystem)

Use existing reviewed inputs; this code does NOT create an approval. The input
and approval files must be private owner files and root must already exist as a
private owner directory. Do not put test fixtures in a runtime input directory.

Prepare only (does not inspect a key or use the network):

```sh
node packages/external-research/scripts/run-research-video-v7.mjs \
  --spec /absolute/reviewed-video-spec.json \
  --output-root /absolute/private-research-output
```

After an independently reviewed exact-plan call approval, manual one-shot:

```sh
node packages/external-research/scripts/run-research-video-v7.mjs \
  --spec /absolute/reviewed-video-spec.json \
  --output-root /absolute/private-research-output \
  --execute \
  --approval /absolute/reviewed-video-call-approval.json
```

Spec fields (strict keys): schemaVersion=research-video-spec-v7, videoUrl,
sourceReviewId, publicAccessReviewed=true, durationSec, clipStartSec, clipEndSec,
model, acceptedReportedModels, maxOutputTokens(256..2048), timeoutMs(1000..60000).
Approval fields: schemaVersion=research-video-call-approval-v7, approvalId,
planDigest, notBefore, expiresAt, maxCalls=1, sourceUseApproved=true,
freeTierReviewed=true, paidFallback=false, executionAuthority=NONE. Max lifetime
one hour. They are supplied by the trusted operator, never from the model/browser.
This file-based manual consent is NOT the app's user-authenticated publication
grant. Later HTTP/server integration must bind the existing current-user authority;
this step installs no user-facing write endpoint and grants no new capability.

Only GEMINI_API_KEY or GOOGLE_API_KEY is read at execution, after consent.
Conflicting keys/generic paid overrides fail closed; no environment mutation or
credential values are emitted. `freeTierReviewed` is an external operator assertion,
not proof of billing status or remaining quota. Quota review is a prerequisite.

## Safety and recoverability

Exact request hash includes source clip/model/budget/system prompt. The private
plan is frozen and cannot be reconstructed by passing an unchecked JSON object.
One attempt per plan object; a persistent approval/plan reservation is fsynced
before sending. Shared trusted output root is required across cooperating workers.
Approval is reread before sending, including after reservation. Unknown outcome,
crash or repeated execution stays blocked; no silent retries or time-based lock
stealing. External authorization/file revocation is not globally transactional
with the remote API: the final-check-to-send race is not eliminated.

Request+response deadline includes approval and body reads. At most256KiB of raw
response is retained; redirects, wrong content types, unfinished output, tool
outputs, model drift, invalid JSON, duplicate claims, unknown fields, timestamps
outside the selected absolute interval and sensitive content fail closed.
A response that echoes credentials is not exported; only its digest is retained.
Missing usage is unknown, not zero cost. A source URL hash is not a video-byte hash;
YouTube content can change. Full video identity/availability and precise frame
coverage are NOT verified by this code. Safe local parents/cooperative sameUID
are assumptions, not hostile sameUID/NFS isolation or global exactly-once service.

## Result semantics and next integration

Prepare writes plan.json, request.json and PREPARED_NOT_EXECUTED receipt only.
Execution additionally retains actual provider-response.json (unless sensitive)
and a receipt. On failure it keeps a failed/uncertain outcome, not a fake answer.
The response schema asks for short paraphrases, not a full transcript. It allows
12observations and8limitations. Every observation is MODEL_OBSERVATION with
semanticReview=PENDING and timestampVerified=false. No SOURCE_RULE conversion,
false exact quotation, daily PnL, success probability or completed backtest.

A received reply is RESPONSE_RECEIVED_REVIEW_REQUIRED, NOT a verified video
strategy. `run=null`; autoCompile/autoPublish/automaticAdoption=false; actualOrders
and canonicalSampleDelta remain zero. Reviewer must align times and verify the
meaning against source before creating Phase1–6 compatible source-rule artifacts.
Only then can missing rules and matching data be passed to the existing compiler.

No production queue/job/HTTP route/cron/DB/Secret/Env/scheduler/24h process,
publisher invocation, Paper/Telegram/trading activation, Ready/Merge or Replit.

## Verification performed in this development step

268 previous offline tests +64 new tests =332PASS. New tests execute the actual
request builder, deadline/body cancellation, raw response handling, approval
checks and manual CLI using explicitly SYNTHETIC HTTP replies/private tempfiles.
No live Gemini response, provider billing/quality, actual video inference or new
financial backtest is claimed. The work environment reported neither Gemini key
name present; production keys were not inspected. Existing app/HTTP/type/build
CI is rerun separately on the exact committed HEAD, not inferred from local tests.

## Official references checked 2026-09-26

- https://ai.google.dev/gemini-api/docs/generate-content/video-understanding
- https://ai.google.dev/api/generate-content
- https://ai.google.dev/gemini-api/docs/rate-limits

The GenerateContent video guide explicitly documents public YouTube fileData and
clip offsets. Video URL support/limits can change; model examples in documentation
are NOT defaults adopted by this task. Current Interactions guide also exists,
but this bounded increment uses the documented GenerateContent path consistent
with the application's current API family.
