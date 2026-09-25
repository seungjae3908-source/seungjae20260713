# Research Center + video integration, Phase 1 (Draft only)

Existing owner #1042, Central Hub #1102. Research experiment owner #1350 and
canonical Paper/observer workers remain separate and unchanged. The original
#1042 branch is not aligned with current main and was mergeable=false at intake.
This increment does not rebase/merge it or fix that release conflict implicitly.

## Delivered

- Pure read model joins sanitized YouTube metadata, source-bound access receipts,
  timestamped rule segments, separately labeled AI assumptions, strategy versions
  and archived backtest summaries. It does not fetch content or invent rules.
- Market filters: KR/US stocks, crypto spot/futures. An unclassified video remains
  UNKNOWN; a title mentioning BTC is not a verified market classification.
- Missing != zero; stale/wrong SHA/invalid record dates fail closed. Available
  captions alone remain METADATA_ONLY and do not prove transcript ingestion.
- A run must match strategy/version/market/timeframe, carry source/result/code/data
  identity, cost declaration and its own numerical-summary checksum. Hashes are
  integrity bindings, not authenticated signatures or proof the producer is true.
- Model results remain archived reports, not independently verified OOS. Daily
  return/target and win probability remain null/NOT_EVALUATED. No aggregate-to-daily
  conversion, no economic sample credit and no automatic adoption.
- Read-handler adapter requires explicit authorization, existing sanitized loader,
  registry loader and trusted policy. GET only, no-store, redacted I/O failures.
- Offline review UI: four sections, stock/crypto filters, evidence details and
  disabled adoption actions. Real input CLI and clearly labeled fixture preview.

## Integration boundary (not yet mounted)

The adapter does NOT register an HTTP endpoint. A later owner-controlled change
must mount it after existing authentication and capability middleware, reusing
`sanitizeVideoResearchRuntimeEvidence` and `loadVideoResearchRuntimeEvidenceSnapshot`
from `api-server/src/routes/video-research-evidence.ts`. Never pass raw request JSON
or derive trust policy from the candidate snapshot. Provide a server-controlled
expected snapshot SHA and staleness policy. Do not reuse production deployment SHA
as an evidence SHA without a binding policy.

The registry is an injected read-only source. This increment adds no database,
registry publisher, server timer, lease queue or default populated results. Missing
publisher is MISSING, not empty successful research. Runtime worker state remains
UNVERIFIED. The HTML artifact is a review surface, NOT the mounted React app.

## Source access and user decisions

AUTHORIZED_TRANSCRIPT records authorized source-text access; OFFICIAL_VIDEO_ANALYSIS
records a provider response with identity, not a claim of complete frame coverage.
Gemini/Groq existing clients may supply records after a separate allowed execution.
No provider client or paid fallback is added here. YouTube Data API metadata and
caption availability do not prove caption-download permission. Source excerpts
are bounded; URLs/times are retained. No caption or payment bypass.

Rules carry SOURCE_RULE or AI_ASSUMPTION. Missing entry/exit/stop/sizing/execution
assumptions block compiler handoff. The output requests canonical compiler review;
it neither compiles a new engine nor schedules a backtest. All actions other than
inspection remain false even after a positive/validation-labeled producer result.
Strategy adoption must later bind user, exact strategy version, purpose, evidence,
expiry/revocation and account risk through the canonical permission owner.

## Local reproduction

    node --test packages/external-research/test/research-workspace*.test.js
    node packages/external-research/scripts/research-workspace-review-v1.mjs \
      --policy /absolute/trusted-policy.json \
      --snapshot /absolute/sanitized-video-snapshot.json \
      --registry /absolute/read-only-registry.json \
      --output /absolute/review-output

The policy JSON contains now (canonical ISO for offline replay), expectedSourceHeadSha
and maxAgeMs. Online adapters replace now with the server clock. Omitting a registry
keeps results MISSING. The CLI reads local bounded JSON only. `--test-fixture` marks
synthetic QA input visually; it never creates real evidence/sample credit.

## Verification scope and next checkpoint

Pure contract/reader/render tests plus offline-browser review exercise malformed
input, source/run mismatch, safety promotion, class separation, missing data,
authorization, write rejection, injection resistance and layout interactions.
This is NOT real provider video inference, model training, a new financial
backtest, mounted API/React acceptance, full current-main CI or server activation.

Next: resolve #1042 current-main ownership/conflicts without overwriting other
workers, wire the read adapter to authenticated route and real stored results,
replace the temporary review surface with existing Research Center components,
then separately implement bounded durable worker/runtime health. Test an authorized
real content receipt end-to-end before any continuous research activation.

No Ready/Merge/force-push/deploy/Paper/Telegram/private trading API/real orders,
operational DB/Secret/Env changes, new schedules, or Replit in this phase.
