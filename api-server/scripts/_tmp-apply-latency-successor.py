from pathlib import Path


def replace_once(text: str, old: str, new: str, code: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{code}: expected 1 anchor, found {count}")
    return text.replace(old, new, 1)


def insert_once(text: str, anchor: str, insertion: str, marker: str, code: str) -> str:
    if marker in text:
        return text
    return replace_once(text, anchor, insertion + anchor, code)


evidence = Path("api-server/src/services/authoritative-paper-evidence-sources.service.ts")
text = evidence.read_text(encoding="utf-8")

import_anchor = "import { fetchPublicMarketJson } from './public-market-http';\n"
latency_import = "import { buildAuthoritativePaperLatencyCostEvidence } from './authoritative-paper-latency-cost-evidence.service';\n"
if latency_import not in text:
    text = replace_once(
        text,
        import_anchor,
        import_anchor + latency_import,
        "LATENCY_IMPORT_ANCHOR_MISSING",
    )

helper_anchor = "function ownedSource<T>({\n"
helper = """function latencyPositiveScalar(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function latencyMidpoint(bid: unknown, ask: unknown): number | null {
  const normalizedBid = latencyPositiveScalar(bid);
  const normalizedAsk = latencyPositiveScalar(ask);
  if (normalizedBid == null || normalizedAsk == null || normalizedAsk < normalizedBid) return null;
  return (normalizedBid + normalizedAsk) / 2;
}

function latencyTickerObservation(
  payload: unknown,
  symbol: string,
  observedAtMs: number,
): Readonly<{ midpoint: number; observedAtMs: number; source: string }> | null {
  const envelope = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  if (!envelope || envelope.code !== '00000' || !Array.isArray(envelope.data) || envelope.data.length !== 1) {
    return null;
  }
  const rawRow = envelope.data[0];
  const row = rawRow && typeof rawRow === 'object' && !Array.isArray(rawRow)
    ? rawRow as Record<string, unknown>
    : null;
  if (!row) return null;
  const rowSymbol = String(row.symbol ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/gu, '');
  const midpoint = latencyMidpoint(row.bidPr, row.askPr);
  const providerTimestampMs = latencyPositiveScalar(row.ts);
  if (rowSymbol !== symbol || midpoint == null || providerTimestampMs == null || !naturalPositive(observedAtMs)) {
    return null;
  }
  return Object.freeze({
    midpoint,
    observedAtMs,
    source: `BITGET_PUBLIC_V2_TICKER_RECEIPT:providerTs=${String(providerTimestampMs)}`,
  });
}

"""
text = insert_once(
    text,
    helper_anchor,
    helper,
    "function latencyTickerObservation(",
    "LATENCY_HELPER_ANCHOR_MISSING",
)

execution_anchor = """          const executionObservation = buildAuthoritativePaperExecutionObservation(executionInput);
          const slippagePercent = executionObservation.slippage.valuePercent;
          if (!Number.isFinite(slippagePercent) || slippagePercent < 0) return partial;
"""
execution_replacement = """          const executionObservation = buildAuthoritativePaperExecutionObservation(executionInput);
          const slippagePercent = executionObservation.slippage.valuePercent;
          if (!Number.isFinite(slippagePercent) || slippagePercent < 0) return partial;

          // #777 successor binding. Prefer a latency cost derived from the exact
          // public-L2 request used by this Natural candidate. If its fresh post
          // ticker bracket is unavailable, preserve an independently supplied
          // authoritative latency component instead of erasing other evidence.
          // With neither source present, the downstream supplemental audit remains
          // fail-closed with LATENCY_COST_EVIDENCE_UNAVAILABLE; unknown is never 0.
          const preLatencyMidpoint = latencyMidpoint(marketEvidence.bidPrice, marketEvidence.askPrice);
          const requestStartedAtMs = executionInput.executionEvidenceInput.requestStartedAtMs;
          const requestCompletedAtMs = executionInput.executionEvidenceInput.requestCompletedAtMs;
          let latencyBoundSupplementalCostInput: Partial<SupplementalCostInput> | null = sourceSupplementalCostInput;

          if (preLatencyMidpoint != null
            && naturalPositive(requestStartedAtMs)
            && naturalPositive(requestCompletedAtMs)) {
            const postTickerRequest = dependencies.buildPublicRequests(symbol).ticker;
            const postTickerPayload = await dependencies.fetchPublicJson(publicUrl(postTickerRequest), {
              provider: 'bitget',
              signal: abortSignal(context.signal),
            }).catch(() => null);
            const postLatencyObservedAtMs = dependencies.now();
            const postLatencyObservation = latencyTickerObservation(
              postTickerPayload,
              symbol,
              postLatencyObservedAtMs,
            );
            const latencyMeasurementNowMs = dependencies.now();
            if (postLatencyObservation && naturalPositive(latencyMeasurementNowMs)) {
              const latencyCost = buildAuthoritativePaperLatencyCostEvidence({
                direction,
                requestStartedAtMs,
                requestCompletedAtMs,
                preRequest: Object.freeze({
                  midpoint: preLatencyMidpoint,
                  observedAtMs: marketEvidence.observedAtMs,
                  source: `BITGET_PUBLIC_V2_TICKER_RECEIPT:providerTs=${String(marketEvidence.tickerTimestampMs)}`,
                }),
                postRequest: postLatencyObservation,
                nowMs: latencyMeasurementNowMs,
                maximumAgeMs: NATURAL_CYCLE_EVIDENCE_MAXIMUM_AGE_MS,
                maximumRequestDurationMs: NATURAL_CYCLE_EVIDENCE_MAXIMUM_AGE_MS,
              });
              if (latencyCost.status === 'PRESENT' && latencyCost.evidence != null) {
                latencyBoundSupplementalCostInput = Object.freeze({
                  ...(sourceSupplementalCostInput ?? {}),
                  latency: latencyCost.evidence,
                  observedAtMs: postLatencyObservedAtMs,
                  nowMs: latencyMeasurementNowMs,
                  maximumAgeMs: NATURAL_CYCLE_EVIDENCE_MAXIMUM_AGE_MS,
                });
              }
            }
          }

          const costNowMs = dependencies.now();
          if (!naturalPositive(costNowMs)) return partial;
"""
if "// #777 successor binding." not in text:
    text = replace_once(
        text,
        execution_anchor,
        execution_replacement,
        "LATENCY_RUNTIME_INSERTION_ANCHOR_MISSING",
    )

funding_anchor = """          const supplementalCostInput = naturalFundingBoundSupplementalCostInput({
            candidate,
            riskPolicy: policySource.policyEvidence,
            publicEvidence: marketEvidence,
            sourceSupplementalCostInput,
            researchCodeSha: normalizedSha,
            entryTimestampMs: nowMs,
            positionNotional: probeQuantity * learning.entryPrice,
            nowMs,
          });
"""
funding_replacement = """          const supplementalCostInput = naturalFundingBoundSupplementalCostInput({
            candidate,
            riskPolicy: policySource.policyEvidence,
            publicEvidence: marketEvidence,
            sourceSupplementalCostInput: latencyBoundSupplementalCostInput,
            researchCodeSha: normalizedSha,
            entryTimestampMs: nowMs,
            positionNotional: probeQuantity * learning.entryPrice,
            nowMs: costNowMs,
          });
"""
if "sourceSupplementalCostInput: latencyBoundSupplementalCostInput" not in text:
    text = replace_once(
        text,
        funding_anchor,
        funding_replacement,
        "LATENCY_FUNDING_BINDING_ANCHOR_MISSING",
    )

text = replace_once(
    text,
    """            supplemental: supplementalCostInput,
            nowMs,
            maximumAgeMs: NATURAL_CYCLE_EVIDENCE_MAXIMUM_AGE_MS,
""",
    """            supplemental: supplementalCostInput,
            nowMs: costNowMs,
            maximumAgeMs: NATURAL_CYCLE_EVIDENCE_MAXIMUM_AGE_MS,
""",
    "LATENCY_AUDIT_CLOCK_ANCHOR_MISSING",
)

text = replace_once(
    text,
    "          }, stablePolicyProducer, nowMs);\n",
    "          }, stablePolicyProducer, costNowMs);\n",
    "LATENCY_BRIDGE_CLOCK_ANCHOR_MISSING",
)

evidence.write_text(text, encoding="utf-8")

builder = Path("api-server/scripts/build-authoritative-paper-runtime-package.mjs")
builder_text = builder.read_text(encoding="utf-8")
source_line = "  'src/services/authoritative-paper-latency-cost-evidence.service.ts',\n"
source_anchor = "  'src/services/authoritative-paper-generic-risk-policy-producer.service.ts',\n"
if source_line not in builder_text:
    builder_text = replace_once(
        builder_text,
        source_anchor,
        source_anchor + source_line,
        "RUNTIME_ALLOWLIST_ANCHOR_MISSING",
    )
builder.write_text(builder_text, encoding="utf-8")

loader = Path("market-prediction-lab/src/authoritative-paper-runtime-package-v1.js")
loader_text = loader.read_text(encoding="utf-8")
expected_line = '  "api-server/src/services/authoritative-paper-latency-cost-evidence.service.ts",\n'
expected_anchor = '  "api-server/src/services/authoritative-paper-generic-risk-policy-producer.service.ts",\n'
if expected_line not in loader_text:
    loader_text = replace_once(
        loader_text,
        expected_anchor,
        expected_anchor + expected_line,
        "RUNTIME_EXPECTED_SOURCE_ANCHOR_MISSING",
    )
loader.write_text(loader_text, encoding="utf-8")

print("LATENCY_SUCCESSOR_PATCH_APPLIED")
