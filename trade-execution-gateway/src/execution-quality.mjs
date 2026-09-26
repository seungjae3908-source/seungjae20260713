import { GatewayError } from "./gateway.mjs";
import { estimateExecutionCosts } from "./execution-costs.mjs";

const BUY_LIKE = new Set(["BUY", "LONG"]);
const SELL_LIKE = new Set(["SELL", "SHORT"]);
const ALLOWED_FILL_SOURCES = new Set(["PAPER_SIMULATION_ONLY", "CALLER_SUPPLIED_READ_ONLY"]);
const EPSILON = 1e-12;

function requireObject(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError(code, message);
  return value;
}

function positive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new GatewayError("INVALID_TCA_INPUT", `${name} must be positive`);
  return number;
}

function optionalPositive(value, name) {
  return value == null ? null : positive(value, name);
}

function timestampMs(value, name) {
  const parsed = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed) || parsed <= 0) throw new GatewayError("INVALID_TCA_INPUT", `${name} must be a valid timestamp`);
  return parsed;
}

function orderContext(order) {
  requireObject(order, "TCA_ORDER_REQUIRED", "order is required");
  const intent = order.intent && typeof order.intent === "object" ? order.intent : order;
  const market = String(intent.market ?? "").trim().toUpperCase();
  const symbol = String(intent.symbol ?? "").trim().toUpperCase();
  const side = String(intent.side ?? "").trim().toUpperCase();
  if (!market || !symbol || (!BUY_LIKE.has(side) && !SELL_LIKE.has(side))) {
    throw new GatewayError("INVALID_TCA_ORDER", "order requires market, symbol, and BUY/SELL/LONG/SHORT side");
  }
  return {
    market,
    symbol,
    side,
    quantity: positive(intent.quantity, "order.quantity"),
    provider: intent.executionContext?.provider ?? intent.provider ?? null,
  };
}

function normalizeFills(order, fills) {
  const sourceFills = fills ?? order.paperFillEvidence;
  if (!Array.isArray(sourceFills) || sourceFills.length === 0 || sourceFills.length > 100) {
    throw new GatewayError("TCA_FILL_EVIDENCE_REQUIRED", "TCA requires 1-100 fill events");
  }
  let previousObservedAtMs = null;
  return sourceFills.map((fill, index) => {
    requireObject(fill, "INVALID_TCA_FILL", "fill must be an object");
    if (fill.realExchangeFill === true) {
      throw new GatewayError("LIVE_FILL_EVIDENCE_REJECTED", "v0.6 TCA cannot treat real exchange fills as verified evidence");
    }
    const source = String(fill.source ?? "").trim().toUpperCase();
    if (!ALLOWED_FILL_SOURCES.has(source)) {
      throw new GatewayError("TCA_FILL_SOURCE_REQUIRED", "fill source must be PAPER_SIMULATION_ONLY or CALLER_SUPPLIED_READ_ONLY");
    }
    const observedAtMs = timestampMs(fill.observedAt, "fill.observedAt");
    if (previousObservedAtMs !== null && observedAtMs < previousObservedAtMs) {
      throw new GatewayError("TCA_FILL_TIME_REGRESSION", "fill evidence timestamps must be non-decreasing");
    }
    previousObservedAtMs = observedAtMs;
    return Object.freeze({
      sequence: index + 1,
      quantity: positive(fill.quantity, "fill.quantity"),
      price: positive(fill.price, "fill.price"),
      observedAt: new Date(observedAtMs).toISOString(),
      source,
      realExchangeFill: false,
    });
  });
}

function normalizeBenchmark(benchmark, context, firstFillAtMs) {
  requireObject(benchmark, "TCA_BENCHMARK_REQUIRED", "TCA benchmark is required");
  if (benchmark.serverAttested === true) {
    throw new GatewayError("CALLER_ATTESTATION_REJECTED", "caller-supplied TCA benchmark cannot self-assert server attestation");
  }
  if (benchmark.liveExecutionEligible === true) {
    throw new GatewayError("LIVE_EXECUTION_BENCHMARK_REJECTED", "v0.6 TCA does not accept live-execution-authority benchmarks");
  }
  const market = String(benchmark.market ?? "").trim().toUpperCase();
  const symbol = String(benchmark.symbol ?? "").trim().toUpperCase();
  if (market !== context.market || symbol !== context.symbol) {
    throw new GatewayError("TCA_BENCHMARK_IDENTITY_MISMATCH", "benchmark market and symbol must match the analyzed order");
  }
  const observedAtMs = timestampMs(benchmark.observedAt, "benchmark.observedAt");
  if (observedAtMs > firstFillAtMs) {
    throw new GatewayError("TCA_BENCHMARK_AFTER_FILL", "arrival benchmark must be observed no later than the first fill");
  }
  return Object.freeze({
    market,
    symbol,
    arrivalPrice: positive(benchmark.arrivalPrice, "benchmark.arrivalPrice"),
    decisionPrice: optionalPositive(benchmark.decisionPrice, "benchmark.decisionPrice"),
    expectedFillPrice: optionalPositive(benchmark.expectedFillPrice, "benchmark.expectedFillPrice"),
    observedAt: new Date(observedAtMs).toISOString(),
    source: String(benchmark.source ?? "").trim() || "UNSPECIFIED_READ_ONLY_BENCHMARK",
    authority: "CALLER_SUPPLIED_UNATTESTED",
    serverAttested: false,
    liveExecutionEligible: false,
  });
}

function adverseBps(side, actualPrice, benchmarkPrice) {
  const direction = BUY_LIKE.has(side) ? 1 : -1;
  return direction * (actualPrice - benchmarkPrice) / benchmarkPrice * 10_000;
}

function normalizePolicy(policy) {
  if (policy == null) return null;
  requireObject(policy, "INVALID_TCA_POLICY", "TCA policy must be an object");
  const maxAllInShortfallBps = Number(policy.maxAllInShortfallBps);
  const maxPredictionErrorBps = Number(policy.maxPredictionErrorBps);
  if (!Number.isFinite(maxAllInShortfallBps) || maxAllInShortfallBps < 0 ||
      !Number.isFinite(maxPredictionErrorBps) || maxPredictionErrorBps < 0) {
    throw new GatewayError("INVALID_TCA_POLICY", "TCA thresholds must be non-negative finite bps");
  }
  return Object.freeze({ maxAllInShortfallBps, maxPredictionErrorBps });
}

export function analyzeExecutionQuality({
  order,
  fills = null,
  benchmark,
  liquidityRole,
  costSchedule,
  fundingEvents = [],
  policy = null,
}) {
  const context = orderContext(order);
  const normalizedFills = normalizeFills(order, fills);
  const firstFillAtMs = Date.parse(normalizedFills[0].observedAt);
  const latestFillAtMs = Date.parse(normalizedFills[normalizedFills.length - 1].observedAt);
  const normalizedBenchmark = normalizeBenchmark(benchmark, context, firstFillAtMs);

  if (context.market === "CRYPTO_FUTURES") {
    for (const event of fundingEvents ?? []) {
      const effectiveAtMs = timestampMs(event?.effectiveAt, "fundingEvent.effectiveAt");
      if (effectiveAtMs < firstFillAtMs) {
        throw new GatewayError("FUNDING_EVENT_BEFORE_EXECUTION_WINDOW", "funding event predates the analyzed execution window");
      }
    }
  }

  let filledQuantity = 0;
  let fillNotional = 0;
  for (const fill of normalizedFills) {
    filledQuantity += fill.quantity;
    fillNotional += fill.quantity * fill.price;
  }
  if (filledQuantity > context.quantity + EPSILON) {
    throw new GatewayError("TCA_OVERFILL_REJECTED", "fill evidence exceeds order quantity");
  }

  const fillVwap = fillNotional / filledQuantity;
  const fillRatio = Math.min(1, filledQuantity / context.quantity);
  const implementationShortfallBps = adverseBps(context.side, fillVwap, normalizedBenchmark.arrivalPrice);
  const decisionShortfallBps = normalizedBenchmark.decisionPrice == null
    ? null
    : adverseBps(context.side, fillVwap, normalizedBenchmark.decisionPrice);
  const predictionErrorBps = normalizedBenchmark.expectedFillPrice == null
    ? null
    : adverseBps(context.side, fillVwap, normalizedBenchmark.expectedFillPrice);

  const cost = estimateExecutionCosts({
    market: context.market,
    provider: context.provider,
    symbol: context.symbol,
    side: context.side,
    liquidityRole,
    quantity: filledQuantity,
    price: fillVwap,
    executionAt: latestFillAtMs,
    schedule: costSchedule,
    fundingEvents,
  });
  const allInShortfallBps = implementationShortfallBps + cost.estimatedTotalCostBps;
  const thresholds = normalizePolicy(policy);
  const breaches = [];
  if (thresholds) {
    if (allInShortfallBps > thresholds.maxAllInShortfallBps) breaches.push("ALL_IN_SHORTFALL_EXCEEDED");
    if (predictionErrorBps != null && Math.abs(predictionErrorBps) > thresholds.maxPredictionErrorBps) {
      breaches.push("PRETRADE_PREDICTION_ERROR_EXCEEDED");
    }
  }

  return Object.freeze({
    tcaVersion: "EXECUTION_QUALITY_TCA_V1",
    authority: "READ_ONLY_EXECUTION_ANALYSIS",
    state: thresholds ? (breaches.length === 0 ? "PASS" : "BREACHED") : "METRICS_ONLY",
    completion: fillRatio >= 1 - EPSILON ? "COMPLETE" : "PARTIAL",
    market: context.market,
    provider: context.provider,
    symbol: context.symbol,
    side: context.side,
    orderedQuantity: context.quantity,
    filledQuantity,
    fillRatio,
    fillVwap,
    executionWindow: Object.freeze({
      firstFillAt: new Date(firstFillAtMs).toISOString(),
      lastFillAt: new Date(latestFillAtMs).toISOString(),
    }),
    benchmark: normalizedBenchmark,
    metrics: Object.freeze({
      implementationShortfallBps,
      decisionShortfallBps,
      predictionErrorBps,
      estimatedCostBps: cost.estimatedTotalCostBps,
      allInShortfallBps,
    }),
    estimatedCosts: cost,
    fills: Object.freeze(normalizedFills),
    thresholds,
    breaches: Object.freeze(breaches),
    actualLiveExecutionMeasured: false,
    actualBrokerChargesMeasured: false,
    paperDecisionSupportOnly: true,
    executionAuthority: "NONE",
    liveOrderSubmitted: false,
    privateApiUsed: false,
  });
}
