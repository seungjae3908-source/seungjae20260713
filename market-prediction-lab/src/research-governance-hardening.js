import {
  alignResearchSeries,
  evaluateResearchPromotion,
  summarizeTradePerformance,
  verifyResearchArtifact,
} from "./research-governance.js";
import { sha256, stableStringify } from "./data-quality.js";

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

export function alignStrictResearchSeries(input) {
  if (!Array.isArray(input?.candles)) throw new TypeError("candles must be an array");
  for (let index = 0; index < input.candles.length; index += 1) {
    const candle = input.candles[index];
    if (candle?.isClosed === false) throw new Error(`open candle is not allowed at index ${index}`);
    if (index > 0 && candle.timestamp < input.candles[index - 1].timestamp) {
      throw new Error(`candles must be ordered by ascending timestamp at index ${index}`);
    }
  }
  for (const [name, rows] of Object.entries(input.features ?? {})) {
    if (!Array.isArray(rows)) throw new TypeError(`features.${name} must be an array`);
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index].timestamp < rows[index - 1].timestamp) {
        throw new Error(`features.${name} must be ordered by ascending timestamp at index ${index}`);
      }
    }
  }
  return alignResearchSeries(input);
}

function groupTrades(trades, keySelector) {
  const groups = new Map();
  for (const trade of trades) {
    const key = String(keySelector(trade) ?? "unclassified");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return Object.freeze(Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, rows]) => [key, summarizeTradePerformance(rows)])));
}

export function summarizeTradePerformanceByDimensions(trades) {
  if (!Array.isArray(trades)) throw new TypeError("trades must be an array");
  return Object.freeze({
    overall: summarizeTradePerformance(trades),
    byMarket: groupTrades(trades, (trade) => trade.market),
    bySymbol: groupTrades(trades, (trade) => trade.symbol),
    byTimeframe: groupTrades(trades, (trade) => trade.timeframe),
    byRegime: groupTrades(trades, (trade) => trade.regime),
    byAction: groupTrades(trades, (trade) => trade.action),
    byModelVersion: groupTrades(trades, (trade) => trade.modelVersion),
  });
}

export function selectValidationCandidateAndCheckOverfit(candidates, {
  maxValidationTestGap = 0.15,
  maxTestRankPercentile = 0.5,
} = {}) {
  if (!Array.isArray(candidates) || candidates.length < 2) throw new RangeError("at least two parameter candidates are required");
  finite(maxValidationTestGap, "maxValidationTestGap");
  finite(maxTestRankPercentile, "maxTestRankPercentile");
  if (maxValidationTestGap < 0 || maxTestRankPercentile < 0 || maxTestRankPercentile > 1) throw new RangeError("overfit limits are invalid");
  const normalized = candidates.map((candidate, index) => {
    if (!candidate || typeof candidate.id !== "string" || candidate.id.length === 0) throw new TypeError(`candidates[${index}].id is required`);
    return Object.freeze({
      id: candidate.id,
      validationScore: finite(candidate.validationScore, `candidates[${index}].validationScore`),
      testScore: finite(candidate.testScore, `candidates[${index}].testScore`),
    });
  });
  const selected = [...normalized].sort((left, right) => right.validationScore - left.validationScore || left.id.localeCompare(right.id))[0];
  const testRanking = [...normalized].sort((left, right) => right.testScore - left.testScore || left.id.localeCompare(right.id));
  const testRank = testRanking.findIndex((candidate) => candidate.id === selected.id) + 1;
  const testRankPercentile = (testRank - 1) / (normalized.length - 1);
  const validationTestGap = selected.validationScore - selected.testScore;
  const reasons = [];
  if (validationTestGap > maxValidationTestGap) reasons.push("validation_test_gap_exceeded");
  if (testRankPercentile > maxTestRankPercentile) reasons.push("validation_winner_test_rank_dropped");
  return Object.freeze({
    selectedId: selected.id,
    selectionBasis: "validation_only",
    testUsedForSelection: false,
    validationScore: selected.validationScore,
    testScore: selected.testScore,
    validationTestGap,
    testRank,
    testRankPercentile,
    status: reasons.length === 0 ? "pass" : "research_hold",
    reasons: Object.freeze(reasons),
  });
}

export function evaluateResearchPromotionStrict(input, thresholds = {}) {
  const base = evaluateResearchPromotion(input, thresholds);
  const reasons = [...base.reasons];
  if (input?.overfitChecksPassed !== true) reasons.push("overfit_checks_not_passed");
  if (input?.testSetUntouched !== true) reasons.push("test_set_selection_risk");
  if (!Number.isFinite(input?.paperComparison?.expectancyDelta)) reasons.push("paper_comparison_missing");
  return Object.freeze({
    ...base,
    approved: reasons.length === 0,
    status: reasons.length === 0 ? "integration_review_ready" : "research_hold",
    reasons: Object.freeze([...new Set(reasons)]),
    automaticOperationsAllowed: false,
    mainMergeAllowed: false,
    deploymentAllowed: false,
  });
}

export function createModelResearchRecord({ modelVersion, strategyVersion, datasetHash, artifact, promotion, evaluatedAt }) {
  if (typeof modelVersion !== "string" || modelVersion.length === 0) throw new TypeError("modelVersion is required");
  if (typeof strategyVersion !== "string" || strategyVersion.length === 0) throw new TypeError("strategyVersion is required");
  if (!/^[a-f0-9]{64}$/.test(datasetHash)) throw new TypeError("datasetHash must be a SHA-256 hex digest");
  if (!verifyResearchArtifact(artifact)) throw new Error("artifact integrity verification failed");
  if (!promotion || !["research_hold", "integration_review_ready"].includes(promotion.status)) throw new TypeError("promotion status is invalid");
  if (!Number.isInteger(evaluatedAt) || evaluatedAt <= 0) throw new TypeError("evaluatedAt must be a positive integer");
  const identity = { modelVersion, strategyVersion, datasetHash, artifactHash: artifact.integrityHash, evaluatedAt };
  return Object.freeze({
    schemaVersion: 1,
    id: sha256(stableStringify(identity)),
    ...identity,
    status: promotion.status,
    reasons: Object.freeze([...(promotion.reasons ?? [])]),
    automaticOperationsAllowed: false,
  });
}

export function upsertModelResearchRecord(state, record) {
  if (!record?.id) throw new TypeError("model record is required");
  const records = Array.isArray(state?.records) ? [...state.records] : [];
  const existing = records.find((item) => item.id === record.id);
  if (existing) {
    if (stableStringify(existing) !== stableStringify(record)) throw new Error(`model record conflict: ${record.id}`);
    return Object.freeze({ schemaVersion: 1, records: Object.freeze(records), automaticOperationsAllowed: false });
  }
  records.push(record);
  records.sort((left, right) => left.evaluatedAt - right.evaluatedAt || left.modelVersion.localeCompare(right.modelVersion));
  return Object.freeze({ schemaVersion: 1, records: Object.freeze(records), automaticOperationsAllowed: false });
}
