import { createHash } from "node:crypto";
import { auditStockUniverseBias } from "./stock-universe-bias-audit.js";
import { settleHistoricalDiscoveryReplay } from "./historical-discovery-settlement-v1.js";

const STOCK_MARKETS = new Set(["KR_STOCK", "US_STOCK"]);
const ACTION_TYPES = new Set(["SPLIT", "DIVIDEND", "MERGER", "SYMBOL_CHANGE", "DELISTING"]);
const ADJUSTMENT_POLICIES = new Set(["RAW", "SPLIT_ADJUSTED", "TOTAL_RETURN_ADJUSTED"]);
const TERMINAL_EVENT_TYPES = new Set(["MERGER", "DELISTING"]);
const DAY = 24 * 60 * 60 * 1000;

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function cleanString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function cleanSymbol(value) {
  const text = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9._:-]{1,40}$/.test(text) ? text : null;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function blocked(reason, details = {}) {
  return Object.freeze({
    schemaVersion: "stock-point-in-time-evidence-adapter-v1",
    status: "BLOCKED_DATA",
    evidenceStatus: "INSUFFICIENT_DATA",
    reason,
    metrics: null,
    ...details,
    safeguards: Object.freeze({
      currentMembershipBackfillForbidden: true,
      futureMembershipAtQueryForbidden: true,
      syntheticHistoricalDataForbidden: true,
      corporateActionCoverageRequired: true,
      rawPricesWithCorporateActionsForbidden: true,
      removedListingsRequireTerminalEvidence: true,
      liveExecutionAllowed: false,
      privateAccountRequestAllowed: false,
      actualOrders: 0,
    }),
  });
}

function normalizeMemberships(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { error: "POINT_IN_TIME_MEMBERSHIPS_MISSING" };
  const seenListingIds = new Set();
  const normalized = [];
  for (const [index, row] of rows.entries()) {
    const listingId = cleanString(row?.listingId);
    const symbol = cleanSymbol(row?.symbol);
    const activeFrom = positiveInteger(row?.activeFrom);
    const activeTo = row?.activeTo == null ? null : positiveInteger(row.activeTo);
    const sourceId = cleanString(row?.sourceId);
    if (!listingId || !symbol || !activeFrom || !sourceId || (row?.activeTo != null && !activeTo)) {
      return { error: "INVALID_MEMBERSHIP_EVIDENCE", index };
    }
    if (activeTo != null && activeTo < activeFrom) return { error: "INVALID_MEMBERSHIP_INTERVAL", listingId };
    if (seenListingIds.has(listingId)) return { error: "DUPLICATE_LISTING_ID", listingId };
    seenListingIds.add(listingId);
    normalized.push(Object.freeze({
      listingId,
      symbol,
      activeFrom,
      activeTo,
      sourceId,
      exchange: cleanString(row?.exchange),
      exitReason: cleanString(row?.exitReason),
    }));
  }
  normalized.sort((a, b) => a.activeFrom - b.activeFrom || a.listingId.localeCompare(b.listingId));
  for (let leftIndex = 0; leftIndex < normalized.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < normalized.length; rightIndex += 1) {
      const left = normalized[leftIndex];
      const right = normalized[rightIndex];
      if (left.symbol !== right.symbol) continue;
      const leftEnd = left.activeTo ?? Number.MAX_SAFE_INTEGER;
      const rightEnd = right.activeTo ?? Number.MAX_SAFE_INTEGER;
      if (left.activeFrom <= rightEnd && right.activeFrom <= leftEnd) {
        return { error: "OVERLAPPING_SYMBOL_LISTINGS", symbol: left.symbol };
      }
    }
  }
  return { value: Object.freeze(normalized) };
}

function normalizeHistories(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { error: "PRICE_HISTORIES_MISSING" };
  const seenListingIds = new Set();
  const normalized = [];
  for (const [index, row] of rows.entries()) {
    const listingId = cleanString(row?.listingId);
    const symbol = cleanSymbol(row?.symbol);
    const sourceId = cleanString(row?.sourceId);
    const adjustmentPolicy = String(row?.adjustmentPolicy ?? "").trim().toUpperCase();
    const terminalEventPolicy = row?.terminalEventPolicy == null ? null : String(row.terminalEventPolicy).trim().toUpperCase();
    if (!listingId || !symbol || !sourceId || !ADJUSTMENT_POLICIES.has(adjustmentPolicy)) {
      return { error: "INVALID_PRICE_HISTORY_EVIDENCE", index };
    }
    if (seenListingIds.has(listingId)) return { error: "DUPLICATE_PRICE_HISTORY_LISTING", listingId };
    seenListingIds.add(listingId);
    if (!Array.isArray(row?.observations) || row.observations.length < 2) {
      return { error: "PRICE_OBSERVATIONS_INSUFFICIENT", listingId };
    }
    const observations = [];
    const seenTimestamps = new Set();
    for (const [observationIndex, observation] of row.observations.entries()) {
      const timestampMs = positiveInteger(observation?.timestampMs);
      const price = finitePositive(observation?.price);
      if (!timestampMs || !price) return { error: "INVALID_PRICE_OBSERVATION", listingId, observationIndex };
      if (seenTimestamps.has(timestampMs)) return { error: "DUPLICATE_PRICE_TIMESTAMP", listingId, timestampMs };
      seenTimestamps.add(timestampMs);
      observations.push(Object.freeze({ timestampMs, price }));
    }
    observations.sort((a, b) => a.timestampMs - b.timestampMs);
    normalized.push(Object.freeze({
      listingId,
      symbol,
      sourceId,
      adjustmentPolicy,
      terminalEventPolicy,
      observations: Object.freeze(observations),
    }));
  }
  return { value: Object.freeze(normalized) };
}

function normalizeActions(rows) {
  if (!Array.isArray(rows)) return { error: "CORPORATE_ACTIONS_MUST_BE_ARRAY" };
  const normalized = [];
  for (const [index, row] of rows.entries()) {
    const listingId = cleanString(row?.listingId);
    const symbol = cleanSymbol(row?.symbol);
    const type = String(row?.type ?? "").trim().toUpperCase();
    const effectiveAt = positiveInteger(row?.effectiveAt);
    const sourceId = cleanString(row?.sourceId);
    if (!listingId || !symbol || !ACTION_TYPES.has(type) || !effectiveAt || !sourceId) {
      return { error: "INVALID_CORPORATE_ACTION_EVIDENCE", index };
    }
    const ratio = row?.ratio == null ? null : finitePositive(row.ratio);
    if (row?.ratio != null && !ratio) return { error: "INVALID_CORPORATE_ACTION_RATIO", index };
    normalized.push(Object.freeze({ listingId, symbol, type, effectiveAt, sourceId, ratio }));
  }
  normalized.sort((a, b) => a.effectiveAt - b.effectiveAt || a.listingId.localeCompare(b.listingId));
  return { value: Object.freeze(normalized) };
}

function historiesForAudit(histories) {
  const bySymbol = new Map();
  for (const history of histories) {
    const firstTimestamp = history.observations[0].timestampMs;
    const lastTimestamp = history.observations[history.observations.length - 1].timestampMs;
    const prior = bySymbol.get(history.symbol);
    if (!prior) {
      bySymbol.set(history.symbol, { symbol: history.symbol, firstTimestamp, lastTimestamp, source: history.sourceId });
      continue;
    }
    prior.firstTimestamp = Math.min(prior.firstTimestamp, firstTimestamp);
    prior.lastTimestamp = Math.max(prior.lastTimestamp, lastTimestamp);
    prior.source = `${prior.source},${history.sourceId}`;
  }
  return [...bySymbol.values()];
}

function activeAt(membership, asOfMs) {
  return membership.activeFrom <= asOfMs && (membership.activeTo == null || membership.activeTo >= asOfMs);
}

function latestAtOrBefore(observations, timestampMs) {
  let selected = null;
  for (const observation of observations) {
    if (observation.timestampMs > timestampMs) break;
    selected = observation;
  }
  return selected;
}

function actionsForListing(actions, listingId, startExclusive, endInclusive) {
  return actions.filter((action) => action.listingId === listingId && action.effectiveAt > startExclusive && action.effectiveAt <= endInclusive);
}

function normalizeCoverage(raw) {
  const startTime = positiveInteger(raw?.startTime);
  const endTime = positiveInteger(raw?.endTime);
  const sourceId = cleanString(raw?.sourceId);
  if (!startTime || !endTime || endTime < startTime || !sourceId || raw?.complete !== true) return null;
  return Object.freeze({ startTime, endTime, sourceId, complete: true });
}

export function createStockPointInTimeEvidenceAdapter(raw = {}) {
  const market = String(raw.market ?? "").trim().toUpperCase();
  const evaluationStartTime = positiveInteger(raw.evaluationStartTime);
  const evaluationEndTime = positiveInteger(raw.evaluationEndTime);
  const frozenAt = positiveInteger(raw.frozenAt);
  if (!STOCK_MARKETS.has(market)) return blocked("STOCK_MARKET_REQUIRED");
  if (!evaluationStartTime || !evaluationEndTime || evaluationEndTime <= evaluationStartTime || !frozenAt) {
    return blocked("INVALID_EVALUATION_RANGE");
  }
  if (frozenAt > evaluationStartTime) return blocked("FUTURE_UNIVERSE_FREEZE_FORBIDDEN");
  if (raw.syntheticHistoricalData === true || raw.fakeHistoricalData === true) return blocked("SYNTHETIC_HISTORICAL_DATA_FORBIDDEN");
  if (raw.currentMembershipBackfill === true) return blocked("CURRENT_MEMBERSHIP_BACKFILL_FORBIDDEN");

  const membershipResult = normalizeMemberships(raw.memberships);
  if (membershipResult.error) return blocked(membershipResult.error, { details: Object.freeze({ index: membershipResult.index ?? null, listingId: membershipResult.listingId ?? null, symbol: membershipResult.symbol ?? null }) });
  const historyResult = normalizeHistories(raw.priceHistories);
  if (historyResult.error) return blocked(historyResult.error, { details: Object.freeze({ index: historyResult.index ?? null, listingId: historyResult.listingId ?? null }) });
  const actionResult = normalizeActions(raw.corporateActions ?? []);
  if (actionResult.error) return blocked(actionResult.error, { details: Object.freeze({ index: actionResult.index ?? null }) });
  const corporateActionCoverage = normalizeCoverage(raw.corporateActionCoverage);
  if (!corporateActionCoverage) return blocked("CORPORATE_ACTION_COVERAGE_MISSING");
  if (corporateActionCoverage.startTime > evaluationStartTime || corporateActionCoverage.endTime < evaluationEndTime) {
    return blocked("CORPORATE_ACTION_COVERAGE_GAP");
  }

  const memberships = membershipResult.value;
  const histories = historyResult.value;
  const corporateActions = actionResult.value;
  const membershipByListing = new Map(memberships.map((membership) => [membership.listingId, membership]));
  const historyByListing = new Map(histories.map((history) => [history.listingId, history]));

  for (const history of histories) {
    const membership = membershipByListing.get(history.listingId);
    if (!membership || membership.symbol !== history.symbol) return blocked("LISTING_IDENTITY_MISMATCH", { details: Object.freeze({ listingId: history.listingId }) });
  }
  for (const action of corporateActions) {
    const membership = membershipByListing.get(action.listingId);
    if (!membership || membership.symbol !== action.symbol) return blocked("CORPORATE_ACTION_LISTING_IDENTITY_MISMATCH", { details: Object.freeze({ listingId: action.listingId }) });
  }

  const missingHistory = memberships.find((membership) => !historyByListing.has(membership.listingId));
  if (missingHistory) return blocked("MEMBERSHIP_PRICE_HISTORY_MISSING", { details: Object.freeze({ listingId: missingHistory.listingId }) });

  const relevantActions = corporateActions.filter((action) => action.effectiveAt >= evaluationStartTime && action.effectiveAt <= corporateActionCoverage.endTime);
  for (const action of relevantActions) {
    const history = historyByListing.get(action.listingId);
    if (history?.adjustmentPolicy === "RAW") {
      return blocked("CORPORATE_ACTION_ADJUSTMENT_NOT_PROVEN", { details: Object.freeze({ listingId: action.listingId, actionType: action.type }) });
    }
  }

  const removedWithinCoverage = memberships.filter((membership) => membership.activeTo != null && membership.activeTo <= corporateActionCoverage.endTime);
  for (const membership of removedWithinCoverage) {
    const terminalAction = corporateActions.find((action) => action.listingId === membership.listingId && TERMINAL_EVENT_TYPES.has(action.type) && Math.abs(action.effectiveAt - membership.activeTo) <= DAY);
    const history = historyByListing.get(membership.listingId);
    if (!terminalAction || history?.terminalEventPolicy !== "LAST_TRADABLE_PRICE") {
      return blocked("REMOVED_LISTING_TERMINAL_EVIDENCE_MISSING", { details: Object.freeze({ listingId: membership.listingId }) });
    }
  }

  let biasAudit;
  try {
    biasAudit = auditStockUniverseBias({
      market,
      evaluationStartTime,
      evaluationEndTime,
      frozenAt,
      memberships: memberships.map((membership) => ({
        symbol: membership.symbol,
        activeFrom: membership.activeFrom,
        activeTo: membership.activeTo,
        exitReason: membership.exitReason,
        sourceId: membership.sourceId,
      })),
      histories: historiesForAudit(histories),
      toleranceMs: Number(raw.toleranceMs ?? 7 * DAY),
    });
  } catch (error) {
    return blocked("INVALID_POINT_IN_TIME_UNIVERSE_EVIDENCE", { details: Object.freeze({ message: String(error?.message ?? error).slice(0, 240) }) });
  }
  if (biasAudit.status !== "point_in_time_bias_gate_passed") {
    return blocked("POINT_IN_TIME_UNIVERSE_AUDIT_FAILED", { biasAudit, metrics: null });
  }

  const evidenceSha256 = digest({
    market,
    evaluationStartTime,
    evaluationEndTime,
    frozenAt,
    memberships,
    histories,
    corporateActions,
    corporateActionCoverage,
  });
  const settlementToleranceMs = Number(raw.settlementToleranceMs ?? 7 * DAY);
  if (!Number.isFinite(settlementToleranceMs) || settlementToleranceMs < 0 || settlementToleranceMs > 31 * DAY) {
    return blocked("INVALID_SETTLEMENT_TOLERANCE");
  }

  async function loadGroundTruthUniverse({ asOfMs, settleAtMs }) {
    const asOf = positiveInteger(asOfMs);
    const settleAt = positiveInteger(settleAtMs);
    if (!asOf || !settleAt || settleAt <= asOf) {
      return { status: "BLOCKED_DATA", reason: "INVALID_GROUND_TRUTH_WINDOW", metrics: null };
    }
    if (asOf < evaluationStartTime || asOf > evaluationEndTime) {
      return { status: "BLOCKED_DATA", reason: "GROUND_TRUTH_ASOF_OUTSIDE_EVALUATION_RANGE", metrics: null };
    }
    if (settleAt > corporateActionCoverage.endTime) {
      return { status: "BLOCKED_DATA", reason: "CORPORATE_ACTION_COVERAGE_GAP", metrics: null };
    }

    const activeMemberships = memberships.filter((membership) => activeAt(membership, asOf));
    if (activeMemberships.length === 0) return { status: "BLOCKED_DATA", reason: "POINT_IN_TIME_UNIVERSE_EMPTY", metrics: null };
    const entries = [];
    for (const membership of activeMemberships) {
      if (membership.activeFrom > asOf) {
        return { status: "BLOCKED_DATA", reason: "FUTURE_UNIVERSE_MEMBERSHIP_DETECTED", metrics: null };
      }
      const history = historyByListing.get(membership.listingId);
      const entryObservation = latestAtOrBefore(history.observations, asOf);
      if (!entryObservation) return { status: "BLOCKED_DATA", reason: "ENTRY_PRICE_AS_OF_MISSING", metrics: null };
      const terminalAt = membership.activeTo != null && membership.activeTo < settleAt ? membership.activeTo : settleAt;
      const path = history.observations.filter((observation) => observation.timestampMs > asOf && observation.timestampMs <= terminalAt);
      if (path.length === 0) return { status: "BLOCKED_DATA", reason: "FORWARD_PRICE_PATH_MISSING", metrics: null };
      const lastObservation = path[path.length - 1];
      if (lastObservation.timestampMs < terminalAt - settlementToleranceMs) {
        return { status: "BLOCKED_DATA", reason: "FORWARD_PRICE_PATH_STALE", metrics: null };
      }
      const windowActions = actionsForListing(corporateActions, membership.listingId, asOf, terminalAt);
      if (windowActions.length > 0 && history.adjustmentPolicy === "RAW") {
        return { status: "BLOCKED_DATA", reason: "CORPORATE_ACTION_ADJUSTMENT_NOT_PROVEN", metrics: null };
      }
      if (membership.activeTo != null && membership.activeTo < settleAt) {
        const terminalAction = windowActions.find((action) => TERMINAL_EVENT_TYPES.has(action.type) && Math.abs(action.effectiveAt - membership.activeTo) <= DAY);
        if (!terminalAction || history.terminalEventPolicy !== "LAST_TRADABLE_PRICE") {
          return { status: "BLOCKED_DATA", reason: "REMOVED_LISTING_TERMINAL_EVIDENCE_MISSING", metrics: null };
        }
      }
      entries.push(Object.freeze({
        symbol: membership.symbol,
        listingId: membership.listingId,
        entryPrice: entryObservation.price,
        observations: Object.freeze(path.map((observation) => ({ timestampMs: observation.timestampMs, price: observation.price }))),
        provenance: Object.freeze({
          membershipSourceId: membership.sourceId,
          priceSourceId: history.sourceId,
          adjustmentPolicy: history.adjustmentPolicy,
          terminalEventPolicy: history.terminalEventPolicy,
          corporateActionSourceIds: Object.freeze([...new Set(windowActions.map((action) => action.sourceId))]),
        }),
      }));
    }

    return Object.freeze({
      universeAsOfMs: asOf,
      pointInTimeOnly: true,
      syntheticHistoricalData: false,
      evidenceSha256,
      corporateActionCoverage: Object.freeze({ ...corporateActionCoverage }),
      entries: Object.freeze(entries),
    });
  }

  return Object.freeze({
    schemaVersion: "stock-point-in-time-evidence-adapter-v1",
    status: "READY",
    evidenceStatus: "EVIDENCED",
    market,
    evaluationStartTime,
    evaluationEndTime,
    frozenAt,
    evidenceSha256,
    biasAudit,
    metrics: Object.freeze({
      membershipCount: memberships.length,
      removedListingCount: memberships.filter((membership) => membership.activeTo != null).length,
      corporateActionCount: corporateActions.length,
      priceHistoryCount: histories.length,
    }),
    loadGroundTruthUniverse,
    safeguards: Object.freeze({
      currentMembershipBackfillForbidden: true,
      futureMembershipAtQueryForbidden: true,
      syntheticHistoricalDataForbidden: true,
      corporateActionCoverageRequired: true,
      rawPricesWithCorporateActionsForbidden: true,
      removedListingsRequireTerminalEvidence: true,
      liveExecutionAllowed: false,
      privateAccountRequestAllowed: false,
      actualOrders: 0,
    }),
  });
}

export async function settleHistoricalStockDiscoveryWithPointInTimeEvidence({ replayResult, evidence, successThresholdPctByHorizon } = {}) {
  const adapter = createStockPointInTimeEvidenceAdapter({
    ...(evidence ?? {}),
    market: replayResult?.market ?? evidence?.market,
  });
  if (adapter.status !== "READY") {
    return Object.freeze({
      schemaVersion: "historical-discovery-settlement-v1",
      status: "BLOCKED",
      dataStatus: "BLOCKED_DATA",
      reason: adapter.reason,
      metrics: null,
      settledSignalCount: null,
      groundTruthOpportunityCount: null,
      profitabilityClaimAllowed: false,
      executionAuthority: "NONE",
      pointInTimeEvidence: adapter,
    });
  }
  const result = await settleHistoricalDiscoveryReplay({
    replayResult,
    successThresholdPctByHorizon,
    loadGroundTruthUniverse: async (query) => {
      const universe = await adapter.loadGroundTruthUniverse(query);
      if (universe?.status === "BLOCKED_DATA") {
        return Object.freeze({
          universeAsOfMs: query.asOfMs,
          syntheticHistoricalData: false,
          entries: Object.freeze([]),
          blockedDataReason: universe.reason,
        });
      }
      return universe;
    },
  });
  if (result.status === "BLOCKED" && result.reason === "GROUND_TRUTH_UNIVERSE_EMPTY") {
    const firstRow = replayResult?.replayRows?.[0];
    if (firstRow) {
      const horizons = replayResult?.strategyMode === "SCALPING" ? [5, 15, 30, 60, 24 * 60] : replayResult?.strategyMode === "MID_LONG" ? [30 * 24 * 60, 90 * 24 * 60, 180 * 24 * 60] : [24 * 60, 3 * 24 * 60, 5 * 24 * 60];
      for (const minutes of horizons) {
        const probe = await adapter.loadGroundTruthUniverse({ asOfMs: firstRow.asOfMs, settleAtMs: firstRow.asOfMs + minutes * 60 * 1000 });
        if (probe?.status === "BLOCKED_DATA") {
          return Object.freeze({ ...result, dataStatus: "BLOCKED_DATA", reason: probe.reason, metrics: null, pointInTimeEvidenceSha256: adapter.evidenceSha256 });
        }
      }
    }
  }
  return Object.freeze({ ...result, pointInTimeEvidenceSha256: adapter.evidenceSha256 });
}
