import { createHash } from "node:crypto";

export const ADAPTIVE_MULTI_MARKET_TOURNAMENT_CONTRACT_V1 =
  "adaptive-multi-market-tournament-orchestrator/v1";

export const ADAPTIVE_TOURNAMENT_STAGES_V1 = Object.freeze([
  "FORMULA_CANDIDATE",
  "SANITY_CHECK",
  "DEVELOPMENT_BACKTEST",
  "DEVELOPMENT_BASE_COST",
  "BLIND_OOS",
  "PURGED_OOS",
  "WALK_FORWARD",
  "COST_STRESS",
  "REGIME_STRESS",
  "STATISTICAL_FIREWALL",
  "SHADOW_CANDIDATE",
  "FORWARD_CANDIDATE",
  "PAPER_ELIGIBLE",
]);

const HORIZONS = Object.freeze({
  SHORT: Object.freeze({ timeframe: "15m" }),
  SWING: Object.freeze({ timeframe: "1h" }),
  POSITION: Object.freeze({ timeframe: "1d" }),
});

const MARKET_DEFINITIONS = Object.freeze({
  KR_STOCK: Object.freeze({
    directions: Object.freeze(["BUY"]),
    requirements: Object.freeze([
      "POINT_IN_TIME_UNIVERSE",
      "DELISTED_UNIVERSE_INCLUDED",
      "CORPORATE_ACTIONS",
      "SESSION_CALENDAR",
      "EXACT_TIMEFRAME_CLOSED_OHLCV",
      "IMMUTABLE_DATASET_IDENTITY",
      "COST_POLICY_IDENTITY",
    ]),
  }),
  US_STOCK: Object.freeze({
    directions: Object.freeze(["BUY"]),
    requirements: Object.freeze([
      "POINT_IN_TIME_UNIVERSE",
      "DELISTED_UNIVERSE_INCLUDED",
      "CORPORATE_ACTIONS",
      "SESSION_CALENDAR",
      "EXACT_TIMEFRAME_CLOSED_OHLCV",
      "IMMUTABLE_DATASET_IDENTITY",
      "COST_POLICY_IDENTITY",
    ]),
  }),
  CRYPTO_SPOT: Object.freeze({
    directions: Object.freeze(["BUY"]),
    requirements: Object.freeze([
      "PUBLIC_ONLY_SOURCE",
      "LISTING_HISTORY",
      "DELISTING_HISTORY",
      "EXACT_TIMEFRAME_CLOSED_OHLCV",
      "IMMUTABLE_DATASET_IDENTITY",
      "COST_POLICY_IDENTITY",
    ]),
  }),
  CRYPTO_FUTURES: Object.freeze({
    directions: Object.freeze(["LONG", "SHORT"]),
    requirements: Object.freeze([
      "PUBLIC_ONLY_SOURCE",
      "EXACT_TIMEFRAME_CLOSED_OHLCV",
      "MARK_PRICE",
      "INDEX_PRICE",
      "FUNDING",
      "OPEN_INTEREST",
      "BASIS",
      "LIQUIDATION_RISK",
      "IMMUTABLE_DATASET_IDENTITY",
      "COST_POLICY_IDENTITY",
    ]),
  }),
});

const DIAGNOSTIC_FIELDS = Object.freeze([
  "dataCompleteness",
  "signalCoverage",
  "costCoverage",
  "familyDiversity",
  "computeCapacity",
]);

const MAXIMIZE_OBJECTIVES = Object.freeze([
  "netExpectancy",
  "profitFactor",
  "independentN",
  "walkForwardConsistency",
  "regimeCoverage",
]);

const MINIMIZE_OBJECTIVES = Object.freeze([
  "maximumDrawdown",
  "costSensitivity",
  "turnover",
  "parameterInstability",
  "concentration",
]);

const FORBIDDEN_FEEDBACK_KEY =
  /(oos|forward|paper|holdout|profit|pnl|expectancy|sharpe|sortino|calmar|winrate|drawdown|\bmdd\b|\bpf\b|return|alpha|champion|promotion)/iu;
const SHA40 = /^[0-9a-f]{40}$/u;
const HASH64 = /^[0-9a-f]{64}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function fail(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = Object.freeze({ ...details });
  throw error;
}

function plainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function canonical(value, path = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("CANONICAL_NON_FINITE_NUMBER", { path, value });
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => canonical(entry, `${path}[${index}]`));
  if (!plainObject(value)) fail("CANONICAL_NON_PLAIN_OBJECT", { path });
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key], `${path}.${key}`)]),
  );
}

export function canonicalSerializeAdaptiveTournamentV1(value) {
  return JSON.stringify(canonical(value));
}

function digest(value) {
  return createHash("sha256")
    .update(canonicalSerializeAdaptiveTournamentV1(value), "utf8")
    .digest("hex");
}

function requiredText(value, code) {
  if (typeof value !== "string" || value.trim().length === 0) fail(code, { value });
  return value.trim();
}

function positiveInteger(value, code, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(code, { value, maximum });
  return value;
}

function nonNegativeInteger(value, code, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail(code, { value, maximum });
  return value;
}

function unitInterval(value, code) {
  if (!Number.isFinite(value) || value < 0 || value > 1) fail(code, { value });
  return value;
}

function exactKeys(value, expected, code) {
  if (!plainObject(value)) fail(code, { reason: "NOT_PLAIN_OBJECT" });
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code, { actual, expected: wanted });
  }
}

function assertNoForbiddenFeedback(value, path = "developmentDiagnostics") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenFeedback(entry, `${path}[${index}]`));
    return;
  }
  if (!plainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_FEEDBACK_KEY.test(key)) fail("HINDSIGHT_FEEDBACK_FORBIDDEN", { path: `${path}.${key}` });
    assertNoForbiddenFeedback(nested, `${path}.${key}`);
  }
}

function buildProfiles() {
  const profiles = [];
  for (const [market, definition] of Object.entries(MARKET_DEFINITIONS)) {
    for (const [horizon, horizonDefinition] of Object.entries(HORIZONS)) {
      profiles.push(deepFreeze({
        profileId: `${market}:${horizon}`,
        market,
        horizon,
        timeframe: horizonDefinition.timeframe,
        directions: definition.directions,
        requiredEvidence: definition.requirements,
      }));
    }
  }
  return deepFreeze(profiles.sort((left, right) => left.profileId.localeCompare(right.profileId)));
}

export const ADAPTIVE_MULTI_MARKET_PROFILES_V1 = buildProfiles();
const PROFILE_BY_ID = new Map(ADAPTIVE_MULTI_MARKET_PROFILES_V1.map((profile) => [profile.profileId, profile]));

function normalizeEvidenceCell(raw, profileId, requirement) {
  if (raw === undefined || raw === null) {
    return deepFreeze({ requirement, status: "MISSING", evidenceId: null, observedAt: null });
  }
  exactKeys(raw, ["status", "evidenceId", "observedAt"], "READINESS_EVIDENCE_CELL_SHAPE_INVALID");
  const status = requiredText(raw.status, "READINESS_EVIDENCE_STATUS_REQUIRED").toUpperCase();
  if (!new Set(["PRESENT", "MISSING", "INVALID"]).has(status)) {
    fail("READINESS_EVIDENCE_STATUS_INVALID", { profileId, requirement, status });
  }
  if (status === "PRESENT") {
    requiredText(raw.evidenceId, "READINESS_EVIDENCE_ID_REQUIRED");
    if (typeof raw.observedAt !== "string" || !ISO_TIMESTAMP.test(raw.observedAt)) {
      fail("READINESS_EVIDENCE_TIMESTAMP_INVALID", { profileId, requirement, observedAt: raw.observedAt });
    }
  } else if (raw.evidenceId !== null || raw.observedAt !== null) {
    fail("MISSING_EVIDENCE_MUST_PRESERVE_NULL", { profileId, requirement, status });
  }
  return deepFreeze({
    requirement,
    status,
    evidenceId: status === "PRESENT" ? raw.evidenceId : null,
    observedAt: status === "PRESENT" ? raw.observedAt : null,
  });
}

export function assessAdaptiveProfileReadinessV1({ evidenceCatalog = {} } = {}) {
  if (!plainObject(evidenceCatalog)) fail("EVIDENCE_CATALOG_INVALID");
  const unknownProfiles = Object.keys(evidenceCatalog).filter((profileId) => !PROFILE_BY_ID.has(profileId));
  if (unknownProfiles.length > 0) fail("UNKNOWN_PROFILE_EVIDENCE", { unknownProfiles: unknownProfiles.sort() });

  const rows = ADAPTIVE_MULTI_MARKET_PROFILES_V1.map((profile) => {
    const supplied = evidenceCatalog[profile.profileId] ?? {};
    if (!plainObject(supplied)) fail("PROFILE_EVIDENCE_INVALID", { profileId: profile.profileId });
    const unknownRequirements = Object.keys(supplied).filter((key) => !profile.requiredEvidence.includes(key));
    if (unknownRequirements.length > 0) {
      fail("UNKNOWN_PROFILE_REQUIREMENT", { profileId: profile.profileId, unknownRequirements: unknownRequirements.sort() });
    }
    const evidence = profile.requiredEvidence.map((requirement) =>
      normalizeEvidenceCell(supplied[requirement], profile.profileId, requirement));
    const missingRequirements = evidence
      .filter((cell) => cell.status !== "PRESENT")
      .map((cell) => cell.requirement);
    const status = missingRequirements.length === 0 ? "READY" : "BLOCKED_MISSING_EVIDENCE";
    return deepFreeze({
      ...profile,
      status,
      evidence,
      missingRequirements,
      candidateBudgetEligible: status === "READY",
      missingEvidenceNumericSubstitutionAllowed: false,
    });
  });

  return deepFreeze({
    schemaVersion: 1,
    contract: "adaptive-profile-readiness/v1",
    profileCount: rows.length,
    readyProfileCount: rows.filter((row) => row.status === "READY").length,
    blockedProfileCount: rows.filter((row) => row.status !== "READY").length,
    profiles: rows,
    fullCostReady: false,
    profitabilityProven: false,
  });
}

function normalizeDiagnostic(raw, profileId) {
  assertNoForbiddenFeedback(raw, `developmentDiagnostics.${profileId}`);
  exactKeys(raw, ["sourceRole", "evidenceId", ...DIAGNOSTIC_FIELDS], "DEVELOPMENT_DIAGNOSTIC_SHAPE_INVALID");
  if (requiredText(raw.sourceRole, "DEVELOPMENT_DIAGNOSTIC_SOURCE_ROLE_REQUIRED") !== "DEVELOPMENT_ONLY") {
    fail("DEVELOPMENT_ONLY_DIAGNOSTIC_REQUIRED", { profileId, sourceRole: raw.sourceRole });
  }
  const evidenceId = requiredText(raw.evidenceId, "DEVELOPMENT_DIAGNOSTIC_EVIDENCE_ID_REQUIRED");
  const result = { sourceRole: "DEVELOPMENT_ONLY", evidenceId };
  for (const field of DIAGNOSTIC_FIELDS) {
    result[field] = unitInterval(raw[field], `DEVELOPMENT_DIAGNOSTIC_${field.toUpperCase()}_INVALID`);
  }
  return deepFreeze(result);
}

function normalizePolicy(raw) {
  exactKeys(raw, [
    "policyId",
    "totalCandidateBudget",
    "minimumCandidatesPerReadyProfile",
    "maximumCandidatesPerReadyProfile",
    "diagnosticWeights",
    "stagePolicy",
    "maximumParetoSurvivorsPerSpecialist",
  ], "ADAPTIVE_POLICY_SHAPE_INVALID");

  const policyId = requiredText(raw.policyId, "ADAPTIVE_POLICY_ID_REQUIRED");
  const totalCandidateBudget = positiveInteger(raw.totalCandidateBudget, "TOTAL_CANDIDATE_BUDGET_INVALID", 100_000);
  const minimumCandidatesPerReadyProfile = positiveInteger(
    raw.minimumCandidatesPerReadyProfile,
    "MINIMUM_PROFILE_BUDGET_INVALID",
    10_000,
  );
  const maximumCandidatesPerReadyProfile = positiveInteger(
    raw.maximumCandidatesPerReadyProfile,
    "MAXIMUM_PROFILE_BUDGET_INVALID",
    10_000,
  );
  if (minimumCandidatesPerReadyProfile > maximumCandidatesPerReadyProfile) {
    fail("PROFILE_BUDGET_RANGE_INVALID");
  }

  exactKeys(raw.diagnosticWeights, DIAGNOSTIC_FIELDS, "DIAGNOSTIC_WEIGHTS_SHAPE_INVALID");
  const diagnosticWeights = Object.fromEntries(
    DIAGNOSTIC_FIELDS.map((field) => [field, unitInterval(
      raw.diagnosticWeights[field],
      `DIAGNOSTIC_WEIGHT_${field.toUpperCase()}_INVALID`,
    )]),
  );
  const weightTotal = Object.values(diagnosticWeights).reduce((sum, value) => sum + value, 0);
  if (Math.abs(weightTotal - 1) > 1e-9) fail("DIAGNOSTIC_WEIGHTS_MUST_SUM_TO_ONE", { weightTotal });

  if (!Array.isArray(raw.stagePolicy) || raw.stagePolicy.length !== ADAPTIVE_TOURNAMENT_STAGES_V1.length) {
    fail("STAGE_POLICY_LENGTH_INVALID", {
      actual: Array.isArray(raw.stagePolicy) ? raw.stagePolicy.length : null,
      expected: ADAPTIVE_TOURNAMENT_STAGES_V1.length,
    });
  }
  let previousRatio = 1;
  let previousMaximum = maximumCandidatesPerReadyProfile;
  const stagePolicy = raw.stagePolicy.map((row, index) => {
    exactKeys(row, ["stage", "retentionRatio", "maximumPerProfile"], "STAGE_POLICY_ROW_SHAPE_INVALID");
    const expectedStage = ADAPTIVE_TOURNAMENT_STAGES_V1[index];
    if (row.stage !== expectedStage) fail("STAGE_POLICY_ORDER_INVALID", { index, expectedStage, actual: row.stage });
    const retentionRatio = unitInterval(row.retentionRatio, "STAGE_RETENTION_RATIO_INVALID");
    const maximumPerProfile = nonNegativeInteger(row.maximumPerProfile, "STAGE_MAXIMUM_PER_PROFILE_INVALID", 10_000);
    if (index === 0 && retentionRatio !== 1) fail("FORMULA_CANDIDATE_RETENTION_MUST_BE_ONE");
    if (retentionRatio > previousRatio + 1e-12) fail("STAGE_RETENTION_MUST_NOT_INCREASE", { stage: row.stage });
    if (maximumPerProfile > previousMaximum) fail("STAGE_MAXIMUM_MUST_NOT_INCREASE", { stage: row.stage });
    previousRatio = retentionRatio;
    previousMaximum = maximumPerProfile;
    return deepFreeze({ stage: row.stage, retentionRatio, maximumPerProfile });
  });

  const byStage = new Map(stagePolicy.map((row) => [row.stage, row]));
  if (byStage.get("SHADOW_CANDIDATE").maximumPerProfile > 2) fail("SHADOW_CANDIDATE_CAP_EXCEEDED");
  if (byStage.get("FORWARD_CANDIDATE").maximumPerProfile > 1) fail("FORWARD_CANDIDATE_CAP_EXCEEDED");
  if (byStage.get("PAPER_ELIGIBLE").maximumPerProfile > 1) fail("PAPER_ELIGIBLE_CAP_EXCEEDED");

  const maximumParetoSurvivorsPerSpecialist = positiveInteger(
    raw.maximumParetoSurvivorsPerSpecialist,
    "PARETO_SURVIVOR_CAP_INVALID",
    2,
  );

  const core = {
    policyId,
    totalCandidateBudget,
    minimumCandidatesPerReadyProfile,
    maximumCandidatesPerReadyProfile,
    diagnosticWeights,
    stagePolicy,
    maximumParetoSurvivorsPerSpecialist,
  };
  return deepFreeze({ ...core, policyDigest: digest(core) });
}

function weightedDiagnostic(diagnostic, weights) {
  return DIAGNOSTIC_FIELDS.reduce((sum, field) => sum + (diagnostic[field] * weights[field]), 0);
}

function distributeLargestRemainder(rows, remaining) {
  let left = remaining;
  while (left > 0) {
    const active = rows.filter((row) => row.allocated < row.maximum);
    if (active.length === 0) break;
    const weightTotal = active.reduce((sum, row) => sum + row.weight, 0);
    const denominator = weightTotal > 0 ? weightTotal : active.length;
    const quotas = active.map((row) => {
      const share = weightTotal > 0 ? row.weight / denominator : 1 / denominator;
      const raw = share * left;
      return { row, floor: Math.min(row.maximum - row.allocated, Math.floor(raw)), remainder: raw - Math.floor(raw) };
    });
    let assigned = 0;
    for (const quota of quotas) {
      quota.row.allocated += quota.floor;
      assigned += quota.floor;
    }
    left -= assigned;
    if (left <= 0) break;
    const ordered = quotas
      .filter((quota) => quota.row.allocated < quota.row.maximum)
      .sort((leftQuota, rightQuota) =>
        rightQuota.remainder - leftQuota.remainder
        || rightQuota.row.weight - leftQuota.row.weight
        || leftQuota.row.profileId.localeCompare(rightQuota.row.profileId));
    if (ordered.length === 0) break;
    for (const quota of ordered) {
      if (left <= 0) break;
      if (quota.row.allocated >= quota.row.maximum) continue;
      quota.row.allocated += 1;
      left -= 1;
    }
  }
  return left;
}

export function allocateAdaptiveTournamentBudgetV1({
  readiness,
  developmentDiagnostics = {},
  policy: rawPolicy,
} = {}) {
  if (!readiness || readiness.contract !== "adaptive-profile-readiness/v1" || !Array.isArray(readiness.profiles)) {
    fail("ADAPTIVE_READINESS_REQUIRED");
  }
  if (!plainObject(developmentDiagnostics)) fail("DEVELOPMENT_DIAGNOSTICS_INVALID");
  const unknownDiagnostics = Object.keys(developmentDiagnostics).filter((profileId) => !PROFILE_BY_ID.has(profileId));
  if (unknownDiagnostics.length > 0) fail("UNKNOWN_PROFILE_DIAGNOSTIC", { unknownDiagnostics: unknownDiagnostics.sort() });
  assertNoForbiddenFeedback(developmentDiagnostics);
  const policy = normalizePolicy(rawPolicy);
  const ready = readiness.profiles.filter((profile) => profile.status === "READY");

  if (ready.length === 0) {
    return deepFreeze({
      schemaVersion: 1,
      contract: "adaptive-candidate-budget-allocation/v1",
      status: "NO_READY_PROFILES",
      policy,
      initialCandidateFamilySize: 0,
      allocations: readiness.profiles.map((profile) => deepFreeze({
        profileId: profile.profileId,
        market: profile.market,
        horizon: profile.horizon,
        timeframe: profile.timeframe,
        directions: profile.directions,
        status: "BLOCKED_MISSING_EVIDENCE",
        allocatedCandidates: 0,
        developmentDiagnostic: null,
      })),
      unallocatedCandidates: policy.totalCandidateBudget,
      oosFeedbackConsumed: false,
      forwardFeedbackConsumed: false,
      paperFeedbackConsumed: false,
    });
  }

  if (policy.totalCandidateBudget < ready.length * policy.minimumCandidatesPerReadyProfile) {
    fail("TOTAL_BUDGET_BELOW_READY_PROFILE_MINIMUM", { readyProfiles: ready.length });
  }
  if (policy.totalCandidateBudget > ready.length * policy.maximumCandidatesPerReadyProfile) {
    fail("TOTAL_BUDGET_EXCEEDS_READY_PROFILE_CAPACITY", { readyProfiles: ready.length });
  }

  const working = ready.map((profile) => {
    if (!developmentDiagnostics[profile.profileId]) {
      fail("DEVELOPMENT_DIAGNOSTIC_REQUIRED", { profileId: profile.profileId });
    }
    const diagnostic = normalizeDiagnostic(developmentDiagnostics[profile.profileId], profile.profileId);
    return {
      profileId: profile.profileId,
      profile,
      diagnostic,
      weight: weightedDiagnostic(diagnostic, policy.diagnosticWeights),
      allocated: policy.minimumCandidatesPerReadyProfile,
      maximum: policy.maximumCandidatesPerReadyProfile,
    };
  });

  const minimumAssigned = working.reduce((sum, row) => sum + row.allocated, 0);
  const unallocated = distributeLargestRemainder(working, policy.totalCandidateBudget - minimumAssigned);
  if (unallocated !== 0) fail("CANDIDATE_BUDGET_DISTRIBUTION_INCOMPLETE", { unallocated });

  const byProfile = new Map(working.map((row) => [row.profileId, row]));
  const allocations = readiness.profiles.map((profile) => {
    const row = byProfile.get(profile.profileId);
    if (!row) {
      return deepFreeze({
        profileId: profile.profileId,
        market: profile.market,
        horizon: profile.horizon,
        timeframe: profile.timeframe,
        directions: profile.directions,
        status: "BLOCKED_MISSING_EVIDENCE",
        allocatedCandidates: 0,
        developmentDiagnostic: null,
      });
    }
    return deepFreeze({
      profileId: profile.profileId,
      market: profile.market,
      horizon: profile.horizon,
      timeframe: profile.timeframe,
      directions: profile.directions,
      status: "ALLOCATED_DEVELOPMENT_ONLY",
      allocatedCandidates: row.allocated,
      allocationWeight: row.weight,
      developmentDiagnostic: row.diagnostic,
    });
  });
  const initialCandidateFamilySize = allocations.reduce((sum, row) => sum + row.allocatedCandidates, 0);
  if (initialCandidateFamilySize !== policy.totalCandidateBudget) {
    fail("INITIAL_CANDIDATE_FAMILY_SIZE_MISMATCH", { initialCandidateFamilySize, expected: policy.totalCandidateBudget });
  }

  return deepFreeze({
    schemaVersion: 1,
    contract: "adaptive-candidate-budget-allocation/v1",
    status: "ALLOCATED",
    policy,
    initialCandidateFamilySize,
    allocations,
    unallocatedCandidates: 0,
    oosFeedbackConsumed: false,
    forwardFeedbackConsumed: false,
    paperFeedbackConsumed: false,
  });
}

export function planAdaptiveSuccessiveHalvingV1({ allocation } = {}) {
  if (!allocation || allocation.contract !== "adaptive-candidate-budget-allocation/v1") {
    fail("ADAPTIVE_ALLOCATION_REQUIRED");
  }
  const policy = allocation.policy;
  const stagePlans = allocation.allocations.map((profile) => {
    let previous = profile.allocatedCandidates;
    const stages = policy.stagePolicy.map((stagePolicy) => {
      const proportional = Math.floor(profile.allocatedCandidates * stagePolicy.retentionRatio);
      const cap = Math.min(previous, stagePolicy.maximumPerProfile, proportional);
      if (cap > previous) fail("SUCCESSIVE_HALVING_CAP_INCREASED", { profileId: profile.profileId, stage: stagePolicy.stage });
      previous = cap;
      return deepFreeze({
        stage: stagePolicy.stage,
        candidateCap: cap,
        retentionRatio: stagePolicy.retentionRatio,
        maximumPerProfile: stagePolicy.maximumPerProfile,
        globalInitialCandidateFamilySize: allocation.initialCandidateFamilySize,
        profileInitialCandidateFamilySize: profile.allocatedCandidates,
        selectionFeedbackAllowed: stagePolicy.stage === "FORMULA_CANDIDATE"
          || stagePolicy.stage === "SANITY_CHECK"
          || stagePolicy.stage === "DEVELOPMENT_BACKTEST"
          || stagePolicy.stage === "DEVELOPMENT_BASE_COST",
      });
    });
    return deepFreeze({
      profileId: profile.profileId,
      market: profile.market,
      horizon: profile.horizon,
      timeframe: profile.timeframe,
      directions: profile.directions,
      allocationStatus: profile.status,
      stages,
    });
  });

  return deepFreeze({
    schemaVersion: 1,
    contract: "adaptive-successive-halving-plan/v1",
    status: allocation.status === "ALLOCATED" ? "PLANNED_NON_ACTIVATING" : "BLOCKED_NO_READY_PROFILES",
    initialCandidateFamilySize: allocation.initialCandidateFamilySize,
    stagePlans,
    finalHoldoutUsedForSelection: false,
    blindOosFeedbackToGeneratorAllowed: false,
    forwardFeedbackToGeneratorAllowed: false,
    paperFeedbackToGeneratorAllowed: false,
    candidateFamilySizeMayBeUnderstated: false,
  });
}

function specialistKey(candidate) {
  return `${candidate.profileId}:${candidate.direction}`;
}

function normalizeParetoCandidate(raw, index) {
  exactKeys(raw, [
    "candidateId",
    "profileId",
    "direction",
    "strategyHash",
    "parameterIdentity",
    "hardGateStatus",
    "statisticalFirewallStatus",
    "metrics",
  ], "PARETO_CANDIDATE_SHAPE_INVALID");
  const candidateId = requiredText(raw.candidateId, "PARETO_CANDIDATE_ID_REQUIRED");
  const profile = PROFILE_BY_ID.get(requiredText(raw.profileId, "PARETO_PROFILE_ID_REQUIRED"));
  if (!profile) fail("PARETO_PROFILE_UNKNOWN", { index, profileId: raw.profileId });
  const direction = requiredText(raw.direction, "PARETO_DIRECTION_REQUIRED").toUpperCase();
  if (!profile.directions.includes(direction)) fail("PARETO_DIRECTION_PROFILE_MISMATCH", { profileId: profile.profileId, direction });
  if (!HASH64.test(raw.strategyHash ?? "")) fail("PARETO_STRATEGY_HASH_INVALID", { candidateId });
  if (!HASH64.test(raw.parameterIdentity ?? "")) fail("PARETO_PARAMETER_IDENTITY_INVALID", { candidateId });
  if (!plainObject(raw.metrics)) fail("PARETO_METRICS_INVALID", { candidateId });

  const missing = [...MAXIMIZE_OBJECTIVES, ...MINIMIZE_OBJECTIVES]
    .filter((metric) => !Number.isFinite(raw.metrics[metric]));
  const unknownMetrics = Object.keys(raw.metrics)
    .filter((metric) => !MAXIMIZE_OBJECTIVES.includes(metric) && !MINIMIZE_OBJECTIVES.includes(metric));
  if (unknownMetrics.length > 0) fail("PARETO_UNKNOWN_METRIC", { candidateId, unknownMetrics: unknownMetrics.sort() });

  const hardGateStatus = requiredText(raw.hardGateStatus, "PARETO_HARD_GATE_STATUS_REQUIRED").toUpperCase();
  const statisticalFirewallStatus = requiredText(
    raw.statisticalFirewallStatus,
    "PARETO_STATISTICAL_STATUS_REQUIRED",
  ).toUpperCase();
  const eligible = hardGateStatus === "PASS" && statisticalFirewallStatus === "PASS" && missing.length === 0;
  const exclusionReason = eligible
    ? null
    : missing.length > 0
      ? "MISSING_EVIDENCE"
      : hardGateStatus !== "PASS"
        ? "HARD_GATE_NOT_PASSED"
        : "STATISTICAL_FIREWALL_NOT_PASSED";

  return deepFreeze({
    candidateId,
    profileId: profile.profileId,
    market: profile.market,
    horizon: profile.horizon,
    timeframe: profile.timeframe,
    direction,
    specialistKey: specialistKey({ profileId: profile.profileId, direction }),
    strategyHash: raw.strategyHash,
    parameterIdentity: raw.parameterIdentity,
    hardGateStatus,
    statisticalFirewallStatus,
    metrics: deepFreeze({ ...raw.metrics }),
    eligible,
    exclusionReason,
    missingMetrics: missing,
  });
}

function dominates(left, right) {
  let strictlyBetter = false;
  for (const metric of MAXIMIZE_OBJECTIVES) {
    if (left.metrics[metric] < right.metrics[metric]) return false;
    if (left.metrics[metric] > right.metrics[metric]) strictlyBetter = true;
  }
  for (const metric of MINIMIZE_OBJECTIVES) {
    if (left.metrics[metric] > right.metrics[metric]) return false;
    if (left.metrics[metric] < right.metrics[metric]) strictlyBetter = true;
  }
  return strictlyBetter;
}

export function buildAdaptiveParetoFrontierV1({ candidates = [], policy: rawPolicy } = {}) {
  if (!Array.isArray(candidates)) fail("PARETO_CANDIDATES_REQUIRED");
  const policy = normalizePolicy(rawPolicy);
  const normalized = candidates.map(normalizeParetoCandidate);
  if (new Set(normalized.map((candidate) => candidate.candidateId)).size !== normalized.length) {
    fail("PARETO_DUPLICATE_CANDIDATE_ID");
  }
  const groups = new Map();
  for (const candidate of normalized) {
    if (!groups.has(candidate.specialistKey)) groups.set(candidate.specialistKey, []);
    groups.get(candidate.specialistKey).push(candidate);
  }

  const specialists = [];
  for (const [key, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const eligible = group.filter((candidate) => candidate.eligible);
    const frontier = eligible.filter((candidate) =>
      !eligible.some((other) => other.candidateId !== candidate.candidateId && dominates(other, candidate)))
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
    const dominated = eligible
      .filter((candidate) => !frontier.some((frontierCandidate) => frontierCandidate.candidateId === candidate.candidateId))
      .map((candidate) => candidate.candidateId)
      .sort();
    const excluded = group
      .filter((candidate) => !candidate.eligible)
      .map((candidate) => deepFreeze({ candidateId: candidate.candidateId, reason: candidate.exclusionReason }))
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
    const requiresTieBreakPolicy = frontier.length > policy.maximumParetoSurvivorsPerSpecialist;
    specialists.push(deepFreeze({
      specialistKey: key,
      status: frontier.length === 0
        ? "NO_CANDIDATE"
        : requiresTieBreakPolicy
          ? "PARETO_FRONTIER_REQUIRES_TIEBREAK_POLICY"
          : "PARETO_FRONTIER_READY_FOR_REVIEW",
      frontier,
      dominatedCandidateIds: dominated,
      excluded,
      maximumParetoSurvivorsPerSpecialist: policy.maximumParetoSurvivorsPerSpecialist,
      automaticChampionSelectionAllowed: false,
      automaticTradingAllowed: false,
      noTradeAllowed: true,
    }));
  }

  return deepFreeze({
    schemaVersion: 1,
    contract: "adaptive-pareto-frontier/v1",
    policyDigest: policy.policyDigest,
    specialists,
    currentValidatedChampion: "NONE",
    profitabilityProven: false,
    promotionAllowed: false,
    tradingAuthority: false,
  });
}

function ownerMap() {
  return deepFreeze({
    candidateGenerationAndBundle: Object.freeze(["#821", "#833"]),
    cryptoSpotPublicRuntime: "#727",
    canonicalBacktester: "#690",
    researchTournament: "#551",
    statisticalFirewall: "#547",
    forwardCanonicalIngest: "#811",
    forwardIndependence: "#813",
    frozenOos: "#802",
    calibration: "#805",
    liquidityImpact: "#809",
    naturalPositionObservation: "#826",
    settlement: "#828",
  });
}

function safetyEnvelope() {
  return deepFreeze({
    planningOnly: true,
    runtimeActivationAllowed: false,
    scheduleMutationAllowed: false,
    deploymentAllowed: false,
    databaseMutationAllowed: false,
    secretMutationAllowed: false,
    environmentMutationAllowed: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
    realOrderCount: 0,
    profitabilityClaimAllowed: false,
    championPromotionAllowed: false,
    finalHoldoutSelectionAllowed: false,
    oosFeedbackToGeneratorAllowed: false,
    forwardFeedbackToGeneratorAllowed: false,
    paperFeedbackToGeneratorAllowed: false,
    missingEvidenceNumericSubstitutionAllowed: false,
    duplicateBacktesterAllowed: false,
    duplicateStatisticalFirewallAllowed: false,
  });
}

export function buildAdaptiveMultiMarketTournamentPlanV1({
  sourceSha,
  createdAt,
  evidenceCatalog,
  developmentDiagnostics,
  policy,
} = {}) {
  if (!SHA40.test(sourceSha ?? "")) fail("ADAPTIVE_SOURCE_SHA_INVALID", { sourceSha });
  if (typeof createdAt !== "string" || !ISO_TIMESTAMP.test(createdAt)) {
    fail("ADAPTIVE_CREATED_AT_INVALID", { createdAt });
  }
  const readiness = assessAdaptiveProfileReadinessV1({ evidenceCatalog });
  const allocation = allocateAdaptiveTournamentBudgetV1({ readiness, developmentDiagnostics, policy });
  const successiveHalving = planAdaptiveSuccessiveHalvingV1({ allocation });
  const owners = ownerMap();
  const safety = safetyEnvelope();
  const localFirstZero = readiness.readyProfileCount === 0
    ? "MARKET_PROFILE_DATA_READINESS_MISSING"
    : "ADAPTIVE_TOURNAMENT_RUNTIME_ADAPTER_NOT_CONNECTED";
  const core = {
    schemaVersion: 1,
    contract: ADAPTIVE_MULTI_MARKET_TOURNAMENT_CONTRACT_V1,
    sourceSha,
    createdAt,
    profiles: ADAPTIVE_MULTI_MARKET_PROFILES_V1,
    readiness,
    allocation,
    successiveHalving,
    owners,
    localFirstZero,
    safety,
  };
  return deepFreeze({ ...core, planDigest: digest(core) });
}

export function verifyAdaptiveMultiMarketTournamentPlanV1(plan) {
  if (!plainObject(plan) || plan.contract !== ADAPTIVE_MULTI_MARKET_TOURNAMENT_CONTRACT_V1) return false;
  if (!HASH64.test(plan.planDigest ?? "") || !SHA40.test(plan.sourceSha ?? "")) return false;
  const core = { ...plan };
  delete core.planDigest;
  if (digest(core) !== plan.planDigest) return false;
  const safety = plan.safety;
  return safety?.planningOnly === true
    && safety.runtimeActivationAllowed === false
    && safety.scheduleMutationAllowed === false
    && safety.deploymentAllowed === false
    && safety.liveTrading === false
    && safety.autoTrading === false
    && safety.realOrderEnabled === false
    && safety.privateTradingApiAllowed === false
    && safety.executionAuthority === "NONE"
    && safety.realOrderCount === 0
    && safety.profitabilityClaimAllowed === false
    && safety.championPromotionAllowed === false
    && safety.finalHoldoutSelectionAllowed === false
    && safety.oosFeedbackToGeneratorAllowed === false
    && safety.forwardFeedbackToGeneratorAllowed === false
    && safety.paperFeedbackToGeneratorAllowed === false
    && safety.missingEvidenceNumericSubstitutionAllowed === false
    && plan.allocation?.oosFeedbackConsumed === false
    && plan.allocation?.forwardFeedbackConsumed === false
    && plan.allocation?.paperFeedbackConsumed === false
    && plan.successiveHalving?.candidateFamilySizeMayBeUnderstated === false;
}

export const ADAPTIVE_PARETO_MAXIMIZE_OBJECTIVES_V1 = MAXIMIZE_OBJECTIVES;
export const ADAPTIVE_PARETO_MINIMIZE_OBJECTIVES_V1 = MINIMIZE_OBJECTIVES;
