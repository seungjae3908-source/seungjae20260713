import { createHash } from "node:crypto";

import {
  FOUR_MARKET_PAPER_SETTLEMENT_MINIMUM_SAMPLE_SIZE,
  summarizeSettledPaperSamples,
} from "./four-market-paper-settlement-v1.js";

const SHA40 = /^[0-9a-f]{40}$/iu;
const DIGEST64 = /^[0-9a-f]{64}$/iu;
const NATURAL_RECEIPT_SCHEMA = "natural-settlement-eligibility-receipt-v1";
const FULL_COST_RECEIPT_SCHEMA = "full-cost-settlement-receipt-v1";
const REGIME_RECEIPT_SCHEMA = "settlement-regime-evidence-v1";
const GATE_SCHEMA = "settlement-profitability-evidence-gate-v1";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])));
  }
  return value;
}

function validateEvidenceProvenance(value, prefix) {
  if (value?.schemaVersion !== "paper-evidence-provenance-v1") throw new Error(`${prefix}_PROVENANCE_REQUIRED`);
  if (!DIGEST64.test(value.provenanceDigest ?? "")) throw new Error(`${prefix}_PROVENANCE_DIGEST_REQUIRED`);
  if (!DIGEST64.test(value.evidenceSnapshotDigest ?? "")) throw new Error(`${prefix}_SNAPSHOT_DIGEST_REQUIRED`);
  if (value.publicOnly !== true || value.dataQuality !== "READY") throw new Error(`${prefix}_PUBLIC_READY_EVIDENCE_REQUIRED`);
}

function validateSettlement(settlement) {
  if (!settlement || settlement.status !== "SETTLED") throw new Error("P1_5_SETTLED_SAMPLE_REQUIRED");
  if (!nonEmpty(settlement.paperSampleId)) throw new Error("P1_5_SETTLEMENT_ID_REQUIRED");
  if (!nonEmpty(settlement.strategyId) || !nonEmpty(settlement.strategyVersion) || !nonEmpty(settlement.parameterHash)) {
    throw new Error("P1_5_STRATEGY_IDENTITY_REQUIRED");
  }
  if (!SHA40.test(settlement.researchCodeSha ?? "")) throw new Error("P1_5_RESEARCH_SHA_REQUIRED");
  if (!Number.isSafeInteger(settlement.settledAtMs) || settlement.settledAtMs <= 0) throw new Error("P1_5_SETTLED_AT_REQUIRED");
  if (!finite(settlement.netPnl) || !finite(settlement.netReturnPercent)) throw new Error("P1_5_NET_METRICS_REQUIRED");
  if (!finite(settlement.totalExplicitCost) || settlement.totalExplicitCost < 0) throw new Error("P1_5_EXPLICIT_COST_REQUIRED");
  if (!nonEmpty(settlement.costPolicyVersion)) throw new Error("P1_5_COST_POLICY_REQUIRED");
  if (!DIGEST64.test(settlement.fundingEvidence?.fundingEvidenceDigest ?? "")) throw new Error("P1_5_FUNDING_EVIDENCE_REQUIRED");
  validateEvidenceProvenance(settlement.entryEvidenceProvenance, "P1_5_ENTRY");
  validateEvidenceProvenance(settlement.exitEvidenceProvenance, "P1_5_EXIT");
  if (!nonEmpty(settlement.entryParityFingerprint) || !nonEmpty(settlement.exitParityFingerprint)) {
    throw new Error("P1_5_PARITY_FINGERPRINT_REQUIRED");
  }
  if (settlement.simulatedOnly !== true
    || settlement.liveOrderAllowed !== false
    || settlement.privateTradingApiAllowed !== false
    || settlement.orderSubmitted !== false
    || settlement.exchangeRequestSent !== false
    || settlement.profitabilityClaimAllowed !== false) {
    throw new Error("P1_5_SETTLEMENT_SAFETY_VIOLATION");
  }
}

function cohortIdentity(settlement) {
  return Object.freeze({
    strategyId: settlement.strategyId,
    strategyVersion: settlement.strategyVersion,
    parameterHash: settlement.parameterHash,
    researchCodeSha: settlement.researchCodeSha.toLowerCase(),
  });
}

function cohortKey(settlement) {
  return stableSerialize(cohortIdentity(settlement));
}

function validateChronologicalCohort(settlements) {
  const ids = new Set();
  let expectedCohort = null;
  let previous = null;
  for (const settlement of settlements) {
    validateSettlement(settlement);
    if (ids.has(settlement.paperSampleId)) throw new Error("P1_5_DUPLICATE_SETTLEMENT_ID");
    ids.add(settlement.paperSampleId);
    const key = cohortKey(settlement);
    if (expectedCohort == null) expectedCohort = key;
    if (key !== expectedCohort) throw new Error("P1_5_MIXED_STRATEGY_COHORT_FORBIDDEN");
    const ordering = `${String(settlement.settledAtMs).padStart(16, "0")}:${settlement.paperSampleId}`;
    if (previous != null && ordering <= previous) throw new Error("P1_5_SETTLEMENT_ORDER_NOT_CANONICAL");
    previous = ordering;
  }
}

function settlementProjection(settlement) {
  return Object.freeze({
    paperSampleId: settlement.paperSampleId,
    market: settlement.market ?? null,
    symbol: settlement.symbol ?? null,
    style: settlement.style ?? null,
    timeframe: settlement.timeframe ?? null,
    horizon: settlement.horizon ?? null,
    strategyId: settlement.strategyId,
    strategyVersion: settlement.strategyVersion,
    parameterHash: settlement.parameterHash,
    researchCodeSha: settlement.researchCodeSha.toLowerCase(),
    entryEvaluatedAtMs: settlement.entryEvaluatedAtMs ?? null,
    settledAtMs: settlement.settledAtMs,
    netPnl: settlement.netPnl,
    netReturnPercent: settlement.netReturnPercent,
    totalExplicitCost: settlement.totalExplicitCost,
    costPolicyVersion: settlement.costPolicyVersion,
    fundingEvidenceDigest: settlement.fundingEvidence.fundingEvidenceDigest,
    entryEvidenceDigest: settlement.entryEvidenceProvenance.evidenceSnapshotDigest,
    exitEvidenceDigest: settlement.exitEvidenceProvenance.evidenceSnapshotDigest,
    entryParityFingerprint: settlement.entryParityFingerprint,
    exitParityFingerprint: settlement.exitParityFingerprint,
    mfePercent: finite(settlement.mfePercent) ? settlement.mfePercent : null,
    maePercent: finite(settlement.maePercent) ? settlement.maePercent : null,
    usablePathBars: Number.isInteger(settlement.usablePathBars) ? settlement.usablePathBars : null,
  });
}

export function buildSettlementEvidenceDigest(settlement) {
  validateSettlement(settlement);
  return digest(settlementProjection(settlement));
}

function mapReceipts(receipts, label) {
  if (receipts == null) return new Map();
  if (!Array.isArray(receipts)) throw new TypeError(`${label} receipts must be an array`);
  const mapped = new Map();
  for (const receipt of receipts) {
    if (!nonEmpty(receipt?.paperSampleId)) throw new Error(`${label}_RECEIPT_ID_REQUIRED`);
    if (mapped.has(receipt.paperSampleId)) throw new Error(`${label}_DUPLICATE_RECEIPT`);
    mapped.set(receipt.paperSampleId, receipt);
  }
  return mapped;
}

function validateNaturalReceipt(settlement, receipt) {
  if (receipt?.schemaVersion !== NATURAL_RECEIPT_SCHEMA) throw new Error("P1_5_NATURAL_RECEIPT_SCHEMA_INVALID");
  if (receipt.settlementDigest !== buildSettlementEvidenceDigest(settlement)) throw new Error("P1_5_NATURAL_SETTLEMENT_DIGEST_MISMATCH");
  if (receipt.sampleClass !== "NATURAL" || receipt.creditEligible !== true || receipt.triggerSource !== "CRON") {
    throw new Error("P1_5_NATURAL_CREDIT_NOT_ELIGIBLE");
  }
  if (receipt.replay !== false || receipt.backfill !== false || receipt.synthetic !== false || receipt.testOnly !== false || receipt.finalHoldoutUsed !== false) {
    throw new Error("P1_5_FORBIDDEN_SAMPLE_CLASS");
  }
  if (!SHA40.test(receipt.runtimeSourceSha ?? "")) throw new Error("P1_5_NATURAL_RUNTIME_SHA_REQUIRED");
  if (receipt.executionAuthority !== "NONE" || receipt.privateTradingApiAllowed !== false || receipt.realOrderCount !== 0) {
    throw new Error("P1_5_NATURAL_RECEIPT_SAFETY_VIOLATION");
  }
}

function validateFullCostReceipt(settlement, receipt) {
  if (receipt?.schemaVersion !== FULL_COST_RECEIPT_SCHEMA) throw new Error("P1_5_FULL_COST_RECEIPT_SCHEMA_INVALID");
  if (receipt.settlementDigest !== buildSettlementEvidenceDigest(settlement)) throw new Error("P1_5_FULL_COST_SETTLEMENT_DIGEST_MISMATCH");
  if (receipt.status !== "FULL_COST_READY" || receipt.allRequiredComponentsAccountedFor !== true) {
    throw new Error("P1_5_FULL_COST_NOT_READY");
  }
  if (!Array.isArray(receipt.unknownComponents) || receipt.unknownComponents.length !== 0) throw new Error("P1_5_UNKNOWN_COST_COMPONENTS_PRESENT");
  if (receipt.unknownCostIsZero !== false) throw new Error("P1_5_UNKNOWN_COST_ZERO_COERCION_FORBIDDEN");
  if (!DIGEST64.test(receipt.costEvidenceDigest ?? "")) throw new Error("P1_5_FULL_COST_DIGEST_REQUIRED");
  if (receipt.costPolicyVersion !== settlement.costPolicyVersion) throw new Error("P1_5_COST_POLICY_MISMATCH");
}

function validateRegimeReceipt(settlement, receipt) {
  if (receipt?.schemaVersion !== REGIME_RECEIPT_SCHEMA) throw new Error("P1_5_REGIME_RECEIPT_SCHEMA_INVALID");
  if (receipt.settlementDigest !== buildSettlementEvidenceDigest(settlement)) throw new Error("P1_5_REGIME_SETTLEMENT_DIGEST_MISMATCH");
  if (!nonEmpty(receipt.regimeId) || !nonEmpty(receipt.regimeVersion)) throw new Error("P1_5_REGIME_IDENTITY_REQUIRED");
  if (!SHA40.test(receipt.sourceSha ?? "") || !DIGEST64.test(receipt.regimeEvidenceDigest ?? "")) throw new Error("P1_5_REGIME_PROVENANCE_REQUIRED");
  if (receipt.inferred !== false || receipt.finalHoldoutUsed !== false) throw new Error("P1_5_INFERRED_OR_HOLDOUT_REGIME_FORBIDDEN");
}

function receiptCoverage(settlements, receipts, label, validator) {
  const mapped = mapReceipts(receipts, label);
  const settlementIds = new Set(settlements.map((settlement) => settlement.paperSampleId));
  for (const paperSampleId of mapped.keys()) {
    if (!settlementIds.has(paperSampleId)) throw new Error(`${label}_ORPHAN_RECEIPT`);
  }
  if (settlements.length === 0) return Object.freeze({ status: "MISSING_EVIDENCE", covered: 0, required: 0, mapped });
  if (mapped.size === 0) return Object.freeze({ status: "MISSING_EVIDENCE", covered: 0, required: settlements.length, mapped });
  let covered = 0;
  for (const settlement of settlements) {
    const receipt = mapped.get(settlement.paperSampleId);
    if (!receipt) continue;
    validator(settlement, receipt);
    covered += 1;
  }
  return Object.freeze({
    status: covered === settlements.length ? "PRESENT" : "INCOMPLETE",
    covered,
    required: settlements.length,
    mapped,
  });
}

function buildPathEvidence(settlements) {
  const rows = settlements.map((settlement) => Object.freeze({
    paperSampleId: settlement.paperSampleId,
    maePercent: finite(settlement.maePercent) ? settlement.maePercent : null,
    mfePercent: finite(settlement.mfePercent) ? settlement.mfePercent : null,
    usablePathBars: Number.isInteger(settlement.usablePathBars) ? settlement.usablePathBars : null,
  }));
  const complete = rows.filter((row) => finite(row.maePercent) && finite(row.mfePercent) && Number.isInteger(row.usablePathBars) && row.usablePathBars > 0).length;
  return Object.freeze({
    status: settlements.length > 0 && complete === settlements.length ? "PRESENT" : "MISSING_EVIDENCE",
    covered: complete,
    required: settlements.length,
    evidenceSetDigest: rows.length ? digest(rows) : null,
    scalarAggregationPolicy: "POLICY_MISSING",
    mae: null,
    mfe: null,
  });
}

function buildRegimeStatistics(settlements, coverage, minimumSampleSize) {
  if (coverage.status !== "PRESENT") return Object.freeze([]);
  const grouped = new Map();
  for (const settlement of settlements) {
    const receipt = coverage.mapped.get(settlement.paperSampleId);
    const key = `${receipt.regimeVersion}:${receipt.regimeId}`;
    if (!grouped.has(key)) grouped.set(key, { receipt, settlements: [] });
    grouped.get(key).settlements.push(settlement);
  }
  return Object.freeze([...grouped.values()].map(({ receipt, settlements: group }) => {
    const summary = summarizeSettledPaperSamples(group, minimumSampleSize);
    return Object.freeze({
      regimeId: receipt.regimeId,
      regimeVersion: receipt.regimeVersion,
      sampleSize: summary.sampleSize,
      sampleStatus: summary.sampleStatus,
      averageNetReturnPercent: summary.averageNetReturnPercent,
      expectancyNetPnl: summary.expectancyNetPnl,
      profitFactor: summary.profitFactor,
      maxDrawdownPercent: summary.maxDrawdownPercent,
      profitabilityClaimAllowed: false,
    });
  }));
}

export function buildSettlementProfitabilityEvidenceGate({
  settlements = [],
  naturalEligibilityReceipts = [],
  fullCostReceipts = [],
  regimeReceipts = [],
  minimumSampleSize = FOUR_MARKET_PAPER_SETTLEMENT_MINIMUM_SAMPLE_SIZE,
} = {}) {
  if (!Array.isArray(settlements)) throw new TypeError("settlements array is required");
  if (!Number.isInteger(minimumSampleSize) || minimumSampleSize <= 0) throw new TypeError("minimumSampleSize must be positive");
  validateChronologicalCohort(settlements);

  const canonicalSummary = summarizeSettledPaperSamples(settlements, minimumSampleSize);
  const natural = receiptCoverage(settlements, naturalEligibilityReceipts, "P1_5_NATURAL", validateNaturalReceipt);
  const fullCost = receiptCoverage(settlements, fullCostReceipts, "P1_5_FULL_COST", validateFullCostReceipt);
  const regime = receiptCoverage(settlements, regimeReceipts, "P1_5_REGIME", validateRegimeReceipt);
  const path = buildPathEvidence(settlements);
  const regimeStatistics = buildRegimeStatistics(settlements, regime, minimumSampleSize);
  const settlementSetDigest = settlements.length ? digest(settlements.map(settlementProjection)) : null;
  const sampleCountReady = canonicalSummary.sampleStatus === "READY";
  const prerequisiteEvidenceComplete = sampleCountReady
    && natural.status === "PRESENT"
    && fullCost.status === "PRESENT"
    && path.status === "PRESENT"
    && regime.status === "PRESENT";

  return freeze({
    schemaVersion: GATE_SCHEMA,
    cohortIdentity: settlements.length ? cohortIdentity(settlements[0]) : null,
    settlementSetDigest,
    sampleCount: canonicalSummary.sampleSize,
    minimumSampleSize,
    sampleCountStatus: canonicalSummary.sampleStatus,
    canonicalMetrics: {
      hitRate: canonicalSummary.hitRate,
      averageNetReturnPercent: canonicalSummary.averageNetReturnPercent,
      totalNetPnl: canonicalSummary.totalNetPnl,
      expectancyNetPnl: canonicalSummary.expectancyNetPnl,
      profitFactor: canonicalSummary.profitFactor,
      maxDrawdownPercent: canonicalSummary.maxDrawdownPercent,
    },
    naturalEligibility: { status: natural.status, covered: natural.covered, required: natural.required },
    fullCostEvidence: { status: fullCost.status, covered: fullCost.covered, required: fullCost.required },
    pathEvidence: path,
    regimeEvidence: { status: regime.status, covered: regime.covered, required: regime.required },
    regimeStatistics,
    prerequisiteEvidenceComplete,
    scalarMaeMfeAggregationPolicy: "POLICY_MISSING",
    p1_5Complete: false,
    p1_5Status: prerequisiteEvidenceComplete ? "BLOCKED_POLICY_MISSING" : "BLOCKED_EVIDENCE",
    profitability: "NOT_PROVEN",
    profitabilityProven: false,
    profitabilityClaimAllowed: false,
    promotion: false,
    currentValidatedChampion: "NONE",
    liveTrading: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
    realOrderCount: 0,
  });
}

export const SETTLEMENT_PROFITABILITY_EVIDENCE_GATE_MINIMUM_SAMPLE_SIZE = FOUR_MARKET_PAPER_SETTLEMENT_MINIMUM_SAMPLE_SIZE;
export const SETTLEMENT_PROFITABILITY_SCALAR_MAE_MFE_POLICY = "POLICY_MISSING";
