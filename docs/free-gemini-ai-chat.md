# Free Gemini AI chat

## Purpose

The app AI chat is a read-only public-information assistant for:

- public stock and market questions
- company, quote, news, and financial-context summaries
- technical-analysis and investing-term explanations
- app usage guidance

It does not execute orders, automated trading, account or position changes, server commands, GitHub operations, deployments, or secret changes.

## Deployment and secret boundary

The repository may contain a GitHub Actions secret named `GEMINI_API_KEY`. GitHub Actions secrets exist only inside the workflows that explicitly receive them. They do not automatically become environment variables on the running application server.

This PR changes only application code, tests, and documentation. It does not:

- change GitHub Actions secrets
- change application-server environment variables
- change deployment, staging, production, PM2, Caddy, database, or Supabase configuration
- expose a secret value in browser responses, prompts, logs, tests, or documentation

Mapping `GEMINI_API_KEY` into the application server is a separate deployment action that requires explicit user approval.

## Provider resolution and cost control

Provider selection is fail-closed:

1. `AI_CHAT_PROVIDER=gemini`, `google`, or `google-gemini`
   - key: `AI_CHAT_API_KEY`, otherwise `GEMINI_API_KEY` or `GOOGLE_API_KEY`
   - model: `AI_CHAT_MODEL`, otherwise `GEMINI_MODEL`, otherwise `gemini-3.1-flash-lite`
2. `AI_CHAT_PROVIDER=openai-compatible`
   - requires both `AI_CHAT_API_KEY` and `AI_CHAT_MODEL`
3. when no explicit provider is selected
   - Gemini is enabled only when `GEMINI_API_KEY` or `GOOGLE_API_KEY` exists

Unknown provider names and incomplete configurations return `AI_CHAT_NOT_CONFIGURED`.

The AI chat never reads `TRADING_REVIEW_PROVIDER`, `TRADING_REVIEW_API_KEY`, or `TRADING_REVIEW_MODEL`. It therefore cannot silently reuse another feature's credentials or switch to a paid provider after Gemini quota exhaustion.

Gemini quota or HTTP 429 responses return `AI_CHAT_RATE_LIMITED`. No paid fallback is attempted.

## Public-data contract

For a selected KR or US stock, the server collects the existing public context through the repository's services:

- quote
- company profile
- news
- financial ratios and health

Each successful answer includes a data disclosure:

- `status`: `not_requested`, `complete`, `partial`, or `unavailable`
- `asOf`: the server collection time
- `basis`: `server_collection_time`
- `sources`: the public service/provider categories included in the prompt
- `missing`: data categories that were unavailable

`asOf` is the time the application server assembled the context. It is not represented as an exchange tick timestamp.

The server excludes deterministic sample financials from AI factual context. When live financial data is unavailable, financials are marked missing instead of sending sample values to the model.

Current-price, latest-news, or other real-time questions without a valid selected instrument return an explicit data-unavailable answer without calling the model. The server does not ask the model to invent current market facts.

Crypto selections currently do not have an authoritative AI-chat context adapter. They are reported as unavailable rather than being inferred from a similarly named stock or an unsupported symbol.

## Symbol and context validation

The selected market and symbol must match the market contract before any provider call:

- KR: six digits
- US: supported ticker characters and length
- UPBIT: quote/base pair such as `KRW-BTC`
- BITGET: supported perpetual-market symbol form

Invalid or mismatched context returns `AI_CHAT_INVALID_CONTEXT`. The model is never asked to guess the intended instrument.

## Privacy and safety boundary

Before any model request, the server:

- normalizes and length-limits the question and context
- removes HTML-like input
- blocks API keys, bearer tokens, private keys, account numbers, birth dates, resident-registration-number patterns, passwords, and similar sensitive values
- refuses order execution, order cancellation, automated-trading activation, position closing, leverage/account/key changes, GitHub/server/deployment commands, and illegal or abusive financial actions
- sends only the sanitized public-information contract

The Gemini key is sent only in the `x-goog-api-key` request header. It is not included in the model prompt or returned to the browser.

Model output is rejected when it is empty, structurally malformed, requests a secret, promises returns, gives certain buy/sell instructions, or otherwise violates the advisory-only contract.

## Failure contract

- `AI_CHAT_PRIVATE_DATA_FORBIDDEN`: sensitive input or context blocked before outbound access
- `AI_CHAT_INVALID_CONTEXT`: market and symbol contract mismatch
- `AI_CHAT_NOT_CONFIGURED`: no approved provider configuration
- `AI_CHAT_RATE_LIMITED`: application rate limit or provider quota/HTTP 429
- `AI_CHAT_TIMEOUT`: the server's bounded request time elapsed
- `AI_CHAT_CANCELLED`: the user disconnected or explicitly cancelled
- `AI_CHAT_INVALID_RESPONSE`: provider JSON or response shape was malformed or empty
- `AI_CHAT_UNSAFE_RESPONSE`: provider output violated the safety contract
- `AI_CHAT_PROVIDER_ERROR`: provider failed without exposing its response body or credentials

The authenticated route remains limited to 20 requests per user per minute and returns `Retry-After: 60` for that application-level limit. Responses use `Cache-Control: no-store`.

## Cancellation limitation

The AI provider request receives an `AbortSignal` and is actively aborted on timeout or user cancellation. Existing market, news, and financial service APIs do not currently accept an `AbortSignal`; the chat request stops waiting for them, but an already-started internal public-data request may finish in the background. No account, order, or private provider is involved.

## Validation

The combined existing and hardening tests verify:

- Gemini request URL, request body, low thinking level, and `x-goog-api-key` header
- no secret in the prompt or browser response
- no automatic paid fallback or cross-feature credential reuse
- Gemini quota/HTTP 429 handling
- timeout and user cancellation as separate outcomes
- malformed and structurally empty provider responses
- sensitive input and context blocking before outbound access
- unsafe model-output blocking
- prohibited actions making zero provider calls
- market/symbol mismatch making zero provider calls
- current-data questions without authoritative context making zero provider calls
- explicit source, server collection time, and missing-data disclosure
- exclusion of sample financial data from factual AI context

Full repository validation remains the required gate: frontend and backend typecheck, application regression tests, production builds, browser tests, AI privacy and zero-outbound checks, and all required CI statuses.
