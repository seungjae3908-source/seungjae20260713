import { sha256Canonical } from "./research-cache-provenance.js";
import { ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID } from "./adaptive-multi-evidence-point-in-time-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_META_DECISION_V2_VERSION } from "./adaptive-multi-evidence-meta-decision-v2.js";

export const ADAPTIVE_MULTI_EVIDENCE_COST_LIQUIDITY_V2_VERSION =
  "adaptive-multi-evidence-cost-liquidity-v2";

const COST_COMPONENTS = Object.freeze([
  "commissionBps", "taxBps", "spreadBps", "slippageBps", "fundingBps", "latencyBps",
  "liquidityImpactBps", "partialFillImpactBps",
]);

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
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function safety() {
  return {
    missingCostIsZero: false,
    missingLiquidityIsZero: false,
    grossEvCanOverrideCosts: false,
    privateMarketDataRequired: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  };
}

function result({ status, decision, reasons, cost, liquidity, expectedValue, gateUpdates }) {
  const core = { status, decision, reasons: unique(reasons), cost, liquidity, expectedValue, gateUpdates };
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_COST_LIQUIDITY_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    ...core,
    evidenceDigest: sha256Canonical(core),
    economicSampleCredit: 0,
    profitabilityProven: false,
    decisionAuthority: "COST_LIQUIDITY_RESEARCH_GATE_ONLY",
    ...safety(),
  });
}

function blocked(reasons) {
  return result({
    status: "BLOCKED_DATA",
    decision: "BLOCKED",
    reasons,
    cost: { status: "UNKNOWN", pointBps: null, conservativeBps: null, components: null },
    liquidity: { status: "UNKNOWN", spreadBps: null, participation: null },
    expectedValue: { status: "UNAVAILABLE", grossBps: null, netBps: null, conservativeNetBps: null },
    gateUpdates: null,
  });
}

function validateCostOwner(cost, liquidityAdmission) {
  const reasons = [];
  if (cost?.contract !== "market-intelligence-transaction-cost-evidence/v1"
      || cost?.status !== "READY" || cost?.readyForNetAlpha !== true
      || !Number.isFinite(cost?.totalPointCostBps) || cost.totalPointCostBps < 0
      || !Number.isFinite(cost?.totalConservativeCostBps)
      || cost.totalConservativeCostBps < cost.totalPointCostBps
      || cost?.safety?.executionAuthority !== "NONE"
      || cost?.safety?.orderAllowed !== false
      || cost?.safety?.privateTradingApiAllowed !== false) reasons.push("TRANSACTION_COST_OWNER_EVIDENCE_INVALID");
  if (COST_COMPONENTS.some((component) => cost?.components?.[component]?.status !== "READY"
      || !Number.isFinite(cost?.pointCosts?.[component])
      || !Number.isFinite(cost?.conservativeCosts?.[component]))) {
    reasons.push("TRANSACTION_COST_COMPONENT_EVIDENCE_INCOMPLETE");
  }
  if (liquidityAdmission?.contract !== "liquidity-impact-runtime-admission/v1"
      || liquidityAdmission?.validationStatus !== "PASS"
      || liquidityAdmission?.liquidityImpactStatus !== "PRESENT"
      || liquidityAdmission?.runtimeEligible !== true
      || !Number.isFinite(liquidityAdmission?.estimatedImpactBps)
      || liquidityAdmission.estimatedImpactBps < 0
      || liquidityAdmission?.safety?.executionAuthority !== "NONE"
      || liquidityAdmission?.safety?.privateApiAllowed !== false
      || liquidityAdmission?.safety?.realOrderCount !== 0) reasons.push("LIQUIDITY_IMPACT_OWNER_ADMISSION_INVALID");
  const impactComponent = cost?.components?.liquidityImpactBps;
  if (reasons.length === 0 && (impactComponent.modelId !== liquidityAdmission.artifact?.artifactId
      || Math.abs(impactComponent.valueBps - liquidityAdmission.estimatedImpactBps) > 1e-9)) {
    reasons.push("LIQUIDITY_IMPACT_COST_OWNER_BINDING_MISMATCH");
  }
  return reasons;
}

function liquiditySnapshot(raw, context, policy) {
  const bid = finite(raw?.bid);
  const ask = finite(raw?.ask);
  const depthNotional = finite(raw?.visibleDepthNotional);
  const orderNotional = finite(raw?.orderNotional);
  const asOf = timestamp(raw?.asOf);
  const now = timestamp(context.decisionTime);
  const sourceId = text(raw?.sourceId);
  const sourceDigest = text(raw?.sourceDigest);
  const blockers = [];
  if (raw?.market !== context.market || raw?.symbol !== context.symbol) blockers.push("LIQUIDITY_ASSET_IDENTITY_MISMATCH");
  if (!(bid > 0) || !(ask >= bid)) blockers.push("LIQUIDITY_QUOTE_INVALID");
  if (!(depthNotional > 0) || !(orderNotional > 0)) blockers.push("LIQUIDITY_NOTIONAL_EVIDENCE_INVALID");
  if (!asOf || !now || asOf > now || now - asOf > policy.maximumAgeMs) blockers.push("LIQUIDITY_EVIDENCE_STALE_OR_FUTURE");
  if (!sourceId || !/^[0-9a-f]{64}$/iu.test(sourceDigest ?? "") || raw?.publicMarketData !== true) {
    blockers.push("PUBLIC_LIQUIDITY_PROVENANCE_REQUIRED");
  }
  if (blockers.length > 0) return { status: "UNKNOWN", blockers, spreadBps: null, participation: null };
  const mid = (bid + ask) / 2;
  const spreadBps = ((ask - bid) / mid) * 10_000;
  const participation = orderNotional / depthNotional;
  const violations = [
    spreadBps > policy.maximumSpreadBps ? "LIQUIDITY_SPREAD_LIMIT_EXCEEDED" : null,
    participation > policy.maximumVisibleDepthParticipation ? "LIQUIDITY_PARTICIPATION_LIMIT_EXCEEDED" : null,
  ].filter(Boolean);
  return {
    status: violations.length > 0 ? "FAIL" : "PASS",
    blockers: violations,
    bid,
    ask,
    spreadBps,
    visibleDepthNotional: depthNotional,
    orderNotional,
    participation,
    asOf: new Date(asOf).toISOString(),
    sourceId,
    sourceDigest,
    publicMarketData: true,
  };
}

function expectedValue(raw, context, cost) {
  if (raw == null) {
    return { status: "UNAVAILABLE", grossBps: null, grossLowerBps: null, netBps: null,
      conservativeNetBps: null, reason: "GROSS_EV_EVIDENCE_NOT_SUPPLIED" };
  }
  const valid = raw.market === context.market
    && raw.symbol === context.symbol
    && raw.timeframe === context.timeframe
    && raw.side === context.side
    && raw.strategyIdentity === context.strategyIdentity
    && raw.prospectiveOrOos === true
    && Number.isSafeInteger(raw.sampleSize)
    && Number.isSafeInteger(raw.minimumSampleSize)
    && raw.sampleSize >= raw.minimumSampleSize
    && raw.minimumSampleSize > 0
    && finite(raw.grossEvBps) != null
    && finite(raw.grossLowerBps) != null
    && raw.grossLowerBps <= raw.grossEvBps
    && text(raw.evidenceId);
  if (!valid) return { status: "UNAVAILABLE", grossBps: null, grossLowerBps: null, netBps: null,
    conservativeNetBps: null, reason: "GROSS_EV_EVIDENCE_INVALID_OR_MISMATCHED" };
  const netBps = raw.grossEvBps - cost.totalPointCostBps;
  const conservativeNetBps = raw.grossLowerBps - cost.totalConservativeCostBps;
  return {
    status: conservativeNetBps > 0 ? "POSITIVE_AFTER_CONSERVATIVE_FULL_COST" : "NOT_POSITIVE_AFTER_CONSERVATIVE_FULL_COST",
    grossBps: raw.grossEvBps,
    grossLowerBps: raw.grossLowerBps,
    pointCostBps: cost.totalPointCostBps,
    conservativeCostBps: cost.totalConservativeCostBps,
    netBps,
    conservativeNetBps,
    sampleSize: raw.sampleSize,
    evidenceId: raw.evidenceId,
    reason: conservativeNetBps > 0 ? null : "EV_UNCERTAIN_OR_NON_POSITIVE_AFTER_FULL_COST",
  };
}

function policy(raw) {
  const maximumSpreadBps = finite(raw?.maximumSpreadBps);
  const maximumVisibleDepthParticipation = finite(raw?.maximumVisibleDepthParticipation);
  const maximumAgeMs = raw?.maximumAgeMs;
  if (!(maximumSpreadBps >= 0) || !(maximumVisibleDepthParticipation > 0)
      || maximumVisibleDepthParticipation > 1 || !Number.isSafeInteger(maximumAgeMs) || maximumAgeMs <= 0) {
    throw new Error("V2_COST_LIQUIDITY_POLICY_INVALID");
  }
  return { maximumSpreadBps, maximumVisibleDepthParticipation, maximumAgeMs };
}

export function buildAdaptiveMultiEvidenceCostLiquidityV2(input = {}) {
  const blockers = [];
  if (input.metaDecision?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_META_DECISION_V2_VERSION
      || input.metaDecision?.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID
      || input.metaDecision?.executionAuthority !== "NONE") blockers.push("V2_COST_META_DECISION_INVALID");
  if (input.executionAuthority != null && input.executionAuthority !== "NONE") blockers.push("V2_COST_EXECUTION_AUTHORITY_FORBIDDEN");
  let resolvedPolicy;
  try { resolvedPolicy = policy(input.policy); } catch (error) { blockers.push(error.message); }
  blockers.push(...validateCostOwner(input.transactionCostEvidence, input.liquidityImpactAdmission));
  if (blockers.length > 0) return blocked(blockers);

  const context = {
    market: text(input.market)?.toUpperCase(),
    symbol: text(input.symbol)?.toUpperCase(),
    timeframe: text(input.timeframe),
    side: input.metaDecision.decision,
    strategyIdentity: text(input.strategyIdentity),
    decisionTime: text(input.decisionTime),
  };
  if (!context.market || !context.symbol || !context.timeframe || !context.strategyIdentity
      || !timestamp(context.decisionTime) || input.transactionCostEvidence.market !== context.market) {
    return blocked(["V2_COST_LIQUIDITY_IDENTITY_INCOMPLETE_OR_MISMATCHED"]);
  }
  const liquidity = liquiditySnapshot(input.liquiditySnapshot, context, resolvedPolicy);
  const cost = {
    status: "PASS",
    evidenceSetVersion: input.transactionCostEvidence.evidenceSetVersion,
    policyVersion: input.transactionCostEvidence.policy.version,
    pointBps: input.transactionCostEvidence.totalPointCostBps,
    conservativeBps: input.transactionCostEvidence.totalConservativeCostBps,
    components: input.transactionCostEvidence.components,
    liquidityImpactArtifactId: input.liquidityImpactAdmission.artifact.artifactId,
  };
  const ev = expectedValue(input.expectedValueEvidence, context, input.transactionCostEvidence);
  const reasons = [...liquidity.blockers];
  if (ev.status === "UNAVAILABLE" || ev.status === "NOT_POSITIVE_AFTER_CONSERVATIVE_FULL_COST") {
    reasons.push(ev.reason);
  }
  if (!["RESEARCH_DECISION_READY"].includes(input.metaDecision.status)
      || input.metaDecision.decision === "NO_TRADE") reasons.push("UPSTREAM_META_DECISION_NOT_ENTRY_READY");
  const ready = liquidity.status === "PASS"
    && ev.status === "POSITIVE_AFTER_CONSERVATIVE_FULL_COST"
    && reasons.length === 0;
  const costEvidenceId = `adaptive-v2-cost:${sha256Canonical(cost)}`;
  const liquidityEvidenceId = liquidity.status === "PASS"
    ? `adaptive-v2-liquidity:${sha256Canonical(liquidity)}` : null;
  return result({
    status: ready ? "COST_LIQUIDITY_GATE_PASS" : "NO_TRADE",
    decision: ready ? input.metaDecision.decision : "NO_TRADE",
    reasons: ready ? ["CONSERVATIVE_FULL_COST_AND_LIQUIDITY_PASS"] : reasons,
    cost,
    liquidity,
    expectedValue: ev,
    gateUpdates: {
      COST: { state: "PASS", evidenceId: costEvidenceId, reason: null },
      LIQUIDITY: liquidity.status === "PASS"
        ? { state: "PASS", evidenceId: liquidityEvidenceId, reason: null }
        : { state: liquidity.status === "FAIL" ? "FAIL" : "UNKNOWN", evidenceId: null,
          reason: liquidity.blockers.join("|") || "LIQUIDITY_UNKNOWN" },
    },
  });
}
