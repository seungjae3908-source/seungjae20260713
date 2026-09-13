export const FROZEN_CANDIDATE_PERFORMANCE_READER_VERSION =
  "frozen-candidate-performance-reader-v1";

const STAGE_READER_VERSION = "authoritative-paper-runtime-stage-evidence-reader-v1";
const MATCH_EVIDENCE_VERSION = "frozen-candidate-match-evidence-v1";
const COST_EVIDENCE_VERSION = "frozen-candidate-full-cost-evidence-v1";
const SHA40 = /^[0-9a-f]{40}$/iu;
const DIGEST64 = /^[0-9a-f]{64}$/iu;
const CANDIDATE_ID = /^(?:phase3-candidate:sha256:|paper-candidate-v1:)[0-9a-f]{64}$/u;
const FORBIDDEN_PROVENANCE = /(?:^|[^a-z])(fixture|fake|example|tests?)(?:[^a-z]|$)/iu;
const ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|\/)/iu;
const COST_KEYS = Object.freeze([
  "commission",
  "tax",
  "spread",
  "slippage",
  "funding",
  "latency",
  "liquidityImpact",
  "partialFillImpact",
]);
const COST_STATES = new Set(["MEASURED", "MODELED", "UNKNOWN", "BLOCKED_DATA"]);
const IDENTITY_FIELDS = Object.freeze([
  "candidateId",
  "strategyFamily",
  "strategyId",
  "strategyVersion",
  "parameterHash",
  "parameterDigest",
  "researchCodeSha",
  "costPolicyVersion",
  "executionPolicyVersion",
  "market",
  "provider",
  "symbol",
  "timeframe",
  "sidePolicy",
  "accountMode",
]);
const LIFECYCLE_IDENTITY_FIELDS = Object.freeze(IDENTITY_FIELDS.filter(
  (field) => field !== "researchCodeSha" && field !== "executionPolicyVersion",
));
const STAGES = Object.freeze([
  Object.freeze({ name: "Entry", output: "Entry_N", collection: "samples", id: "paperSampleId" }),
  Object.freeze({ name: "Position", output: "Position_N", collection: "positions", id: "positionId" }),
  Object.freeze({ name: "Settlement", output: "Settlement_N", collection: "settlements", id: "settlementId" }),
]);

function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function safetyLocks() {
  return {
    FULL_COST_READY: false,
    NET_ALPHA_PROVEN: false,
    PROFITABILITY_PROVEN: false,
    TRAIN_DIAGNOSTIC_ONLY: true,
    VALIDATION_COMPLETE: false,
    OOS_COMPLETE: false,
    sampleCredit: 0,
    executionRealismCredit: 0,
    profitabilityCredit: 0,
    backfillCredit: 0,
    replayCredit: 0,
    syntheticCredit: 0,
    manualEconomicCredit: 0,
    executionAuthority: "NONE",
    LIVE_TRADING: false,
    AUTO_TRADING: false,
    REAL_ORDER_ENABLED: false,
    PRIVATE_TRADING_API_ALLOWED: false,
    realOrderCount: 0,
    cancelCount: 0,
    amendCount: 0,
    transferCount: 0,
    withdrawalCount: 0,
  };
}

function unknownFullCostEvidence() {
  return {
    schemaVersion: COST_EVIDENCE_VERSION,
    fullCostReady: false,
    components: Object.freeze(Object.fromEntries(COST_KEYS.map((key) => [key, Object.freeze({
      state: "UNKNOWN",
      valuePercent: null,
      provenance: null,
    })]))),
  };
}

function unknownMetrics() {
  return {
    candidateMatchedN: null,
    LONG_SIGNAL_N: null,
    SHORT_SIGNAL_N: null,
    NO_TRADE_N: null,
    Entry_N: null,
    Position_N: null,
    PositionObservation_N: null,
    Settlement_N: null,
    TRAIN_N: null,
    VALIDATION_N: null,
    OOS_N: null,
    WIN_N: null,
    LOSS_N: null,
    BREAKEVEN_N: null,
    WIN_RATE: null,
    AVG_WIN: null,
    AVG_LOSS: null,
    PAYOFF_RATIO: null,
    GROSS_EXPECTANCY: null,
    PF: null,
    MDD: null,
    MFE: null,
    MAE: null,
    TIME_TO_EXIT: null,
    Gross_PnL: null,
    Net_PnL: null,
  };
}

function blocked(reason) {
  return deepFreeze({
    schemaVersion: FROZEN_CANDIDATE_PERFORMANCE_READER_VERSION,
    status: "BLOCKED",
    FIRST_ZERO: reason,
    reason,
    candidateId: null,
    strategyId: null,
    freezeTimestamp: null,
    identity: null,
    identity14Verified: false,
    provenance: null,
    effectiveIndependentMarketN: null,
    fullCostEvidence: unknownFullCostEvidence(),
    ...unknownMetrics(),
    ...safetyLocks(),
  });
}

export function blockedFrozenCandidatePerformanceV1(reason) {
  return blocked(nonEmpty(reason) ? reason : "CANDIDATE_PERFORMANCE_READER_FAILED");
}

function assertProductionProvenance(provenance, prefix) {
  if (!record(provenance)
    || provenance.evidenceClass !== "PRODUCTION_AUTHORITATIVE"
    || !nonEmpty(provenance.sourceOwner)
    || provenance.fixture !== false
    || provenance.synthetic !== false
    || provenance.replay !== false
    || provenance.backfill !== false
    || provenance.manual !== false) {
    throw new Error(`${prefix}_PROVENANCE_INVALID`);
  }
  for (const [key, value] of Object.entries(provenance)) {
    if (typeof value !== "string") continue;
    if (FORBIDDEN_PROVENANCE.test(value)) throw new Error(`${prefix}_FIXTURE_PROVENANCE_REJECTED`);
    if (/path/iu.test(key) && ABSOLUTE_PATH.test(value)) throw new Error(`${prefix}_TEST_PATH_REJECTED`);
  }
}

function assertIdentityShape(identity, prefix) {
  if (!record(identity)) throw new Error(`${prefix}_IDENTITY_REQUIRED`);
  for (const field of IDENTITY_FIELDS) {
    if (!nonEmpty(identity[field])) throw new Error(`${prefix}_${field}_REQUIRED`);
  }
  if (!CANDIDATE_ID.test(identity.candidateId)) throw new Error(`${prefix}_CANDIDATE_ID_INVALID`);
  if (!DIGEST64.test(identity.parameterHash) || !DIGEST64.test(identity.parameterDigest)
    || identity.parameterHash !== identity.parameterDigest) {
    throw new Error(`${prefix}_PARAMETER_IDENTITY_INVALID`);
  }
  if (!SHA40.test(identity.researchCodeSha)) throw new Error(`${prefix}_RESEARCH_SHA_INVALID`);
  if (identity.accountMode !== "PAPER") throw new Error(`${prefix}_ACCOUNT_MODE_INVALID`);
}

function normalizedIdentity(identity) {
  return Object.freeze({
    ...Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, identity[field]])),
    researchCodeSha: identity.researchCodeSha.toLowerCase(),
  });
}

function assertExactIdentity(actual, expected, prefix) {
  assertIdentityShape(actual, prefix);
  for (const field of IDENTITY_FIELDS) {
    const left = field === "researchCodeSha" ? actual[field].toLowerCase() : actual[field];
    const right = field === "researchCodeSha" ? expected[field].toLowerCase() : expected[field];
    if (left !== right) throw new Error(`${prefix}_${field}_MISMATCH`);
  }
}

function frozenIdentity(candidate) {
  const source = record(candidate?.identity) ?? candidate;
  assertProductionProvenance(candidate?.provenance, "FROZEN_CANDIDATE");
  assertIdentityShape(source, "FROZEN_CANDIDATE");
  const timestamp = Date.parse(String(candidate?.freezeTimestamp ?? ""));
  if (!Number.isSafeInteger(timestamp)
    || timestamp < 0
    || (candidate.freezeTimestampMs != null && candidate.freezeTimestampMs !== timestamp)) {
    throw new Error("FROZEN_CANDIDATE_TIMESTAMP_INVALID");
  }
  if (candidate?.prospectiveOnly !== true || candidate?.retroactiveCreditAllowed !== false) {
    throw new Error("FROZEN_CANDIDATE_PROSPECTIVE_LOCK_REQUIRED");
  }
  return Object.freeze({ identity: normalizedIdentity(source), freezeTimestamp: new Date(timestamp).toISOString(), freezeTimestampMs: timestamp });
}

function validateStageEvidence(value, expected) {
  if (value?.schemaVersion !== STAGE_READER_VERSION
    || value?.status !== "AUTHORITATIVE_PAPER_RUNTIME_STAGES_RECONCILED"
    || value?.sampleCredit !== 0
    || value?.executionRealismCredit !== 0
    || value?.profitabilityCredit !== 0
    || value?.executionAuthority !== "NONE") {
    throw new Error("CANDIDATE_PERFORMANCE_STAGE_EVIDENCE_INVALID");
  }
  assertExactIdentity(value.candidateIdentity, expected, "CANDIDATE_PERFORMANCE_STAGE");
}

function rowProviders(row, sample) {
  return [
    row?.provider,
    row?.identity?.provider,
    row?.entryEvidenceProvenance?.provider,
    row?.exitEvidenceProvenance?.provider,
    sample?.entryEvidenceProvenance?.provider,
    sample?.exitEvidenceProvenance?.provider,
    sample?.identity?.provider,
  ].filter(nonEmpty);
}

function lifecycleRowIdentity(row, stage) {
  const sample = record(row?.sample);
  const sampleIdentity = record(sample?.identity) ?? {};
  const source = record(row?.identity) ?? record(row) ?? {};
  const providers = rowProviders(row, sample);
  if (new Set(providers).size > 1) {
    throw new Error(`CANDIDATE_PERFORMANCE_${stage.toUpperCase()}_PROVIDER_MISMATCH`);
  }
  return {
    candidateId: source.candidateId ?? row?.candidateId ?? sampleIdentity.candidateId ?? null,
    strategyFamily: source.strategyFamily ?? row?.strategyFamily ?? sampleIdentity.strategyFamily ?? null,
    strategyId: source.strategyId ?? row?.strategyId ?? sampleIdentity.strategyId ?? null,
    strategyVersion: source.strategyVersion ?? row?.strategyVersion ?? sampleIdentity.strategyVersion ?? null,
    parameterHash: source.parameterHash ?? row?.parameterHash ?? sampleIdentity.parameterHash ?? null,
    parameterDigest: source.parameterDigest ?? row?.parameterDigest ?? sampleIdentity.parameterDigest ?? null,
    researchCodeSha: String(source.researchCodeSha ?? row?.researchCodeSha ?? sampleIdentity.researchCodeSha ?? "").toLowerCase() || null,
    costPolicyVersion: source.costPolicyVersion
      ?? row?.costPolicyVersion
      ?? row?.profitEvidence?.costPolicyId
      ?? sample?.profitEvidence?.costPolicyId
      ?? null,
    market: source.market ?? row?.market ?? sampleIdentity.market ?? null,
    provider: providers[0] ?? null,
    symbol: source.symbol ?? row?.symbol ?? sampleIdentity.symbol ?? null,
    timeframe: source.timeframe ?? row?.timeframe ?? sampleIdentity.timeframe ?? null,
    sidePolicy: source.executionDirection
      ?? row?.entryDirection
      ?? row?.direction
      ?? source.signalDirection
      ?? row?.signalDirection
      ?? sampleIdentity.executionDirection
      ?? sampleIdentity.signalDirection
      ?? null,
    accountMode: source.accountMode ?? row?.accountMode ?? sampleIdentity.accountMode ?? null,
  };
}

function assertExactLifecycleIdentity(actual, expected, prefix) {
  for (const field of LIFECYCLE_IDENTITY_FIELDS) {
    if (actual[field] !== expected[field]) throw new Error(`${prefix}_${field}_MISMATCH`);
  }
  if (actual.researchCodeSha !== expected.researchCodeSha.toLowerCase()) {
    throw new Error(`${prefix}_researchCodeSha_MISMATCH`);
  }
}

function stageRows(stageEvidence, state, expected) {
  const counts = {};
  const rows = {};
  for (const stage of STAGES) {
    const measurement = stageEvidence.runtimeStageMeasurements?.[stage.name];
    if (measurement?.status !== "MEASURED" || measurement.candidateBound !== true
      || !Number.isInteger(measurement.count) || measurement.count < 0
      || !Array.isArray(measurement.observationIds)
      || measurement.observationIds.length !== measurement.count
      || new Set(measurement.observationIds).size !== measurement.count) {
      counts[stage.output] = null;
      rows[stage.name] = [];
      continue;
    }
    const collection = state?.[stage.collection];
    if (!Array.isArray(collection)) throw new Error(`CANDIDATE_PERFORMANCE_${stage.collection.toUpperCase()}_REQUIRED`);
    rows[stage.name] = measurement.observationIds.map((id) => {
      const matches = collection.filter((row) => row?.[stage.id] === id);
      if (matches.length !== 1) throw new Error(`CANDIDATE_PERFORMANCE_${stage.name.toUpperCase()}_ROW_BINDING_INVALID`);
      assertExactLifecycleIdentity(
        lifecycleRowIdentity(matches[0], stage.name),
        expected,
        `CANDIDATE_PERFORMANCE_${stage.name.toUpperCase()}`,
      );
      return matches[0];
    });
    counts[stage.output] = measurement.count;
  }
  if (counts.Entry_N != null && counts.Position_N != null && counts.Position_N > counts.Entry_N) {
    throw new Error("CANDIDATE_PERFORMANCE_POSITION_EXCEEDS_ENTRY");
  }
  if (counts.Position_N != null && counts.Settlement_N != null && counts.Settlement_N > counts.Position_N) {
    throw new Error("CANDIDATE_PERFORMANCE_SETTLEMENT_EXCEEDS_POSITION");
  }
  return { counts: Object.freeze(counts), rows: Object.freeze(rows) };
}

function matchEvidence(value, expected, freezeTimestampMs) {
  if (value == null) return null;
  assertProductionProvenance(value.provenance, "CANDIDATE_MATCH");
  if (value?.schemaVersion !== MATCH_EVIDENCE_VERSION
    || value.replay === true || value.backfill === true || value.synthetic === true || value.manual === true
    || value.status !== "MEASURED"
    || !Array.isArray(value.observations)) {
    throw new Error("CANDIDATE_MATCH_EVIDENCE_INVALID");
  }
  const ids = new Set();
  const directions = { LONG: 0, SHORT: 0, NO_TRADE: 0 };
  const splits = { TRAIN: 0, VALIDATION: 0, OOS: 0 };
  for (const observation of value.observations) {
    assertExactIdentity(observation?.identity, expected, "CANDIDATE_MATCH");
    if (!nonEmpty(observation.observationId) || ids.has(observation.observationId)) {
      throw new Error("CANDIDATE_MATCH_OBSERVATION_ID_INVALID");
    }
    if (!Number.isSafeInteger(observation.observedAtMs) || observation.observedAtMs <= freezeTimestampMs) {
      throw new Error("CANDIDATE_MATCH_RETROACTIVE_EVIDENCE_REJECTED");
    }
    if (!Object.hasOwn(directions, observation.direction) || !Object.hasOwn(splits, observation.split)) {
      throw new Error("CANDIDATE_MATCH_CLASSIFICATION_INVALID");
    }
    ids.add(observation.observationId);
    directions[observation.direction] += 1;
    splits[observation.split] += 1;
  }
  return Object.freeze({ count: ids.size, directions: Object.freeze(directions), splits: Object.freeze(splits) });
}

function fullCostEvidence(value) {
  if (value == null) return Object.freeze(unknownFullCostEvidence());
  assertProductionProvenance(value.provenance, "FULL_COST");
  if (value.schemaVersion !== COST_EVIDENCE_VERSION
    || value.fullCostReady !== false
    || !record(value.components)) {
    throw new Error("FULL_COST_EVIDENCE_INVALID");
  }
  const components = Object.fromEntries(COST_KEYS.map((key) => {
    const component = record(value.components[key]);
    if (!component || !COST_STATES.has(component.state)) throw new Error(`FULL_COST_${key}_STATE_INVALID`);
    const valueReady = component.state === "MEASURED" || component.state === "MODELED";
    if ((valueReady && (!finite(component.valuePercent) || component.valuePercent < 0))
      || (!valueReady && component.valuePercent != null)) {
      throw new Error(`FULL_COST_${key}_VALUE_INVALID`);
    }
    if (component.provenance != null && (!nonEmpty(component.provenance)
      || FORBIDDEN_PROVENANCE.test(component.provenance)
      || ABSOLUTE_PATH.test(component.provenance))) {
      throw new Error(`FULL_COST_${key}_PROVENANCE_INVALID`);
    }
    return [key, Object.freeze({
      state: component.state,
      valuePercent: valueReady ? component.valuePercent : null,
      provenance: component.provenance ?? null,
    })];
  }));
  return Object.freeze({
    schemaVersion: COST_EVIDENCE_VERSION,
    fullCostReady: false,
    components: Object.freeze(components),
  });
}

function maximumDrawdown(returns) {
  let equity = 1;
  let peak = 1;
  let drawdown = 0;
  for (const value of returns) {
    equity *= 1 + value / 100;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, ((peak - equity) / peak) * 100);
  }
  return drawdown;
}

function settlementMetrics(rows, measuredCount) {
  if (measuredCount === 0 && rows.length === 0) {
    return { WIN_N: 0, LOSS_N: 0, BREAKEVEN_N: 0, Gross_PnL: 0 };
  }
  if (rows.length === 0 || rows.some((row) => row?.status !== "SETTLED" || !finite(row.grossPnl))) {
    return {};
  }
  const orderedRows = [...rows].sort((left, right) => (left.settledAtMs ?? 0) - (right.settledAtMs ?? 0));
  const gross = orderedRows.map((row) => row.grossPnl);
  const wins = gross.filter((value) => value > 0);
  const losses = gross.filter((value) => value < 0);
  const gain = wins.reduce((sum, value) => sum + value, 0);
  const loss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const returns = orderedRows.map((row) => row.grossReturnPercent);
  const excursionsReady = orderedRows.every((row) => finite(row.mfePercent) && finite(row.maePercent));
  const holdingReady = orderedRows.every((row) => finite(row.holdingMs) && row.holdingMs >= 0);
  const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return {
    WIN_N: wins.length,
    LOSS_N: losses.length,
    BREAKEVEN_N: gross.filter((value) => value === 0).length,
    WIN_RATE: wins.length / orderedRows.length,
    AVG_WIN: average(wins),
    AVG_LOSS: average(losses),
    PAYOFF_RATIO: wins.length && losses.length && average(losses) !== 0 ? average(wins) / Math.abs(average(losses)) : null,
    GROSS_EXPECTANCY: average(gross),
    PF: loss > 0 ? gain / loss : gain > 0 ? null : 0,
    MDD: returns.every(finite) ? maximumDrawdown(returns) : null,
    MFE: excursionsReady ? average(orderedRows.map((row) => row.mfePercent)) : null,
    MAE: excursionsReady ? average(orderedRows.map((row) => row.maePercent)) : null,
    TIME_TO_EXIT: holdingReady ? average(orderedRows.map((row) => row.holdingMs)) : null,
    Gross_PnL: gross.reduce((sum, value) => sum + value, 0),
  };
}

function firstZero(result) {
  for (const [field, reason] of [
    ["candidateMatchedN", "CANDIDATE_MATCH_EVIDENCE_UNKNOWN"],
    ["Entry_N", "CANDIDATE_ENTRY_EVIDENCE_UNKNOWN"],
    ["Position_N", "CANDIDATE_POSITION_EVIDENCE_UNKNOWN"],
    ["Settlement_N", "CANDIDATE_SETTLEMENT_EVIDENCE_UNKNOWN"],
    ["Gross_PnL", "CANDIDATE_GROSS_PNL_UNKNOWN"],
    ["Net_PnL", "FULL_COST_EVIDENCE_NOT_READY"],
  ]) {
    if (result[field] == null) return reason;
  }
  return "VALIDATION_EVIDENCE_NOT_AVAILABLE";
}

export function readFrozenCandidatePerformanceV1({
  frozenCandidate,
  reconciledStageEvidence,
  recurringState,
  candidateMatchEvidence = null,
  effectiveIndependentMarketN = null,
  fullCostEvidence: fullCostInput = null,
} = {}) {
  try {
    const frozen = frozenIdentity(frozenCandidate);
    validateStageEvidence(reconciledStageEvidence, frozen.identity);
    const stages = stageRows(reconciledStageEvidence, recurringState, frozen.identity);
    const matches = matchEvidence(candidateMatchEvidence, frozen.identity, frozen.freezeTimestampMs);
    const positionRows = stages.rows.Position;
    const positionObservationN = stages.counts.Position_N === 0
      ? 0
      : positionRows.length > 0
        && positionRows.every((row) => Array.isArray(row?.lifecycle?.processedObservationIds))
        ? new Set(positionRows.flatMap((row) => row.lifecycle.processedObservationIds)).size
        : null;
    const metrics = settlementMetrics(stages.rows.Settlement, stages.counts.Settlement_N);
    const costs = fullCostEvidence(fullCostInput);
    const independentN = Number.isInteger(effectiveIndependentMarketN) && effectiveIndependentMarketN >= 0
      ? effectiveIndependentMarketN
      : null;
    const result = {
      schemaVersion: FROZEN_CANDIDATE_PERFORMANCE_READER_VERSION,
      status: "PRESENT",
      FIRST_ZERO: null,
      reason: null,
      candidateId: frozen.identity.candidateId,
      strategyId: frozen.identity.strategyId,
      freezeTimestamp: frozen.freezeTimestamp,
      identity: frozen.identity,
      identity14Verified: true,
      provenance: frozenCandidate.provenance,
      effectiveIndependentMarketN: independentN,
      fullCostEvidence: costs,
      ...unknownMetrics(),
      candidateMatchedN: matches?.count ?? null,
      LONG_SIGNAL_N: matches?.directions.LONG ?? null,
      SHORT_SIGNAL_N: matches?.directions.SHORT ?? null,
      NO_TRADE_N: matches?.directions.NO_TRADE ?? null,
      ...stages.counts,
      PositionObservation_N: positionObservationN,
      TRAIN_N: matches?.splits.TRAIN ?? null,
      VALIDATION_N: matches?.splits.VALIDATION ?? null,
      OOS_N: matches?.splits.OOS ?? null,
      ...metrics,
      Net_PnL: null,
      ...safetyLocks(),
    };
    result.FIRST_ZERO = firstZero(result);
    result.reason = result.FIRST_ZERO;
    return deepFreeze(result);
  } catch (error) {
    return blocked(nonEmpty(error?.message) ? error.message : "CANDIDATE_PERFORMANCE_READER_FAILED");
  }
}

export const FROZEN_CANDIDATE_MATCH_EVIDENCE_VERSION = MATCH_EVIDENCE_VERSION;
export const FROZEN_CANDIDATE_FULL_COST_EVIDENCE_VERSION = COST_EVIDENCE_VERSION;
