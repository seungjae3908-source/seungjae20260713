# Free Gemini AI chat

## Purpose

The app AI chat uses the Gemini Developer API free tier for:

- public stock-market questions
- company, quote, news, and financial-context summaries
- technical-analysis and investing-term explanations
- app usage guidance

It does not execute orders, automated trading, account changes, server commands, GitHub operations, or deployments.

## Existing repository secret

The repository already has an Actions secret named `GEMINI_API_KEY`, introduced for the free Agent Hub workflow.

The application server now accepts the same environment variable, so a duplicate AI-chat secret is not required.

GitHub Actions secrets are available only inside workflows. They do not automatically appear in the running application server. A later deployment change must explicitly map `GEMINI_API_KEY` into the server runtime environment. This PR does not change deployment, server, staging, production, database, or secrets.

## Provider resolution

AI chat selects its provider in this order:

1. `AI_CHAT_PROVIDER=gemini`, `google`, or `google-gemini`
2. `AI_CHAT_PROVIDER=openai-compatible`
3. when no explicit provider is set, an available `GEMINI_API_KEY` or `GOOGLE_API_KEY`
4. the existing `TRADING_REVIEW_PROVIDER=openai-compatible` compatibility fallback

Gemini credentials:

- primary: `GEMINI_API_KEY`
- compatible alias: `GOOGLE_API_KEY`
- optional override: `AI_CHAT_API_KEY`

Gemini model:

- default: `gemini-3.1-flash-lite`
- optional override: `AI_CHAT_MODEL`
- compatible override: `GEMINI_MODEL`

The default matches the repository's already validated free-tier Gemini smoke workflow.

## Data boundary

Before any provider call, the server:

- normalizes and length-limits the question
- blocks API keys, tokens, account numbers, birth dates, and other sensitive values
- refuses actual-order, automated-trading, account, server, GitHub, and deployment actions
- collects only existing public quote, company, news, and financial context for KR and US selections
- sends the provider a JSON public-information contract
- rejects empty or unsafe model output

The API key is sent only in the `x-goog-api-key` request header and is never included in the model prompt or browser response.

## Free-tier behavior

- the existing authenticated route rate limit remains 20 requests per user per minute
- Gemini HTTP 429 responses map to `AI_CHAT_RATE_LIMITED`
- no paid-provider fallback is attempted after Gemini quota exhaustion
- provider failure returns a closed error instead of a fabricated answer
- user cancellation and the existing 20-second server timeout remain active

Free-tier quotas are project-level and can change in Google AI Studio. Inputs sent under the free tier may be used by Google to improve its products, so the existing sensitive-data filter remains mandatory.

## Validation

Unit coverage verifies:

- `GEMINI_API_KEY` automatically enables Gemini
- default model selection
- `x-goog-api-key` header use
- no API key in the prompt body
- Gemini response extraction
- quota-error mapping
- explicit OpenAI-compatible configuration remains supported
- missing configuration fails closed
- prohibited actions never call a provider
