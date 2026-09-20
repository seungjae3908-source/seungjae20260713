import crypto from "node:crypto";

import { COUNTERFACTUAL_TWIN_SWARM_V1 } from "./counterfactual-twin-swarm-v1.js";

export const MARKET_DIGITAL_TWIN_MICROSTRUCTURE_V1 =
  "market-digital-twin-microstructure-v1";

export const DIGITAL_TWIN_REQUIRED_SCENARIOS = Object.freeze([
  "OBSERVED_REPLAY",
  "LIQUIDITY_WITHDRAWAL",
  "SPREAD_EXPANSION",
  "AGGRESSIVE_FLOW_BURST",
  "LARGE_ORDER_IMPACT",
  "LATENCY_SHOCK",
  "REGIME_TRANSITION",
]);

const SCENARIOS = new Set(DIGITAL_TWIN_REQUIRED_SCENARIOS);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestamp(value) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function safety() {
  return {
    researchOnly: true,
    syntheticScenarioEconomicCredit: 0,
    observedReplayEconomicCredit: 0,
    executionAuthority: "NONE",
    mayPlaceOrder: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    automaticPromotionAllowed: false,
    profitabilityProven: false,
  };
}

function normalizeLevels(levels, descending) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  const normalized = levels.map((level) => {
    const price = finite(Array.isArray(level) ? level[0] : level?.price);
    const quantity = finite(Array.isArray(level) ? level[1] : level?.quantity ?? level?.qty ?? level?.size);
    return price != null && price > 0 && quantity != null && quantity > 0
      ? { price, quantity }
      : null;
  });
  if (normalized.some((row) => row == null)) return null;
  normalized.sort((left, right) => descending ? right.price - left.price : left.price - right.price);
  return normalized;
}

function normalizeTrades(trades) {
  if (!Array.isArray(trades)) return null;
  const normalized = trades.map((trade) => {
    const price = finite(trade?.price);
    const quantity = finite(trade?.quantity ?? trade?.qty ?? trade?.size);
    const side = text(trade?.aggressorSide)?.toUpperCase();
    if (price == null || price <= 0 || quantity == null || quantity <= 0
        || !["BUY", "SELL"].includes(side)) return null;
    return { price, quantity, aggressorSide: side };
  });
  return normalized.some((row) => row == null) ? null : normalized;
}

function topDepthNotional(levels, count) {
  return levels.slice(0, count).reduce((sum, row) => sum + row.price * row.quantity, 0);
}

export function buildMicrostructureSnapshotV1({
  market,
  symbol,
  observedAt,
  sourceDigest,
  bids,
  asks,
  trades = [],
  depthLevels = 5,
  executionAuthority = "NONE",
} = {}) {
  const blockers = [];
  const normalizedMarket = text(market)?.toUpperCase();
  const normalizedSymbol = text(symbol)?.toUpperCase();
  const normalizedObservedAt = timestamp(observedAt);
  const normalizedSourceDigest = text(sourceDigest);
  const normalizedBids = normalizeLevels(bids, true);
  const normalizedAsks = normalizeLevels(asks, false);
  const normalizedTrades = normalizeTrades(trades);

  if (!normalizedMarket) blockers.push("MICROSTRUCTURE_MARKET_REQUIRED");
  if (!normalizedSymbol) blockers.push("MICROSTRUCTURE_SYMBOL_REQUIRED");
  if (!normalizedObservedAt) blockers.push("MICROSTRUCTURE_OBSERVED_AT_INVALID");
  if (!normalizedSourceDigest || !/^[0-9a-f]{64}$/u.test(normalizedSourceDigest)) {
    blockers.push("MICROSTRUCTURE_SOURCE_DIGEST_REQUIRED");
  }
  if (!normalizedBids || !normalizedAsks) blockers.push("MICROSTRUCTURE_L2_BOOK_INVALID");
  if (!normalizedTrades) blockers.push("MICROSTRUCTURE_TRADES_INVALID");
  if (!Number.isSafeInteger(depthLevels) || depthLevels < 1 || depthLevels > 100) {
    blockers.push("MICROSTRUCTURE_DEPTH_LEVELS_INVALID");
  }
  if (executionAuthority !== "NONE") blockers.push("MICROSTRUCTURE_EXECUTION_AUTHORITY_FORBIDDEN");

  if (blockers.length > 0) {
    return deepFreeze({
      schemaVersion: MARKET_DIGITAL_TWIN_MICROSTRUCTURE_V1,
      artifactType: "MICROSTRUCTURE_SNAPSHOT",
      status: "BLOCKED_DATA",
      blockers: [...new Set(blockers)].sort(),
      features: null,
      ...safety(),
    });
  }

  const bestBid = normalizedBids[0].price;
  const bestAsk = normalizedAsks[0].price;
  if (!(bestBid < bestAsk)) {
    return deepFreeze({
      schemaVersion: MARKET_DIGITAL_TWIN_MICROSTRUCTURE_V1,
      artifactType: "MICROSTRUCTURE_SNAPSHOT",
      status: "BLOCKED_DATA",
      blockers: ["MICROSTRUCTURE_CROSSED_OR_LOCKED_BOOK"],
      features: null,
      ...safety(),
    });
  }

  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = (bestAsk - bestBid) / mid * 10_000;
  const bidDepthNotional = topDepthNotional(normalizedBids, depthLevels);
  const askDepthNotional = topDepthNotional(normalizedAsks, depthLevels);
  const totalDepth = bidDepthNotional + askDepthNotional;
  const depthImbalance = totalDepth > 0
    ? (bidDepthNotional - askDepthNotional) / totalDepth
    : 0;
  const aggressiveBuyNotional = normalizedTrades
    .filter((row) => row.aggressorSide === "BUY")
    .reduce((sum, row) => sum + row.price * row.quantity, 0);
  const aggressiveSellNotional = normalizedTrades
    .filter((row) => row.aggressorSide === "SELL")
    .reduce((sum, row) => sum + row.price * row.quantity, 0);
  const totalAggressiveNotional = aggressiveBuyNotional + aggressiveSellNotional;
  const flowImbalance = totalAggressiveNotional > 0
    ? (aggressiveBuyNotional - aggressiveSellNotional) / totalAggressiveNotional
    : 0;
  const topLevelDepth = bestBid * normalizedBids[0].quantity + bestAsk * normalizedAsks[0].quantity;
  const liquidityConcentration = totalDepth > 0 ? topLevelDepth / totalDepth : 0;

  const features = {
    bestBid,
    bestAsk,
    mid,
    spreadBps,
    depthLevels,
    bidDepthNotional,
    askDepthNotional,
    depthImbalance,
    aggressiveBuyNotional,
    aggressiveSellNotional,
    flowImbalance,
    tradeCount: normalizedTrades.length,
    liquidityConcentration,
  };
  const core = {
    market: normalizedMarket,
    symbol: normalizedSymbol,
    observedAt: normalizedObservedAt,
    sourceDigest: normalizedSourceDigest,
    features,
  };

  return deepFreeze({
    schemaVersion: MARKET_DIGITAL_TWIN_MICROSTRUCTURE_V1,
    artifactType: "MICROSTRUCTURE_SNAPSHOT",
    status: "MICROSTRUCTURE_SNAPSHOT_READY",
    blockers: [],
    ...core,
    snapshotDigest: digest(core),
    rawBookPersisted: false,
    rawTradesPersisted: false,
    ...safety(),
  });
}

function normalizeCalibrationEvidence(raw) {
  const bookWalkEvidenceId = text(raw?.bookWalkEvidenceId);
  const fillModelEvidenceId = text(raw?.fillModelEvidenceId);
  const liquidityImpactEvidenceId = text(raw?.liquidityImpactEvidenceId);
  const latencyEvidenceId = text(raw?.latencyEvidenceId);
  const partialFillEvidenceId = text(raw?.partialFillEvidenceId);
  const tcaEvidenceId = text(raw?.tcaEvidenceId);
  const ids = {
    bookWalkEvidenceId,
    fillModelEvidenceId,
    liquidityImpactEvidenceId,
    latencyEvidenceId,
    partialFillEvidenceId,
    tcaEvidenceId,
  };
  if (Object.values(ids).some((value) => !value || !/^[a-zA-Z0-9_.:-]{8,240}$/u.test(value))) {
    return null;
  }
  if (raw?.publicOrPaperEvidenceOnly !== true
      || raw?.pointInTimeSafe !== true
      || raw?.fullCostComponentsIndependent !== true
      || raw?.testFixture !== false
      || raw?.executionAuthority !== "NONE") {
    return null;
  }
  return {
    ...ids,
    publicOrPaperEvidenceOnly: true,
    pointInTimeSafe: true,
    fullCostComponentsIndependent: true,
    testFixture: false,
    executionAuthority: "NONE",
  };
}

function normalizeScenarioPolicy(policy) {
  const requiredScenarios = Array.isArray(policy?.requiredScenarios)
    ? [...new Set(policy.requiredScenarios.map((value) => text(value)?.toUpperCase()).filter(Boolean))]
    : null;
  const minimumSnapshots = policy?.minimumSnapshots;
  const maximumSnapshotGapMs = policy?.maximumSnapshotGapMs;
  if (!requiredScenarios || requiredScenarios.length === 0
      || requiredScenarios.some((scenario) => !SCENARIOS.has(scenario))
      || !Number.isSafeInteger(minimumSnapshots) || minimumSnapshots < 2
      || !Number.isSafeInteger(maximumSnapshotGapMs) || maximumSnapshotGapMs < 1) {
    return null;
  }
  return { requiredScenarios, minimumSnapshots, maximumSnapshotGapMs };
}

export function buildMarketDigitalTwinPlanV1({
  counterfactualResult,
  snapshots = [],
  calibrationEvidence,
  policy,
  executionAuthority = "NONE",
} = {}) {
  const blockers = [];
  const normalizedCalibration = normalizeCalibrationEvidence(calibrationEvidence);
  const normalizedPolicy = normalizeScenarioPolicy(policy);
  if (counterfactualResult?.schemaVersion !== COUNTERFACTUAL_TWIN_SWARM_V1
      || counterfactualResult?.artifactType !== "COUNTERFACTUAL_TWIN_RESULT"
      || counterfactualResult?.status !== "COUNTERFACTUAL_TWIN_EVALUATED_RESEARCH_ONLY"
      || counterfactualResult?.executionAuthority !== "NONE"
      || !text(counterfactualResult?.resultDigest)) {
    blockers.push("DIGITAL_TWIN_COUNTERFACTUAL_RESULT_INVALID");
  }
  if (!Array.isArray(snapshots) || snapshots.length === 0) blockers.push("DIGITAL_TWIN_SNAPSHOTS_REQUIRED");
  if (!normalizedCalibration) blockers.push("DIGITAL_TWIN_CALIBRATION_EVIDENCE_INVALID");
  if (!normalizedPolicy) blockers.push("DIGITAL_TWIN_POLICY_INVALID");
  if (executionAuthority !== "NONE") blockers.push("DIGITAL_TWIN_EXECUTION_AUTHORITY_FORBIDDEN");

  const normalizedSnapshots = Array.isArray(snapshots) ? snapshots : [];
  if (normalizedSnapshots.some((snapshot) =>
    snapshot?.schemaVersion !== MARKET_DIGITAL_TWIN_MICROSTRUCTURE_V1
    || snapshot?.artifactType !== "MICROSTRUCTURE_SNAPSHOT"
    || snapshot?.status !== "MICROSTRUCTURE_SNAPSHOT_READY"
    || snapshot?.executionAuthority !== "NONE")) {
    blockers.push("DIGITAL_TWIN_MICROSTRUCTURE_SNAPSHOT_INVALID");
  }
  if (normalizedPolicy && normalizedSnapshots.length < normalizedPolicy.minimumSnapshots) {
    blockers.push("DIGITAL_TWIN_SNAPSHOT_SAMPLE_INSUFFICIENT");
  }

  const times = normalizedSnapshots
    .map((snapshot) => Date.parse(snapshot.observedAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (normalizedPolicy && times.length === normalizedSnapshots.length) {
    for (let index = 1; index < times.length; index += 1) {
      if (times[index] - times[index - 1] > normalizedPolicy.maximumSnapshotGapMs) {
        blockers.push("DIGITAL_TWIN_SNAPSHOT_GAP_EXCEEDED");
        break;
      }
    }
  }

  if (blockers.length > 0) {
    return deepFreeze({
      schemaVersion: MARKET_DIGITAL_TWIN_MICROSTRUCTURE_V1,
      artifactType: "MARKET_DIGITAL_TWIN_PLAN",
      status: "BLOCKED_DATA",
      blockers: [...new Set(blockers)].sort(),
      scenarios: [],
      nextStage: null,
      ...safety(),
    });
  }

  const scenarios = normalizedPolicy.requiredScenarios.map((scenarioId) => ({
    scenarioId,
    observedReplay: scenarioId === "OBSERVED_REPLAY",
    syntheticStress: scenarioId !== "OBSERVED_REPLAY",
    economicSampleCredit: 0,
    calibrationAnchored: true,
    sameSnapshotSequenceRequired: true,
  }));
  const core = {
    candidateId: counterfactualResult.candidateId,
    counterfactualResultDigest: counterfactualResult.resultDigest,
    snapshotDigests: normalizedSnapshots.map((snapshot) => snapshot.snapshotDigest),
    calibrationEvidence: normalizedCalibration,
    policy: normalizedPolicy,
    scenarios,
  };

  return deepFreeze({
    schemaVersion: MARKET_DIGITAL_TWIN_MICROSTRUCTURE_V1,
    artifactType: "MARKET_DIGITAL_TWIN_PLAN",
    status: "MARKET_DIGITAL_TWIN_PLAN_READY",
    blockers: [],
    ...core,
    planDigest: digest(core),
    scenarioCount: scenarios.length,
    calibrationOwners: {
      visibleBookWalk: "EXISTING_EXECUTION_QUALITY_OWNER",
      fillProbability: "EXISTING_CALIBRATED_FILL_MODEL_OWNER",
      liquidityImpact: "EXISTING_LIQUIDITY_IMPACT_OOS_OWNER",
      partialFill: "EXISTING_PARTIAL_FILL_OWNER",
      latency: "EXISTING_LATENCY_COST_OWNER",
      realizedTca: "EXISTING_TCA_OWNER",
    },
    nextStage: "DIGITAL_TWIN_EVALUATION",
    ...safety(),
  });
}

function normalizeScenarioResult(row, context) {
  const scenarioId = text(row?.scenarioId)?.toUpperCase();
  const evidenceId = text(row?.evidenceId);
  const planDigest = text(row?.planDigest);
  const snapshotSequenceDigest = text(row?.snapshotSequenceDigest);
  const netPnl = finite(row?.netPnl);
  const maximumDrawdown = finite(row?.maximumDrawdown);
  const fillRatio = finite(row?.fillRatio);
  const realizedSlippageBps = finite(row?.realizedSlippageBps);
  const reasons = [];

  if (!SCENARIOS.has(scenarioId) || !context.required.has(scenarioId)) {
    reasons.push("DIGITAL_TWIN_SCENARIO_INVALID");
  }
  if (planDigest !== context.planDigest) reasons.push("DIGITAL_TWIN_PLAN_DIGEST_MISMATCH");
  if (!evidenceId || !/^[a-zA-Z0-9_.:-]{8,240}$/u.test(evidenceId)) {
    reasons.push("DIGITAL_TWIN_EVIDENCE_ID_REQUIRED");
  }
  if (!snapshotSequenceDigest || !/^[0-9a-f]{64}$/u.test(snapshotSequenceDigest)) {
    reasons.push("DIGITAL_TWIN_SNAPSHOT_SEQUENCE_DIGEST_REQUIRED");
  }
  if (netPnl == null) reasons.push("DIGITAL_TWIN_NET_PNL_REQUIRED");
  if (maximumDrawdown == null || maximumDrawdown < 0) reasons.push("DIGITAL_TWIN_DRAWDOWN_INVALID");
  if (fillRatio == null || fillRatio < 0 || fillRatio > 1) reasons.push("DIGITAL_TWIN_FILL_RATIO_INVALID");
  if (realizedSlippageBps == null || realizedSlippageBps < 0) {
    reasons.push("DIGITAL_TWIN_SLIPPAGE_INVALID");
  }
  if (row?.calibrationAnchored !== true) reasons.push("DIGITAL_TWIN_CALIBRATION_ANCHOR_REQUIRED");
  if (row?.marketImpactModeled !== true) reasons.push("DIGITAL_TWIN_MARKET_IMPACT_REQUIRED");
  if (row?.partialFillModeled !== true) reasons.push("DIGITAL_TWIN_PARTIAL_FILL_REQUIRED");
  if (row?.latencyModeled !== true) reasons.push("DIGITAL_TWIN_LATENCY_REQUIRED");
  if (row?.syntheticEconomicCredit !== 0) reasons.push("DIGITAL_TWIN_SYNTHETIC_CREDIT_FORBIDDEN");
  if (row?.executionAuthority != null && row.executionAuthority !== "NONE") {
    reasons.push("DIGITAL_TWIN_EXECUTION_AUTHORITY_FORBIDDEN");
  }

  return deepFreeze({
    scenarioId: scenarioId ?? null,
    evidenceId: evidenceId ?? null,
    snapshotSequenceDigest: snapshotSequenceDigest ?? null,
    netPnl,
    maximumDrawdown,
    fillRatio,
    realizedSlippageBps,
    contractValid: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
  });
}

export function evaluateMarketDigitalTwinV1({
  plan,
  scenarioResults = [],
  executionAuthority = "NONE",
} = {}) {
  const blockers = [];
  if (plan?.schemaVersion !== MARKET_DIGITAL_TWIN_MICROSTRUCTURE_V1
      || plan?.artifactType !== "MARKET_DIGITAL_TWIN_PLAN"
      || plan?.status !== "MARKET_DIGITAL_TWIN_PLAN_READY"
      || plan?.executionAuthority !== "NONE"
      || !text(plan?.planDigest)) {
    blockers.push("DIGITAL_TWIN_PLAN_INVALID");
  }
  if (!Array.isArray(scenarioResults)) blockers.push("DIGITAL_TWIN_RESULTS_ARRAY_REQUIRED");
  if (executionAuthority !== "NONE") blockers.push("DIGITAL_TWIN_EXECUTION_AUTHORITY_FORBIDDEN");

  if (blockers.length > 0) {
    return deepFreeze({
      schemaVersion: MARKET_DIGITAL_TWIN_MICROSTRUCTURE_V1,
      artifactType: "MARKET_DIGITAL_TWIN_RESULT",
      status: "BLOCKED_DATA",
      blockers: [...new Set(blockers)].sort(),
      scenarioResults: [],
      nextStage: null,
      ...safety(),
    });
  }

  const required = new Set(plan.policy.requiredScenarios);
  const normalized = scenarioResults.map((row) => normalizeScenarioResult(row, {
    required,
    planDigest: plan.planDigest,
  }));
  if (normalized.some((row) => !row.contractValid)) blockers.push("DIGITAL_TWIN_RESULT_CONTRACT_INVALID");

  const ids = normalized.map((row) => row.scenarioId);
  if (new Set(ids).size !== ids.length) blockers.push("DIGITAL_TWIN_DUPLICATE_SCENARIO");
  const missing = [...required].filter((scenario) => !ids.includes(scenario));
  if (missing.length > 0) blockers.push("DIGITAL_TWIN_SCENARIO_MISSING");

  const sequenceDigests = new Set(normalized.map((row) => row.snapshotSequenceDigest).filter(Boolean));
  if (sequenceDigests.size !== 1) blockers.push("DIGITAL_TWIN_SEQUENCE_NOT_COMPARABLE");

  const observedReplay = normalized.find((row) => row.scenarioId === "OBSERVED_REPLAY") ?? null;
  const worstStress = normalized
    .filter((row) => row.scenarioId !== "OBSERVED_REPLAY" && row.contractValid)
    .sort((left, right) => left.netPnl - right.netPnl || right.maximumDrawdown - left.maximumDrawdown)[0] ?? null;

  const core = {
    planDigest: plan.planDigest,
    scenarioResults: normalized,
    observedReplayScenario: observedReplay?.evidenceId ?? null,
    worstStressScenario: worstStress?.scenarioId ?? null,
  };

  return deepFreeze({
    schemaVersion: MARKET_DIGITAL_TWIN_MICROSTRUCTURE_V1,
    artifactType: "MARKET_DIGITAL_TWIN_RESULT",
    status: blockers.length === 0
      ? "MARKET_DIGITAL_TWIN_EVALUATED_RESEARCH_ONLY"
      : "BLOCKED_DATA",
    blockers: [...new Set(blockers)].sort(),
    candidateId: plan.candidateId,
    planDigest: plan.planDigest,
    scenarioResults: normalized,
    observedReplay,
    worstStressScenario: worstStress?.scenarioId ?? null,
    worstStressNetPnl: worstStress?.netPnl ?? null,
    resultDigest: digest(core),
    selectionAuthority: false,
    promotionEligible: false,
    nextStage: blockers.length === 0 ? "CHAMPION_CHALLENGER_MEMORY" : null,
    ...safety(),
  });
}
