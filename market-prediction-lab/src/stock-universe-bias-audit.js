import { createHash } from "node:crypto";
import { PredictionInputError } from "./contracts.js";

function integer(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new PredictionInputError(`${label} must be a positive integer`, { value });
  return number;
}

function symbol(value, label) {
  const clean = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9._:-]{1,40}$/.test(clean)) throw new PredictionInputError(`${label} is invalid`, { value });
  return clean;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeMemberships(rows) {
  if (!Array.isArray(rows)) throw new PredictionInputError("memberships must be an array");
  const normalized = rows.map((row, index) => {
    const memberSymbol = symbol(row?.symbol, `memberships[${index}].symbol`);
    const activeFrom = integer(row?.activeFrom, `memberships[${index}].activeFrom`);
    const activeTo = row?.activeTo == null ? null : integer(row.activeTo, `memberships[${index}].activeTo`);
    if (activeTo != null && activeTo < activeFrom) throw new PredictionInputError("membership activeTo must be >= activeFrom", { index, memberSymbol });
    const exitReason = row?.exitReason == null ? null : String(row.exitReason).slice(0, 120);
    const sourceId = String(row?.sourceId ?? "").trim();
    if (!sourceId) throw new PredictionInputError("membership sourceId is required", { index, memberSymbol });
    return Object.freeze({ symbol: memberSymbol, activeFrom, activeTo, exitReason, sourceId });
  });
  normalized.sort((a, b) => a.activeFrom - b.activeFrom || a.symbol.localeCompare(b.symbol));
  for (let index = 1; index < normalized.length; index += 1) {
    const prior = normalized[index - 1];
    const current = normalized[index];
    if (prior.symbol !== current.symbol) continue;
    if (prior.activeTo == null || current.activeFrom <= prior.activeTo) {
      throw new PredictionInputError("membership intervals for one symbol must not overlap", { symbol: current.symbol });
    }
  }
  return Object.freeze(normalized);
}

function normalizeHistories(rows) {
  if (!Array.isArray(rows)) throw new PredictionInputError("histories must be an array");
  const seen = new Set();
  return Object.freeze(rows.map((row, index) => {
    const historySymbol = symbol(row?.symbol, `histories[${index}].symbol`);
    if (seen.has(historySymbol)) throw new PredictionInputError("history symbols must be unique", { historySymbol });
    seen.add(historySymbol);
    const firstTimestamp = integer(row?.firstTimestamp, `histories[${index}].firstTimestamp`);
    const lastTimestamp = integer(row?.lastTimestamp, `histories[${index}].lastTimestamp`);
    if (lastTimestamp < firstTimestamp) throw new PredictionInputError("history lastTimestamp must be >= firstTimestamp", { historySymbol });
    return Object.freeze({ symbol: historySymbol, firstTimestamp, lastTimestamp, source: String(row?.source ?? "unknown") });
  }));
}

function activeDuring(row, startTime, endTime) {
  const end = row.activeTo ?? Number.MAX_SAFE_INTEGER;
  return row.activeFrom <= endTime && end >= startTime;
}

function coversMembership(history, membership, startTime, endTime, toleranceMs) {
  if (!history) return false;
  const requiredStart = Math.max(startTime, membership.activeFrom);
  const requiredEnd = Math.min(endTime, membership.activeTo ?? endTime);
  return history.firstTimestamp <= requiredStart + toleranceMs && history.lastTimestamp >= requiredEnd - toleranceMs;
}

export function auditStockUniverseBias(raw = {}) {
  const market = String(raw.market ?? "");
  if (market !== "US_STOCK" && market !== "KR_STOCK") throw new PredictionInputError("market must be US_STOCK or KR_STOCK");
  const evaluationStartTime = integer(raw.evaluationStartTime, "evaluationStartTime");
  const evaluationEndTime = integer(raw.evaluationEndTime, "evaluationEndTime");
  if (evaluationEndTime <= evaluationStartTime) throw new PredictionInputError("evaluationEndTime must exceed evaluationStartTime");
  const frozenAt = integer(raw.frozenAt, "frozenAt");
  if (frozenAt > evaluationStartTime) throw new PredictionInputError("universe must be frozen no later than evaluation start");
  const toleranceMs = Number(raw.toleranceMs ?? 7 * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0 || toleranceMs > 31 * 24 * 60 * 60 * 1000) throw new PredictionInputError("toleranceMs is invalid");

  const memberships = normalizeMemberships(raw.memberships ?? []);
  const histories = normalizeHistories(raw.histories ?? []);
  const relevant = memberships.filter((row) => activeDuring(row, evaluationStartTime, evaluationEndTime));
  const historyBySymbol = new Map(histories.map((row) => [row.symbol, row]));
  const uniqueSymbols = [...new Set(relevant.map((row) => row.symbol))];
  const exitedMemberships = relevant.filter((row) => row.activeTo != null && row.activeTo <= evaluationEndTime);
  const exitedSymbols = [...new Set(exitedMemberships.map((row) => row.symbol))];
  const coveredMemberships = relevant.filter((row) => coversMembership(historyBySymbol.get(row.symbol), row, evaluationStartTime, evaluationEndTime, toleranceMs));
  const coveredExited = exitedMemberships.filter((row) => coversMembership(historyBySymbol.get(row.symbol), row, evaluationStartTime, evaluationEndTime, toleranceMs));

  const membershipCoverage = relevant.length ? coveredMemberships.length / relevant.length : 0;
  const exitedCoverage = exitedMemberships.length ? coveredExited.length / exitedMemberships.length : 0;
  const minMemberships = Number(raw.minMemberships ?? 20);
  const minExitedSymbols = Number(raw.minExitedSymbols ?? 1);
  const minMembershipCoverage = Number(raw.minMembershipCoverage ?? 0.90);
  const minExitedCoverage = Number(raw.minExitedCoverage ?? 0.80);
  const reasons = [];
  if (relevant.length < minMemberships) reasons.push("insufficient_point_in_time_memberships");
  if (exitedSymbols.length < minExitedSymbols) reasons.push("delisted_or_removed_names_missing");
  if (membershipCoverage < minMembershipCoverage) reasons.push("membership_history_coverage_below_gate");
  if (exitedMemberships.length === 0 || exitedCoverage < minExitedCoverage) reasons.push("removed_name_history_coverage_below_gate");
  if (new Set(relevant.map((row) => row.sourceId)).size === 0) reasons.push("membership_provenance_missing");

  const manifestSha256 = createHash("sha256").update(canonical({ market, evaluationStartTime, evaluationEndTime, frozenAt, memberships })).digest("hex");
  return Object.freeze({
    schemaVersion: 1,
    market,
    status: reasons.length === 0 ? "point_in_time_bias_gate_passed" : "research_hold",
    executionPromotionAllowed: false,
    researchOnly: true,
    evaluationStartTime,
    evaluationEndTime,
    frozenAt,
    manifestSha256,
    metrics: Object.freeze({
      relevantMemberships: relevant.length,
      uniqueSymbols: uniqueSymbols.length,
      exitedMemberships: exitedMemberships.length,
      exitedSymbols: exitedSymbols.length,
      coveredMemberships: coveredMemberships.length,
      coveredExitedMemberships: coveredExited.length,
      membershipCoverage,
      exitedCoverage,
    }),
    gates: Object.freeze({
      pointInTimeMembershipsPresent: relevant.length >= minMemberships,
      removedNamesPresent: exitedSymbols.length >= minExitedSymbols,
      membershipHistoryCoveragePassed: membershipCoverage >= minMembershipCoverage,
      removedNameHistoryCoveragePassed: exitedMemberships.length > 0 && exitedCoverage >= minExitedCoverage,
    }),
    reasons: Object.freeze(reasons),
    safeguards: Object.freeze({
      currentConstituentListAloneCannotPass: true,
      missingHistoriesFailClosed: true,
      overlappingMembershipIntervalsRejected: true,
      liveExecutionAllowed: false,
      privateAccountRequestAllowed: false,
      actualOrders: 0,
    }),
  });
}
