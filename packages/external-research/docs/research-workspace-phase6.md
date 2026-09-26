# Phase6 — source text to exact-quote draft, canonical AI transport integration

Owner #1042 / Hub #1102. Builds on 67b8c054. No release or runtime activation.

## What runs

`prepareTranscriptIntake` accepts reviewed text and explicit UTF-16 offset ranges.
It hashes the exact supplied text and stores selected excerpt coverage. It does
not download a URL or equate a supplied excerpt with the whole video. Real timed
transcript cues and untimed creator-page excerpts are different inputs. Untimed
inputs retain null seconds and cannot become the existing timed workspace receipt.
The content reviewer binds source identity/text hash/use permission/data class;
that is a caller-reviewed assertion, not consent established by a hash.

`extractTranscriptRules` makes at most eight predeclared calls through an injected
canonical invoker, one per selected chunk. It accepts exact source quotations and
allowed rule categories, not invented thresholds, returns, probabilities or code.
Quotes must appear uniquely in their supplied excerpt. Missing rules stay missing.
The model's semantic classification is NOT certified by matching a quotation;
a separate exact-trace review is required before preparing a workspace draft.
Incomplete calls, refusals, model mismatch, missing invoker or quota failure cannot
be presented as complete analysis. Successful calls retain the normalized canonical
answer/model/time/prompt hash; original provider HTTP responses are not retained.

`createCanonicalTranscriptInvoker` calls the EXISTING `answerAiChat` service.
It does not create a parallel SDK/client or edit shared provider/global auth code.
Caller must run an isolated, explicitly configured Gemini OR Groq worker, provide
an exact model and approve the exact prompt digest. This adapter does not mutate
environment or read secrets into output. Other-provider and paid/generic fallback
configuration is refused. Route/model/POST checks and external abort are enforced
before the single outgoing request. The caller's free-tier confirmation is not
independent proof of actual account pricing/quota.

Existing chat normalizes and bounds questions to 2,000 characters. We cap at 1,900
and compare against its validator before sending: no silent truncation/NFKC/HTML
loss. We do NOT hide source words to bypass existing refusal/current-data rules.
Sources hitting those rules are blocked and need a separately reviewed canonical
research task mode, not a new ungoverned transport. Current integration is TEXT
only; passing a YouTube URL to this adapter is not multimodal video analysis.

`prepareExtractedWorkspaceDraft` joins a timed, semantically reviewed extraction
with the existing sanitized video snapshot, preserving the exact source/duration
and content envelope used by Phase4/5. It returns actual content artifact bytes and
a trace for a trusted archive producer, reusing the original validator and UI parser.
It does not execute a compiler/backtester or publish a registry. `run` stays null;
missing exit/sizing/cost rules remain RULES_INCOMPLETE. Source-specific prices from
one case are not a generalized executable strategy. All adoption is disabled.

## Real source intake inspected this turn

Creator-published SMB page, dated 2020-12-23:
https://www.smbtraining.com/blog/how-to-use-tape-reading-to-help-you-keep-your-trading-profits
The public web-extracted text was read and a small two-line excerpt was run through
the new intake code. No raw HTML bytes were obtained in the working container;
container DNS/download attempts failed. The recorded hash is of the explicitly
retained web-extracted excerpts, not a claimed hash of original HTML or a full video.
The page's visible transcript is untimed. No video seconds or Gemini/Groq response
was manufactured. The case is SOURCE_TEXT_READ / VIDEO_TIMING_MISSING /
PROVIDER_NOT_CONNECTED, with no app metadata pair, backtest or publication.
The bounded file search returned earlier synthetic views/reports, not a verified
actual model pair; this is not an exhaustive claim about all account storage.

## Scope and remaining work

This is a source-input/extraction/canonical-adapter development milestone. Tests
use synthetic provider HTTP responses and timed source fixtures, labeled SYNTHETIC.
They exercise actual canonical chat transport with fake HTTP, not real model quality
or live credentials. No operational environment variables, credentials or provider
runtime settings were changed/inspected. No continuous worker has been enabled.

Next: configure an isolated existing-provider caller under its already-defined
execution boundary, obtain authorized real timestamped text (or separately add
actual multimodal input via the supported provider contract), record actual model
responses, then review source semantics and complete the canonical compiler/data
requirements. Real source prices and data coverage must not be guessed. Runtime
publication, continuous queue/recovery and adoption remain separate approval gates.

Official API contracts checked 2026-09-26:
- https://ai.google.dev/gemini-api/docs/video-understanding
- https://developers.google.com/youtube/v3/docs/captions/download
YouTube caption download requires video-edit permission; availability is not consent.
Gemini's public-video path is not the text-only app transport implemented here.

No Ready/Merge/main/rebase/forcepush/deploy/DB/Secret/runtime Env changes, live
provider call, scheduled worker, Paper, Telegram, private trading API, order or
Replit. No new PnL, actual-fill credit, win-rate or daily-target achievement.
