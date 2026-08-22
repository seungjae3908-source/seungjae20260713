import { createSearchFunnel, evaluateProfitGate } from "./meaningful-search-profit-gate-v1.js";
import { primarySecondaryReasons, summarizeProviderFailureClassifications } from "./public-coverage-audit-v1.js";

const MARKETS = Object.freeze(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);

function integer(value) { return Number.isInteger(value) && value >= 0 ? value : 0; }
function freeze(value) { return Object.freeze(value); }

function reject(reasons, reason, count = 1) {
  if (!reason || count <= 0) return;
  reasons[reason] = (reasons[reason] ?? 0) + count;
}

function failureReason(failure) {
  if (failure?.primaryRejectReason) return failure.primaryRejectReason;
  if (failure?.classification) return failure.classification;
  if (failure?.reason === "timeout") return "TIMEOUT";
  if (failure?.reason === "provider_error") return "REQUIRED_PROVIDER_FAILURE";
  if (failure?.reason === "symbol_mapping") return "SYMBOL_MAPPING_FAILURE";
  if (failure?.reason === "invalid_data") return "INVALID_CANDLE";
  return /history|candle|insufficient/i.test(String(failure?.message ?? ""))
    ? "INSUFFICIENT_HISTORY"
    : "DATA_QUALITY_REJECT";
}

function signalKey(card) {
  return [
    card?.market ?? "UNKNOWN",
    card?.symbol ?? card?.ticker ?? "UNKNOWN",
    card?.signalId ?? "NO_SIGNAL_ID",
  ].join(":");
}

function rate(numerator, denominator) {
  return denominator > 0 ? Math.round(numerator / denominator * 10_000) / 100 : 0;
}

function addCounts(target, source) {
  for (const [reason, rawCount] of Object.entries(source ?? {})) reject(target, reason, integer(rawCount));
}

function sortedCounts(reasons, limit = 10) {
  return Object.entries(reasons)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([reason, count]) => freeze({ reason, count }));
}

function defaultProfitInput(market) {
  return {
    market,
    probabilities: { tp: null, sl: null, expire: null },
    returns: { target: null, stop: null, expire: null },
    costs: { status: "MISSING", components: {} },
    calibration: { status: "INSUFFICIENT_SAMPLE", sampleSize: 0, tpFirstCount: 0 },
    featureParity: market === "CRYPTO_FUTURES"
      ? { pass: true, allowedFeatures: [], blockedFeatures: [] }
      : { pass: true },
  };
}

export async function runCanonicalMeaningfulSearchMarket({
  market,
  scanBatch,
  profitInputForCard = (_card, selectedMarket) => defaultProfitInput(selectedMarket),
  maximumBatches = 1_000,
  onProgress,
} = {}) {
  if (!MARKETS.includes(market)) throw new TypeError("supported market is required");
  if (typeof scanBatch !== "function") throw new TypeError("scanBatch is required");
  if (!Number.isInteger(maximumBatches) || maximumBatches < 1) throw new TypeError("positive maximumBatches is required");

  const funnel = createSearchFunnel(market);
  if (onProgress != null && typeof onProgress !== "function") throw new TypeError("onProgress must be a function");
  const primaryRejectReasons = {};
  const secondaryRejectReasons = {};
  const providerFailureClassifications = {};
  const requestSkippedReasons = {};
  const universeExclusionReasons = {};
  const grades = { S: 0, A: 0, WATCH: 0, REJECT: 0 };
  const seenSignals = new Set();
  const seenDisplayedSignals = new Set();
  let cursor = 0;
  let universeCount = 0;
  let universeRawCount = 0;
  let universeSource = null;
  let universePartial = false;
  let eligibleScopeDefined = false;
  let batches = 0;
  let providerRequested = 0;
  let providerStarted = 0;
  let providerCompleted = 0;
  let universeAttempted = 0;
  let requestSkipped = 0;
  let requestNotStarted = 0;
  let providerSuccess = 0;
  let providerFailed = 0;
  let optionalProviderMissing = 0;
  let executionReportedPartial = false;
  let executionHardPartial = false;
  let historySufficient = 0;
  let historyInsufficient = 0;
  let dataQualityPass = 0;
  let dataQualityReject = 0;
  let liquidityPass = 0;
  let liquidityReject = 0;
  let hardFilterPass = 0;
  let softCandidates = 0;
  let scannerReturned = 0;
  let profitEvaluated = 0;
  let profitGatePass = 0;
  let profitGateReject = 0;
  let oiParityBlocked = 0;
  let finalCandidates = 0;
  let paginationEnded = false;

  while (batches < maximumBatches) {
    const response = await scanBatch({ market, cursor });
    batches += 1;
    const audit = response?.audit ?? {};
    universeCount = Math.max(universeCount, integer(response?.universe?.totalCount));
    universeRawCount = Math.max(universeRawCount, integer(audit?.universeScope?.rawTotal ?? response?.universe?.totalCount));
    universeSource = universeSource ?? response?.universe?.source ?? null;
    universePartial ||= response?.universe?.partial === true || response?.universe?.stale === true;
    eligibleScopeDefined ||= audit?.universeScope?.eligibleScopeDefined === true
      || (integer(response?.universe?.totalCount) > 0 && response?.universe?.source != null);
    if (batches === 1) addCounts(universeExclusionReasons, audit?.universeScope?.exclusionReasons);
    const execution = response?.execution ?? {};
    const requested = integer(execution.requestedCount);
    const started = integer(execution.startedCount ?? requested);
    const succeeded = integer(execution.providerAcceptedCount ?? execution.completedCount);
    const insufficient = integer(execution.insufficientDataCount);
    const hardPass = integer(execution.hardFilterPassCount ?? response?.cards?.length);
    const hardReject = integer(execution.hardFilterRejectedCount);
    const soft = integer(execution.softCandidateCount ?? response?.cards?.length);
    providerRequested += requested;
    providerStarted += started;
    providerCompleted += integer(execution.completedCount);
    universeAttempted = Math.max(universeAttempted, integer(audit.rangeEnd ?? cursor + requested));
    const skipped = integer(audit.requestSkippedCount);
    requestSkipped += skipped;
    addCounts(requestSkippedReasons, audit.requestSkippedReasons);
    const notStarted = Math.max(0, requested - started);
    requestNotStarted += notStarted;
    reject(primaryRejectReasons, "BATCH_DEADLINE_NOT_STARTED", notStarted);
    providerSuccess += succeeded;
    const requiredFailures = integer(execution.requiredProviderFailureCount
      ?? (integer(execution.providerErrorCount) + integer(execution.timeoutCount)));
    providerFailed += requiredFailures;
    optionalProviderMissing += integer(execution.optionalProviderMissingCount);
    const classifiedProviderFailures = Object.keys(audit.providerFailureClassifications ?? {}).length
      ? audit.providerFailureClassifications
      : execution.providerFailureClassifications;
    addCounts(providerFailureClassifications, classifiedProviderFailures);
    const hasClassifiedProviderFailures = Object.keys(classifiedProviderFailures ?? {}).length > 0;
    executionReportedPartial ||= execution.partial === true;
    executionHardPartial ||= execution.timedOut === true || execution.cancelled === true;
    const historyOk = Number.isInteger(audit.historyOkCount) ? integer(audit.historyOkCount) : Math.max(0, succeeded - insufficient);
    const historyFail = Number.isInteger(audit.historyFailCount) ? integer(audit.historyFailCount) : insufficient;
    historyInsufficient += historyFail;
    historySufficient += historyOk;
    dataQualityPass += Math.max(0, succeeded - insufficient);
    dataQualityReject += insufficient + hardReject;
    liquidityPass += hardPass;
    liquidityReject += Math.max(0, succeeded - hardPass - insufficient);
    hardFilterPass += hardPass;
    softCandidates += soft;
    const failureRows = response?.failures ?? [];
    const classifiedInsufficientFailures = failureRows.filter((failure) => failureReason(failure) === "INSUFFICIENT_HISTORY").length;
    reject(
      primaryRejectReasons,
      "INSUFFICIENT_HISTORY",
      Math.max(0, integer(audit.insufficientHistoryCount ?? insufficient) - classifiedInsufficientFailures),
    );
    const auditedHardRejects = Array.isArray(audit.hardRejects) ? audit.hardRejects : [];
    for (const item of auditedHardRejects) {
      reject(primaryRejectReasons, item.primaryRejectReason);
      for (const reason of item.secondaryRejectReasons ?? []) reject(secondaryRejectReasons, reason);
    }
    reject(primaryRejectReasons, "HARD_FILTER_REJECT_UNCLASSIFIED", Math.max(0, hardReject - auditedHardRejects.length));
    reject(primaryRejectReasons, "NO_SETUP", integer(execution.filteredByStrategyCount));
    for (const failure of failureRows) {
      const reason = failureReason(failure);
      reject(primaryRejectReasons, reason);
      for (const secondary of failure?.secondaryRejectReasons ?? []) reject(secondaryRejectReasons, secondary);
      if (!hasClassifiedProviderFailures && [
        "REQUIRED_PROVIDER_FAILURE", "FALLBACK_FAILED", "RATE_LIMITED", "TIMEOUT", "CONNECTION_ERROR",
        "BAD_RESPONSE", "INSUFFICIENT_HISTORY", "SYMBOL_UNSUPPORTED", "DELISTED_OR_INACTIVE", "MARKET_NOT_SUPPORTED",
      ].includes(reason)) {
        reject(providerFailureClassifications, reason);
      }
    }

    for (const card of response?.cards ?? []) {
      const key = signalKey(card);
      if (seenDisplayedSignals.has(key)) continue;
      seenDisplayedSignals.add(key);
      scannerReturned += 1;
    }

    const internalCards = Array.isArray(audit.internalCards) ? audit.internalCards : (response?.cards ?? []);
    for (const card of internalCards) {
      const key = signalKey(card);
      if (seenSignals.has(key)) continue;
      seenSignals.add(key);
      profitEvaluated += 1;
      if (card.signalGrade === "S") grades.S += 1;
      else if (card.signalGrade === "A") grades.A += 1;
      else if (card.signalGrade === "B") grades.WATCH += 1;
      else grades.REJECT += 1;
      const rawInput = await profitInputForCard(card, market);
      const gate = evaluateProfitGate({ ...defaultProfitInput(market), ...rawInput, market });
      if (gate.eligible) {
        profitGatePass += 1;
        finalCandidates += 1;
      } else {
        profitGateReject += 1;
        const reasons = primarySecondaryReasons(gate.reasons);
        reject(primaryRejectReasons, reasons.primaryRejectReason);
        for (const reason of reasons.secondaryRejectReasons) reject(secondaryRejectReasons, reason);
        if (gate.reasons.includes("FEATURE_PARITY_BLOCKED")) oiParityBlocked += 1;
      }
    }

    await onProgress?.(freeze({ market, batches, cursor, universeCount, providerRequested, providerStarted, providerSuccess, providerFailed }));

    const next = response?.universe?.nextCursor;
    if (next == null) { paginationEnded = true; break; }
    if (!Number.isInteger(next) || next <= cursor) throw new Error("CANONICAL_SCANNER_CURSOR_STALLED");
    cursor = next;
  }
  if (batches === maximumBatches && cursor < universeCount) throw new Error("CANONICAL_SCANNER_BATCH_LIMIT_EXCEEDED");

  funnel.increment("TOTAL_UNIVERSE", universeCount);
  funnel.increment("QUOTE_REQUESTED", providerRequested);
  funnel.increment("QUOTE_SUCCESS", providerSuccess);
  funnel.increment("HISTORY_SUFFICIENT", historySufficient);
  funnel.increment("INDICATORS_READY", dataQualityPass);
  funnel.increment("DATA_QUALITY_PASS", dataQualityPass);
  funnel.increment("LIQUIDITY_PASS", liquidityPass);
  funnel.increment("HARD_FILTER_PASS", hardFilterPass);
  funnel.increment("SOFT_CANDIDATE", softCandidates);
  funnel.increment("REGIME_MATCH", grades.S + grades.A + grades.WATCH);
  funnel.increment("SETUP_FOUND", grades.S + grades.A + grades.WATCH);
  funnel.increment("PROFIT_GATE_PASS", profitGatePass);
  funnel.increment("FINAL_SIGNAL_COUNT", finalCandidates);
  for (const [reason, count] of Object.entries(primaryRejectReasons)) funnel.reject(reason, count);
  const base = funnel.snapshot();
  const unexplainedSkipped = Math.max(0, universeCount - providerRequested - requestSkipped);
  const paginationComplete = paginationEnded && universeAttempted >= universeCount;
  const coverageComplete = universeCount > 0 && paginationComplete && unexplainedSkipped === 0;
  const providerFailureSummary = summarizeProviderFailureClassifications(providerFailureClassifications);
  const hasProviderFailureClassifications = Object.keys(providerFailureClassifications).length > 0;
  const unresolvedRequiredFailures = hasProviderFailureClassifications
    ? providerFailureSummary.unresolvedRequiredFailures
    : providerFailed;
  const explainedProviderExclusions = providerFailureSummary.explainedUnsupported;
  const executionPartial = executionHardPartial || (executionReportedPartial && unresolvedRequiredFailures > 0);
  const providerIntegrityComplete = unresolvedRequiredFailures === 0
    && requestNotStarted === 0
    && !executionPartial;
  const universeProviderFailed = universePartial
    || !coverageComplete
    || !providerIntegrityComplete
    || ["curated-fallback", "last-good-cache", "unavailable"].includes(universeSource);
  const searchFailure = base.outcome === "SEARCH_FAILURE" || universeProviderFailed;
  const outcome = searchFailure ? "SEARCH_FAILURE" : finalCandidates === 0 ? "VALID_NO_TRADE" : "TRADE_CANDIDATES";
  const topRejectReasons = sortedCounts(primaryRejectReasons);
  const topSecondaryRejectReasons = sortedCounts(secondaryRejectReasons);
  const fullSweepReady = eligibleScopeDefined
    && !universePartial
    && !["curated-fallback", "last-good-cache", "unavailable"].includes(universeSource)
    && coverageComplete
    && unexplainedSkipped === 0
    && requestNotStarted === 0
    && providerRequested > 0;

  return freeze({
    schemaVersion: "canonical-meaningful-search-runtime-v1",
    market,
    universe: freeze({
      total: universeCount,
      rawTotal: Math.max(universeRawCount, universeCount),
      eligible: universeCount,
      attempted: universeAttempted,
      requestSkipped,
      requestSkippedReasons: freeze(requestSkippedReasons),
      exclusionReasons: freeze(universeExclusionReasons),
      unexplainedSkipped,
      eligibleScopeDefined,
      paginationComplete,
      coverageComplete,
      source: universeSource,
      partial: universePartial,
    }),
    batches,
    providerRequested,
    providerStarted,
    requestNotStarted,
    providerCompleted,
    providerSuccess,
    providerFailed,
    explainedProviderExclusions,
    unresolvedRequiredFailures,
    optionalProviderMissing,
    providerFailureClassifications: freeze(providerFailureClassifications),
    providerFailureSummary: freeze(providerFailureSummary),
    executionReportedPartial,
    executionPartial,
    providerIntegrityComplete,
    historySufficient,
    historyInsufficient,
    dataQualityPass,
    dataQualityReject,
    liquidityPass,
    liquidityReject,
    hardFilterPass,
    softCandidates,
    scannerReturned,
    profitEvaluated,
    internalEvidenceLost: Math.max(0, softCandidates - profitEvaluated),
    grades: freeze(grades),
    profitGatePass,
    profitGateReject,
    oiParityBlocked,
    finalCandidates,
    outcome,
    searchFailure,
    validNoTrade: outcome === "VALID_NO_TRADE",
    fullSweepReady,
    rates: freeze({
      coverageRate: rate(universeAttempted, universeCount),
      startRate: rate(providerStarted, providerRequested),
      providerSuccessRate: rate(providerSuccess, providerStarted),
      discoveryRate: rate(softCandidates, providerSuccess),
    }),
    topRejectReasons: freeze(topRejectReasons),
    topSecondaryRejectReasons: freeze(topSecondaryRejectReasons),
    rejectAccounting: freeze({
      primaryRejectCount: Object.values(primaryRejectReasons).reduce((sum, count) => sum + count, 0),
      secondaryOccurrenceCount: Object.values(secondaryRejectReasons).reduce((sum, count) => sum + count, 0),
      doubleCountingPrimaryDecisions: false,
    }),
    diagnosticSemantics: freeze({
      primaryRejectReasons: "MUTUALLY_EXCLUSIVE",
      secondaryRejectReasons: "NON_EXCLUSIVE_EVIDENCE",
      hardRejectReasons: "EXACT_WHEN_AUDIT_STAGE_EMITS",
      dataQualityAndLiquidityCounters: "LEGACY_COMPATIBILITY_PROXY",
      providerFailed: "RAW_REQUIRED_FAILURE_COMPATIBILITY_COUNT",
      explainedProviderExclusions: "UNSUPPORTED_OR_INSUFFICIENT_REAL_MARKET_DATA",
      unresolvedRequiredFailures: "REQUIRED_PROVIDER_OUTAGES_ONLY",
    }),
    orderSubmitted: false,
    exchangeRequestSent: false,
    privateApiUsed: false,
    liveTrading: false,
  });
}

export async function runCanonicalMeaningfulSearchRuntime(input = {}) {
  const results = [];
  const selectedMarkets = input.markets ?? MARKETS;
  if (!Array.isArray(selectedMarkets) || selectedMarkets.length === 0 || selectedMarkets.some((market) => !MARKETS.includes(market))) {
    throw new TypeError("markets must contain supported markets");
  }
  for (const market of selectedMarkets) {
    results.push(await runCanonicalMeaningfulSearchMarket({
      ...input,
      ...(input.marketOptions?.[market] ?? {}),
      market,
    }));
  }
  return freeze({
    schemaVersion: "canonical-meaningful-search-runtime-v1",
    generatedAt: new Date().toISOString(),
    markets: freeze(results),
    safety: freeze({ liveTrading: false, realOrder: false, privateApi: false, executionAuthority: "NONE" }),
  });
}
