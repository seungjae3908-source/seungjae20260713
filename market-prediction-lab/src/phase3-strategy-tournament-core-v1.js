import { createHash } from "node:crypto";

export const PHASE3_TOURNAMENT_SCHEMA_VERSION = 1;

export const PHASE3_SEARCH_STAGES = Object.freeze(["COARSE", "NARROW", "FINE"]);

export const PHASE3_ELIMINATION_REASONS = Object.freeze([
  "BACKTEST_RUNTIME_ERROR",
  "BACKTEST_RESULT_INVALID",
  "BACKTEST_IDENTITY_MISMATCH",
  "CANONICAL_BACKTEST_OWNER_MISMATCH",
  "CANONICAL_BACKTEST_ENGINE_MISMATCH",
  "EXECUTION_EQUIVALENCE_MISSING",
  "TRAIN_DATASET_IDENTITY_MISMATCH",
  "VALIDATION_OR_OOS_LEAKAGE",
  "COST_EVIDENCE_MISSING",
  "COST_POLICY_IDENTITY_MISMATCH",
  "INSUFFICIENT_TRADES",
  "MAXIMUM_DRAWDOWN_EXCEEDED",
  "HARD_FILTER_METRIC_MISSING",
  "RANKING_METRIC_MISSING",
  "NON_FINITE_EVIDENCE",
  "NOT_SELECTED_FOR_NEXT_STAGE",
  "STATISTICAL_FIREWALL_FAIL",
  "STATISTICAL_EVIDENCE_INVALID",
]);

const BACKTEST_METRICS = Object.freeze([
  "grossReturn", "netReturn", "tradeCount", "winRate", "profitFactor", "maxDrawdown", "volatility", "sharpeLike",
]);

const PARAMETER_TYPES = new Set(["number", "integer", "enum", "boolean"]);
const FAMILY_STATUSES = new Set(["ACTIVE", "DISABLED"]);
const SIDES = new Set(["BUY", "SELL", "LONG", "SHORT", "BOTH"]);

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function finiteNumber(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

function canonical(value, path = "value") {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "number") return finiteNumber(value, path);
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item, index) => canonical(item, `${path}[${index}]`));
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], `${path}.${key}`)]));
  }
  throw new TypeError(`${path} must contain JSON-compatible values only`);
}

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (value && typeof value === "object") Object.values(value).forEach(deepFreeze);
  return value && typeof value === "object" ? Object.freeze(value) : value;
}

function snapshot(value, path) {
  return deepFreeze(canonical(value, path));
}

export function phase3DigestV1(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function uniqueSortedText(values, name) {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError(`${name} must be a non-empty array`);
  const normalized = values.map((value, index) => requiredText(value, `${name}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${name} contains duplicates`);
  return Object.freeze([...normalized].sort());
}

function normalizeNumericSpec(raw, name, type) {
  const minimum = finiteNumber(raw.minimum, `${name}.minimum`);
  const maximum = finiteNumber(raw.maximum, `${name}.maximum`);
  const step = finiteNumber(raw.step, `${name}.step`);
  const defaultValue = finiteNumber(raw.default, `${name}.default`);
  if (minimum > maximum || step <= 0 || defaultValue < minimum || defaultValue > maximum) {
    throw new RangeError(`${name} has invalid numeric bounds`);
  }
  if (type === "integer" && ![minimum, maximum, step, defaultValue].every(Number.isSafeInteger)) {
    throw new TypeError(`${name} integer values must be safe integers`);
  }
  const validateResolution = (value, field) => {
    if (value === undefined) return null;
    const normalized = finiteNumber(value, `${name}.${field}`);
    if (normalized < step || (type === "integer" && !Number.isSafeInteger(normalized))) {
      throw new RangeError(`${name}.${field} must respect the declared step`);
    }
    return normalized;
  };
  const coarseValues = raw.coarseValues ?? [defaultValue];
  if (!Array.isArray(coarseValues) || coarseValues.length === 0) throw new TypeError(`${name}.coarseValues must be non-empty`);
  const normalizedCoarse = [...new Set(coarseValues.map((value, index) => {
    const normalized = finiteNumber(value, `${name}.coarseValues[${index}]`);
    if (normalized < minimum || normalized > maximum || (type === "integer" && !Number.isSafeInteger(normalized))) {
      throw new RangeError(`${name}.coarseValues[${index}] is out of bounds`);
    }
    return normalized;
  }))].sort((left, right) => left - right);
  return Object.freeze({
    type,
    minimum,
    maximum,
    step,
    default: defaultValue,
    coarseValues: Object.freeze(normalizedCoarse),
    narrowStep: validateResolution(raw.narrowStep, "narrowStep"),
    fineStep: validateResolution(raw.fineStep, "fineStep"),
  });
}

function normalizeParameterSpec(raw, name) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  const type = requiredText(raw.type, `${name}.type`);
  if (!PARAMETER_TYPES.has(type)) throw new Error(`${name}.type is unsupported`);
  if (type === "number" || type === "integer") return normalizeNumericSpec(raw, name, type);
  if (type === "enum") {
    const values = uniqueSortedText(raw.values, `${name}.values`);
    const defaultValue = requiredText(raw.default, `${name}.default`);
    if (!values.includes(defaultValue)) throw new Error(`${name}.default must be declared in values`);
    const coarseValues = raw.coarseValues === undefined
      ? values
      : uniqueSortedText(raw.coarseValues, `${name}.coarseValues`);
    if (coarseValues.some((value) => !values.includes(value))) throw new Error(`${name}.coarseValues contains an unsupported value`);
    return Object.freeze({ type, values, default: defaultValue, coarseValues });
  }
  if (typeof raw.default !== "boolean") throw new TypeError(`${name}.default must be boolean`);
  const coarseValues = raw.coarseValues ?? [raw.default];
  if (!Array.isArray(coarseValues) || coarseValues.length === 0 || coarseValues.some((value) => typeof value !== "boolean")) {
    throw new TypeError(`${name}.coarseValues must contain booleans`);
  }
  return Object.freeze({ type, default: raw.default, coarseValues: Object.freeze([...new Set(coarseValues)].sort()) });
}

function normalizeConstraint(raw, name, parameterNames) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  const left = requiredText(raw.left, `${name}.left`);
  const operator = requiredText(raw.operator, `${name}.operator`);
  if (!parameterNames.has(left)) throw new Error(`${name}.left is unknown`);
  if (!["LT", "LTE", "GT", "GTE", "EQ", "NEQ"].includes(operator)) throw new Error(`${name}.operator is unsupported`);
  const rightParameter = raw.rightParameter === undefined ? null : requiredText(raw.rightParameter, `${name}.rightParameter`);
  if (rightParameter !== null && !parameterNames.has(rightParameter)) throw new Error(`${name}.rightParameter is unknown`);
  if (rightParameter === null && raw.rightValue === undefined) throw new Error(`${name} requires rightParameter or rightValue`);
  return snapshot({ left, operator, rightParameter, rightValue: rightParameter === null ? raw.rightValue : null }, name);
}

function normalizeFamily(raw, index) {
  const name = `families[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  const strategyFamilyId = requiredText(raw.strategyFamilyId, `${name}.strategyFamilyId`);
  const strategyVersion = requiredText(raw.strategyVersion, `${name}.strategyVersion`);
  const sourceContract = requiredText(raw.sourceContract, `${name}.sourceContract`);
  const sourceIdentity = requiredText(raw.sourceIdentity, `${name}.sourceIdentity`);
  const marketType = requiredText(raw.marketType, `${name}.marketType`);
  const allowedSides = uniqueSortedText(raw.allowedSides ?? [raw.allowedSide], `${name}.allowedSides`);
  if (allowedSides.some((side) => !SIDES.has(side))) throw new Error(`${name}.allowedSides contains an unsupported side`);
  const supportedTimeframes = uniqueSortedText(raw.supportedTimeframes, `${name}.supportedTimeframes`);
  if (!raw.parameterSchema || typeof raw.parameterSchema !== "object" || Array.isArray(raw.parameterSchema)) {
    throw new TypeError(`${name}.parameterSchema must be an object`);
  }
  const parameterSchema = Object.fromEntries(Object.keys(raw.parameterSchema).sort().map((parameterName) => [
    parameterName,
    normalizeParameterSpec(raw.parameterSchema[parameterName], `${name}.parameterSchema.${parameterName}`),
  ]));
  if (Object.keys(parameterSchema).length === 0) throw new Error(`${name}.parameterSchema must not be empty`);
  const parameterNames = new Set(Object.keys(parameterSchema));
  const constraints = Object.freeze((raw.constraints ?? []).map((constraint, constraintIndex) => (
    normalizeConstraint(constraint, `${name}.constraints[${constraintIndex}]`, parameterNames)
  )));
  const requiredIndicators = uniqueSortedText(raw.requiredIndicators, `${name}.requiredIndicators`);
  const minimumWarmup = positiveInteger(raw.minimumWarmup, `${name}.minimumWarmup`);
  const compatibility = raw.backtestCompatibility;
  if (!compatibility || typeof compatibility !== "object" || Array.isArray(compatibility)) {
    throw new TypeError(`${name}.backtestCompatibility is required`);
  }
  const backtestCompatibility = Object.freeze({
    owner: requiredText(compatibility.owner, `${name}.backtestCompatibility.owner`),
    engine: requiredText(compatibility.engine, `${name}.backtestCompatibility.engine`),
    executionEquivalentRequired: compatibility.executionEquivalentRequired === true,
  });
  if (!backtestCompatibility.executionEquivalentRequired) throw new Error(`${name} must require execution equivalence`);
  const status = requiredText(raw.status, `${name}.status`);
  if (!FAMILY_STATUSES.has(status)) throw new Error(`${name}.status is unsupported`);
  return deepFreeze({
    strategyFamilyId,
    strategyVersion,
    sourceContract,
    sourceIdentity,
    marketType,
    allowedSides,
    supportedTimeframes,
    parameterSchema: Object.freeze(parameterSchema),
    constraints,
    requiredIndicators,
    minimumWarmup,
    backtestCompatibility,
    status,
  });
}

export function buildPhase3StrategyFamilyRegistryV1(families) {
  if (!Array.isArray(families) || families.length === 0) throw new TypeError("families must be a non-empty array");
  const normalized = families.map(normalizeFamily).sort((left, right) => left.strategyFamilyId.localeCompare(right.strategyFamilyId));
  const identities = normalized.map((family) => `${family.strategyFamilyId}@${family.strategyVersion}`);
  if (new Set(identities).size !== identities.length) throw new Error("strategy family identity is duplicated");
  const body = Object.freeze({ schemaVersion: 1, families: Object.freeze(normalized) });
  return Object.freeze({ ...body, registryDigest: phase3DigestV1(body) });
}

function normalizeUniverse(rawUniverse) {
  if (!Array.isArray(rawUniverse) || rawUniverse.length === 0) throw new TypeError("universe must be a non-empty array");
  const result = rawUniverse.map((raw, index) => {
    const name = `universe[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
    const datasetRole = requiredText(raw.datasetRole, `${name}.datasetRole`);
    if (datasetRole !== "TRAIN") throw new Error("VALIDATION_OR_OOS_LEAKAGE");
    return snapshot({
      marketType: requiredText(raw.marketType, `${name}.marketType`),
      market: requiredText(raw.market, `${name}.market`),
      symbol: requiredText(raw.symbol, `${name}.symbol`),
      timeframe: requiredText(raw.timeframe, `${name}.timeframe`),
      side: requiredText(raw.side, `${name}.side`),
      datasetRole,
      datasetIdentity: requiredText(raw.datasetIdentity, `${name}.datasetIdentity`),
      datasetDigest: requiredText(raw.datasetDigest, `${name}.datasetDigest`),
      sourceFrameIdentity: requiredText(raw.sourceFrameIdentity, `${name}.sourceFrameIdentity`),
      eventWindow: requiredText(raw.eventWindow, `${name}.eventWindow`),
    }, name);
  });
  if (result.some((item) => !SIDES.has(item.side) || item.side === "BOTH")) throw new Error("universe side must be BUY or SELL");
  return Object.freeze(result.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function constraintPasses(parameters, constraint) {
  const left = parameters[constraint.left];
  const right = constraint.rightParameter === null ? constraint.rightValue : parameters[constraint.rightParameter];
  if (constraint.operator === "LT") return left < right;
  if (constraint.operator === "LTE") return left <= right;
  if (constraint.operator === "GT") return left > right;
  if (constraint.operator === "GTE") return left >= right;
  if (constraint.operator === "EQ") return left === right;
  return left !== right;
}

function parameterValueIsValid(value, spec) {
  if (spec.type === "number") return Number.isFinite(value) && value >= spec.minimum && value <= spec.maximum;
  if (spec.type === "integer") return Number.isSafeInteger(value) && value >= spec.minimum && value <= spec.maximum;
  if (spec.type === "enum") return typeof value === "string" && spec.values.includes(value);
  return typeof value === "boolean";
}

function parametersAreValid(parameters, family) {
  const names = Object.keys(family.parameterSchema);
  if (Object.keys(parameters).sort().join("\u0000") !== names.join("\u0000")) return false;
  if (names.some((name) => !parameterValueIsValid(parameters[name], family.parameterSchema[name]))) return false;
  return family.constraints.every((constraint) => constraintPasses(parameters, constraint));
}

export function createPhase3CandidateIdentityV1({ family, universeEntry, parameters }) {
  if (!parametersAreValid(parameters, family)) throw new Error("candidate parameters violate the family contract");
  const normalizedParameters = snapshot(parameters, "parameters");
  const parameterDigest = phase3DigestV1({
    strategyFamilyId: family.strategyFamilyId,
    strategyVersion: family.strategyVersion,
    parameters: normalizedParameters,
  });
  const identity = snapshot({
    strategyFamilyId: family.strategyFamilyId,
    strategyVersion: family.strategyVersion,
    parameterDigest,
    parameters: normalizedParameters,
    marketType: universeEntry.marketType,
    market: universeEntry.market,
    symbol: universeEntry.symbol,
    timeframe: universeEntry.timeframe,
    side: universeEntry.side,
    datasetIdentity: universeEntry.datasetIdentity,
    datasetDigest: universeEntry.datasetDigest,
    sourceFrameIdentity: universeEntry.sourceFrameIdentity,
    eventWindow: universeEntry.eventWindow,
  }, "candidateIdentity");
  return Object.freeze({ ...identity, candidateId: `phase3-candidate:sha256:${phase3DigestV1(identity)}` });
}

function cartesian(axes, cap) {
  let combinations = [{}];
  for (const [name, values] of axes) {
    const next = [];
    for (const combination of combinations) {
      for (const value of values) {
        next.push({ ...combination, [name]: value });
        if (next.length > cap) throw new Error("SEARCH_BUDGET_EXCEEDED");
      }
    }
    combinations = next;
  }
  return combinations;
}

function activeFamilySupports(family, universeEntry) {
  const sideSupported = family.allowedSides.includes("BOTH") || family.allowedSides.includes(universeEntry.side);
  return family.status === "ACTIVE"
    && family.marketType === universeEntry.marketType
    && sideSupported
    && family.supportedTimeframes.includes(universeEntry.timeframe);
}

function coarseCandidates(family, universeEntry, cap) {
  const axes = Object.entries(family.parameterSchema).map(([name, spec]) => [name, spec.coarseValues]);
  return cartesian(axes, cap)
    .filter((parameters) => parametersAreValid(parameters, family))
    .map((parameters) => createPhase3CandidateIdentityV1({ family, universeEntry, parameters }));
}

function neighborCandidates(seed, family, universeEntry, stage) {
  const candidates = [];
  for (const [name, spec] of Object.entries(family.parameterSchema)) {
    const resolution = stage === "NARROW" ? spec.narrowStep : spec.fineStep;
    if ((spec.type !== "number" && spec.type !== "integer") || resolution === null) continue;
    for (const direction of [-1, 1]) {
      const raw = seed.parameters[name] + (direction * resolution);
      const value = spec.type === "integer" ? Math.round(raw) : Number(raw.toPrecision(15));
      const parameters = { ...seed.parameters, [name]: value };
      if (parametersAreValid(parameters, family)) {
        candidates.push(createPhase3CandidateIdentityV1({ family, universeEntry, parameters }));
      }
    }
  }
  return candidates;
}

function normalizePolicies(raw) {
  if (!raw || typeof raw !== "object") return null;
  const search = raw.search;
  const hardFilter = raw.hardFilter;
  const ranking = raw.ranking;
  const statistical = raw.statistical;
  const cost = raw.cost;
  if (![search, hardFilter, ranking, statistical, cost].every((policy) => policy && typeof policy === "object" && !Array.isArray(policy))) {
    return null;
  }
  const normalizedSearch = Object.freeze({
    version: requiredText(search.version, "policies.search.version"),
    seed: positiveInteger(search.seed, "policies.search.seed", 0xffff_ffff),
    maxCandidatesPerFamily: positiveInteger(search.maxCandidatesPerFamily, "maxCandidatesPerFamily", 10_000),
    maxTotalCandidates: positiveInteger(search.maxTotalCandidates, "maxTotalCandidates", 100_000),
    coarseSurvivorsPerFamily: positiveInteger(search.coarseSurvivorsPerFamily, "coarseSurvivorsPerFamily", 1_000),
    narrowSurvivorsPerFamily: positiveInteger(search.narrowSurvivorsPerFamily, "narrowSurvivorsPerFamily", 1_000),
    fineSurvivorsPerFamily: positiveInteger(search.fineSurvivorsPerFamily, "fineSurvivorsPerFamily", 1_000),
  });
  const requiredMetrics = uniqueSortedText(hardFilter.requiredMetrics, "policies.hardFilter.requiredMetrics");
  const normalizedHardFilter = Object.freeze({
    version: requiredText(hardFilter.version, "policies.hardFilter.version"),
    minimumTrades: positiveInteger(hardFilter.minimumTrades, "policies.hardFilter.minimumTrades"),
    maximumDrawdown: finiteNumber(hardFilter.maximumDrawdown, "policies.hardFilter.maximumDrawdown"),
    requiredMetrics,
  });
  if (normalizedHardFilter.maximumDrawdown < 0) throw new RangeError("maximumDrawdown must be non-negative");
  if (!Array.isArray(ranking.components) || ranking.components.length === 0) throw new TypeError("ranking.components must be non-empty");
  const components = ranking.components.map((component, index) => {
    const name = `policies.ranking.components[${index}]`;
    const minimum = finiteNumber(component.minimum, `${name}.minimum`);
    const maximum = finiteNumber(component.maximum, `${name}.maximum`);
    const weight = finiteNumber(component.weight, `${name}.weight`);
    const direction = requiredText(component.direction, `${name}.direction`);
    if (minimum >= maximum || weight <= 0 || !["ASC", "DESC"].includes(direction)) throw new Error(`${name} is invalid`);
    return Object.freeze({ metric: requiredText(component.metric, `${name}.metric`), direction, weight, minimum, maximum });
  });
  if (new Set(components.map((component) => component.metric)).size !== components.length) throw new Error("ranking metrics must be unique");
  const normalizedRanking = Object.freeze({ version: requiredText(ranking.version, "policies.ranking.version"), components: Object.freeze(components) });
  const normalizedStatistical = snapshot({ ...statistical, version: requiredText(statistical.version, "policies.statistical.version") }, "policies.statistical");
  const normalizedCost = snapshot({ ...cost, version: requiredText(cost.version, "policies.cost.version") }, "policies.cost");
  return deepFreeze({
    search: normalizedSearch,
    hardFilter: normalizedHardFilter,
    ranking: normalizedRanking,
    statistical: normalizedStatistical,
    cost: normalizedCost,
    digests: {
      search: phase3DigestV1(normalizedSearch),
      hardFilter: phase3DigestV1(normalizedHardFilter),
      ranking: phase3DigestV1(normalizedRanking),
      statistical: phase3DigestV1(normalizedStatistical),
      cost: phase3DigestV1(normalizedCost),
    },
  });
}

function finiteMetricOrNull(metrics, metric) {
  const value = metrics[metric];
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return "NON_FINITE";
  return Object.is(value, -0) ? 0 : value;
}

function validateBacktestResult(result, candidate, family, policies) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return { reason: "BACKTEST_RESULT_INVALID" };
  if (result.candidateId !== candidate.candidateId
    || result.strategyFamily !== candidate.strategyFamilyId
    || result.parameterDigest !== candidate.parameterDigest) return { reason: "BACKTEST_IDENTITY_MISMATCH" };
  if (result.split !== "TRAIN" || result.datasetRole !== "TRAIN") return { reason: "VALIDATION_OR_OOS_LEAKAGE" };
  if (result.datasetIdentity !== candidate.datasetIdentity || result.datasetDigest !== candidate.datasetDigest) {
    return { reason: "TRAIN_DATASET_IDENTITY_MISMATCH" };
  }
  if (result.canonicalBacktestOwner !== family.backtestCompatibility.owner) return { reason: "CANONICAL_BACKTEST_OWNER_MISMATCH" };
  if (result.executionEngine !== family.backtestCompatibility.engine) return { reason: "CANONICAL_BACKTEST_ENGINE_MISMATCH" };
  if (result.executionEquivalent !== true) return { reason: "EXECUTION_EQUIVALENCE_MISSING" };
  if (result.leakageChecks?.futureCandleLeakage !== false
    || result.leakageChecks?.validationOutcomeLeakage !== false
    || result.leakageChecks?.oosOutcomeLeakage !== false
    || result.leakageChecks?.settlementOutcomeLeakage !== false) return { reason: "VALIDATION_OR_OOS_LEAKAGE" };
  if (typeof result.backtestVersion !== "string" || !result.backtestVersion.trim()) return { reason: "BACKTEST_RESULT_INVALID" };
  if (result.costPolicyDigest === null || result.costPolicyDigest === undefined) return { reason: "COST_EVIDENCE_MISSING" };
  if (result.costPolicyDigest !== policies.digests.cost) return { reason: "COST_POLICY_IDENTITY_MISMATCH" };
  try {
    if (phase3DigestV1(result.costPolicy) !== policies.digests.cost) return { reason: "COST_POLICY_IDENTITY_MISMATCH" };
  } catch {
    return { reason: "COST_EVIDENCE_MISSING" };
  }
  if (!result.metrics || typeof result.metrics !== "object" || Array.isArray(result.metrics)) return { reason: "BACKTEST_RESULT_INVALID" };
  let metrics;
  try {
    metrics = snapshot(Object.fromEntries(BACKTEST_METRICS.map((metric) => {
      const value = finiteMetricOrNull(result.metrics, metric);
      if (value === "NON_FINITE") throw new TypeError(`${metric} is non-finite`);
      return [metric, value];
    })), "backtest.metrics");
  }
  catch { return { reason: "NON_FINITE_EVIDENCE" }; }
  return { result: snapshot({ ...result, metrics }, "backtestResult") };
}

function applyHardFilter(result, policy) {
  for (const metric of policy.requiredMetrics) {
    const value = finiteMetricOrNull(result.metrics, metric);
    if (value === "NON_FINITE") return "NON_FINITE_EVIDENCE";
    if (value === null) return "HARD_FILTER_METRIC_MISSING";
  }
  const trades = finiteMetricOrNull(result.metrics, "tradeCount");
  if (trades === "NON_FINITE") return "NON_FINITE_EVIDENCE";
  if (trades === null) return "HARD_FILTER_METRIC_MISSING";
  if (!Number.isSafeInteger(trades) || trades < policy.minimumTrades) return "INSUFFICIENT_TRADES";
  const drawdown = finiteMetricOrNull(result.metrics, "maxDrawdown");
  if (drawdown === "NON_FINITE") return "NON_FINITE_EVIDENCE";
  if (drawdown === null || drawdown < 0) return "HARD_FILTER_METRIC_MISSING";
  if (drawdown > policy.maximumDrawdown) return "MAXIMUM_DRAWDOWN_EXCEEDED";
  return null;
}

function scoreResult(result, policy) {
  const scoreComponents = [];
  let weightedScore = 0;
  let totalWeight = 0;
  for (const component of policy.components) {
    const value = finiteMetricOrNull(result.metrics, component.metric);
    if (value === "NON_FINITE") return { reason: "NON_FINITE_EVIDENCE" };
    if (value === null) return { reason: "RANKING_METRIC_MISSING" };
    const unit = Math.max(0, Math.min(1, (value - component.minimum) / (component.maximum - component.minimum)));
    const directional = component.direction === "DESC" ? unit : 1 - unit;
    const contribution = directional * component.weight;
    scoreComponents.push({ ...component, value, normalizedValue: directional, contribution });
    weightedScore += contribution;
    totalWeight += component.weight;
  }
  const score = weightedScore / totalWeight;
  return { score, scoreComponents: Object.freeze(scoreComponents), scoreDigest: phase3DigestV1({ score, scoreComponents }) };
}

function safetyEnvelope() {
  return Object.freeze({
    LIVE_TRADING: false,
    AUTO_TRADING: false,
    REAL_ORDER_ENABLED: false,
    PRIVATE_TRADING_API_ALLOWED: false,
    executionAuthority: "NONE",
    productionDeployAllowed: false,
    stagingDeployAllowed: false,
    scheduleActivationAllowed: false,
    databaseMutationAllowed: false,
    secretMutationAllowed: false,
    environmentMutationAllowed: false,
    serverMutationAllowed: false,
    replayAllowed: false,
    backfillAllowed: false,
    economicCreditCreated: false,
  });
}

function blockedResult({ reason, codeSha, registry = null, policies = null }) {
  return deepFreeze({
    schemaVersion: PHASE3_TOURNAMENT_SCHEMA_VERSION,
    status: "BLOCKED",
    FIRST_ZERO: reason,
    codeSha: codeSha ?? null,
    registryDigest: registry?.registryDigest ?? null,
    policyDigests: policies?.digests ?? null,
    finalists: [],
    PROFITABILITY_PROVEN: false,
    NET_ALPHA_PROVEN: false,
    CHAMPION: "NONE",
    safety: safetyEnvelope(),
  });
}

function familyForCandidate(registry, candidate) {
  return registry.families.find((family) => family.strategyFamilyId === candidate.strategyFamilyId && family.strategyVersion === candidate.strategyVersion);
}

function universeForCandidate(universe, candidate) {
  return universe.find((entry) => entry.datasetIdentity === candidate.datasetIdentity
    && entry.datasetDigest === candidate.datasetDigest
    && entry.market === candidate.market
    && entry.symbol === candidate.symbol
    && entry.timeframe === candidate.timeframe
    && entry.side === candidate.side);
}

async function evaluateCandidates({ candidates, stage, registry, policies, runCanonicalBacktest, eliminated, evaluated }) {
  const passed = [];
  for (const candidate of candidates.sort((left, right) => left.candidateId.localeCompare(right.candidateId))) {
    if (evaluated.has(candidate.candidateId)) continue;
    const family = familyForCandidate(registry, candidate);
    let rawResult;
    try {
      rawResult = await runCanonicalBacktest(Object.freeze({
        schemaVersion: 1,
        stage,
        candidate,
        dataset: Object.freeze({
          role: "TRAIN",
          identity: candidate.datasetIdentity,
          digest: candidate.datasetDigest,
          sourceFrameIdentity: candidate.sourceFrameIdentity,
          eventWindow: candidate.eventWindow,
        }),
        costPolicy: policies.cost,
        costPolicyDigest: policies.digests.cost,
        validationDataAllowed: false,
        oosDataAllowed: false,
        finalHoldoutAllowed: false,
      }));
    } catch (error) {
      const record = snapshot({ candidateId: candidate.candidateId, stage, reason: "BACKTEST_RUNTIME_ERROR", error: error instanceof Error ? error.message : String(error) });
      eliminated.push(record);
      evaluated.set(candidate.candidateId, { candidate, stage, reason: record.reason });
      continue;
    }
    const validation = validateBacktestResult(rawResult, candidate, family, policies);
    if (validation.reason) {
      const record = snapshot({ candidateId: candidate.candidateId, stage, reason: validation.reason });
      eliminated.push(record);
      evaluated.set(candidate.candidateId, { candidate, stage, reason: record.reason });
      continue;
    }
    const hardFilterReason = applyHardFilter(validation.result, policies.hardFilter);
    if (hardFilterReason) {
      const record = snapshot({ candidateId: candidate.candidateId, stage, reason: hardFilterReason });
      eliminated.push(record);
      evaluated.set(candidate.candidateId, { candidate, stage, result: validation.result, reason: record.reason });
      continue;
    }
    const score = scoreResult(validation.result, policies.ranking);
    if (score.reason) {
      const record = snapshot({ candidateId: candidate.candidateId, stage, reason: score.reason });
      eliminated.push(record);
      evaluated.set(candidate.candidateId, { candidate, stage, result: validation.result, reason: record.reason });
      continue;
    }
    const evaluation = deepFreeze({ candidate, stage, result: validation.result, ...score });
    passed.push(evaluation);
    evaluated.set(candidate.candidateId, evaluation);
  }
  return passed;
}

function rankAndSelect({ eligible, maximum, stage, eliminated }) {
  const ranked = [...eligible].sort((left, right) => right.score - left.score || left.candidate.candidateId.localeCompare(right.candidate.candidateId));
  for (const rejected of ranked.slice(maximum)) {
    eliminated.push(snapshot({ candidateId: rejected.candidate.candidateId, stage, reason: "NOT_SELECTED_FOR_NEXT_STAGE" }));
  }
  return Object.freeze(ranked.slice(0, maximum));
}

export async function runPhase3StrategyTournamentCoreV1(input, dependencies = {}) {
  const codeSha = input?.codeSha === undefined ? null : requiredText(input.codeSha, "codeSha");
  if (input?.validationEvidence !== undefined || input?.oosEvidence !== undefined || input?.finalHoldoutEvidence !== undefined) {
    return blockedResult({ reason: "VALIDATION_OR_OOS_LEAKAGE", codeSha });
  }
  let registry;
  let universe;
  let policies;
  try {
    registry = buildPhase3StrategyFamilyRegistryV1(input?.families);
    universe = normalizeUniverse(input?.universe);
  } catch (error) {
    if (error instanceof Error && error.message === "VALIDATION_OR_OOS_LEAKAGE") {
      return blockedResult({ reason: "VALIDATION_OR_OOS_LEAKAGE", codeSha, registry });
    }
    return blockedResult({ reason: "INPUT_CONTRACT_INVALID", codeSha, registry });
  }
  try { policies = normalizePolicies(input?.policies); }
  catch { return blockedResult({ reason: "POLICY_INVALID", codeSha, registry }); }
  if (policies === null) return blockedResult({ reason: "POLICY_MISSING", codeSha, registry });
  if (typeof dependencies.runCanonicalBacktest !== "function") {
    return blockedResult({ reason: "CANONICAL_BACKTEST_CALLBACK_MISSING", codeSha, registry, policies });
  }
  if (typeof dependencies.evaluateStatisticalFirewall !== "function") {
    return blockedResult({ reason: "STATISTICAL_POLICY_MISSING", codeSha, registry, policies });
  }

  const discovered = [];
  const seen = new Set();
  let generationAttempts = 0;
  for (const family of registry.families) {
    for (const entry of universe) {
      if (!activeFamilySupports(family, entry)) continue;
      for (const candidate of coarseCandidates(family, entry, policies.search.maxCandidatesPerFamily)) {
        generationAttempts += 1;
        if (!seen.has(candidate.candidateId)) {
          seen.add(candidate.candidateId);
          discovered.push(candidate);
        }
      }
    }
  }
  if (discovered.length === 0) return blockedResult({ reason: "UNSUPPORTED_COMBINATION", codeSha, registry, policies });
  if (discovered.length > policies.search.maxTotalCandidates) throw new Error("SEARCH_BUDGET_EXCEEDED");
  const candidateUniverseDigest = phase3DigestV1(discovered.map((candidate) => candidate.candidateId).sort());
  const tournamentRunId = `phase3-tournament:sha256:${phase3DigestV1({
    codeSha,
    registryDigest: registry.registryDigest,
    candidateUniverseDigest,
    datasetDigests: universe.map((entry) => entry.datasetDigest),
    policyDigests: policies.digests,
  })}`;
  const eliminated = [];
  const evaluated = new Map();
  const stageCounts = {};
  let stagePool = [];

  const coarsePassed = await evaluateCandidates({ candidates: discovered, stage: "COARSE", registry, policies, runCanonicalBacktest: dependencies.runCanonicalBacktest, eliminated, evaluated });
  stagePool = [];
  for (const family of registry.families) {
    const familyPassed = coarsePassed.filter((evaluation) => evaluation.candidate.strategyFamilyId === family.strategyFamilyId);
    stagePool.push(...rankAndSelect({ eligible: familyPassed, maximum: policies.search.coarseSurvivorsPerFamily, stage: "COARSE", eliminated }));
  }
  stageCounts.COARSE = Object.freeze({ generated: discovered.length, passedHardFilter: coarsePassed.length, selected: stagePool.length });

  for (const stage of ["NARROW", "FINE"]) {
    const generated = [];
    for (const seed of stagePool) {
      const family = familyForCandidate(registry, seed.candidate);
      const entry = universeForCandidate(universe, seed.candidate);
      for (const candidate of neighborCandidates(seed.candidate, family, entry, stage)) {
        generationAttempts += 1;
        if (!seen.has(candidate.candidateId)) {
          seen.add(candidate.candidateId);
          generated.push(candidate);
        }
      }
    }
    if (seen.size > policies.search.maxTotalCandidates) throw new Error("SEARCH_BUDGET_EXCEEDED");
    const newlyPassed = await evaluateCandidates({ candidates: generated, stage, registry, policies, runCanonicalBacktest: dependencies.runCanonicalBacktest, eliminated, evaluated });
    const eligible = [...stagePool, ...newlyPassed];
    const nextPool = [];
    const maximumField = stage === "NARROW" ? "narrowSurvivorsPerFamily" : "fineSurvivorsPerFamily";
    for (const family of registry.families) {
      const familyEligible = eligible.filter((evaluation) => evaluation.candidate.strategyFamilyId === family.strategyFamilyId);
      nextPool.push(...rankAndSelect({ eligible: familyEligible, maximum: policies.search[maximumField], stage, eliminated }));
    }
    stagePool = nextPool;
    stageCounts[stage] = Object.freeze({ generated: generated.length, passedHardFilter: newlyPassed.length, selected: stagePool.length });
  }

  const finalistEvaluations = [];
  for (const evaluation of [...stagePool]
    .sort((left, right) => right.score - left.score || left.candidate.candidateId.localeCompare(right.candidate.candidateId))) {
    let firewall;
    try {
      firewall = await dependencies.evaluateStatisticalFirewall(Object.freeze({
        tournamentRunId,
        candidate: evaluation.candidate,
        trainBacktestResult: evaluation.result,
        statisticalPolicy: policies.statistical,
        statisticalPolicyDigest: policies.digests.statistical,
        candidateFamilySize: evaluated.size,
        validationEvidenceAllowed: false,
        oosEvidenceAllowed: false,
      }));
    } catch (error) {
      eliminated.push(snapshot({ candidateId: evaluation.candidate.candidateId, stage: "STATISTICAL_FIREWALL", reason: "STATISTICAL_EVIDENCE_INVALID", error: error instanceof Error ? error.message : String(error) }));
      continue;
    }
    let normalizedFirewall;
    try { normalizedFirewall = snapshot(firewall, "statisticalFirewall"); }
    catch {
      eliminated.push(snapshot({ candidateId: evaluation.candidate.candidateId, stage: "STATISTICAL_FIREWALL", reason: "NON_FINITE_EVIDENCE" }));
      continue;
    }
    if (!normalizedFirewall
      || normalizedFirewall.status !== "PASS"
      || normalizedFirewall.policyDigest !== policies.digests.statistical
      || normalizedFirewall.selectionBiasRecorded !== true
      || normalizedFirewall.candidateFamilySize !== evaluated.size) {
      eliminated.push(snapshot({ candidateId: evaluation.candidate.candidateId, stage: "STATISTICAL_FIREWALL", reason: normalizedFirewall?.status === "FAIL" ? "STATISTICAL_FIREWALL_FAIL" : "STATISTICAL_EVIDENCE_INVALID" }));
      continue;
    }
    finalistEvaluations.push({ evaluation, statisticalFirewall: normalizedFirewall });
  }
  const finalists = finalistEvaluations.map(({ evaluation, statisticalFirewall }, index) => deepFreeze({
      schemaVersion: 1,
      candidateId: evaluation.candidate.candidateId,
      strategyFamilyId: evaluation.candidate.strategyFamilyId,
      strategyVersion: evaluation.candidate.strategyVersion,
      parameterDigest: evaluation.candidate.parameterDigest,
      parameters: evaluation.candidate.parameters,
      rankingVersion: policies.ranking.version,
      rank: index + 1,
      score: evaluation.score,
      scoreComponents: evaluation.scoreComponents,
      scoreDigest: evaluation.scoreDigest,
      selectionReason: "PASSED_TRAIN_HARD_FILTER_RANKING_AND_STATISTICAL_FIREWALL",
      datasetIdentity: evaluation.candidate.datasetIdentity,
      datasetDigest: evaluation.candidate.datasetDigest,
      searchPolicyDigest: policies.digests.search,
      hardFilterPolicyDigest: policies.digests.hardFilter,
      rankingPolicyDigest: policies.digests.ranking,
      statisticalPolicyDigest: policies.digests.statistical,
      costPolicyDigest: policies.digests.cost,
      tournamentRunId,
      evidenceRole: "ALPHA_CANDIDATE_ONLY",
      PROFITABILITY_PROVEN: false,
      NET_ALPHA_PROVEN: false,
      CHAMPION: "NONE",
      phase4CandidateFreezePerformed: false,
      parameterMutationAllowed: false,
      statisticalFirewall,
    }));

  const reasonCounts = Object.fromEntries(PHASE3_ELIMINATION_REASONS.map((reason) => [
    reason,
    eliminated.filter((record) => record.reason === reason).length,
  ]));
  const alphaCandidateEvidence = finalistEvaluations.map(({ evaluation, statisticalFirewall }) => deepFreeze({
    evidenceRole: "ALPHA_CANDIDATE_ONLY",
    candidateId: evaluation.candidate.candidateId,
    strategyFamilyId: evaluation.candidate.strategyFamilyId,
    parameterDigest: evaluation.candidate.parameterDigest,
    searchStage: evaluation.stage,
    trainBacktestResult: evaluation.result,
    ranking: {
      rankingVersion: policies.ranking.version,
      score: evaluation.score,
      scoreComponents: evaluation.scoreComponents,
      scoreDigest: evaluation.scoreDigest,
    },
    statisticalFirewall,
    tournamentRunId,
  }));
  const observability = Object.freeze({
    DISCOVERY_STATUS: discovered.length > 0 ? "COMPLETE" : "NO_COMPATIBLE_FAMILIES",
    TOTAL_GENERATED: generationAttempts,
    TOTAL_DEDUPED: generationAttempts - seen.size,
    TOTAL_EVALUATED: evaluated.size,
    TOTAL_FAILED: eliminated.filter((record) => record.reason !== "NOT_SELECTED_FOR_NEXT_STAGE").length,
    TOTAL_ELIMINATED: eliminated.length,
    TOTAL_SURVIVED: stagePool.length,
    COARSE_SURVIVORS: stageCounts.COARSE.selected,
    NARROW_SURVIVORS: stageCounts.NARROW.selected,
    FINE_SURVIVORS: stageCounts.FINE.selected,
    FINALIST_COUNT: finalists.length,
  });
  const output = {
    schemaVersion: PHASE3_TOURNAMENT_SCHEMA_VERSION,
    status: "COMPLETE",
    DISCOVERY_STATUS: discovered.length > 0 ? "COMPLETE" : "NO_COMPATIBLE_FAMILIES",
    tournamentRunId,
    codeSha,
    registryDigest: registry.registryDigest,
    candidateUniverseDigest,
    policyDigests: policies.digests,
    totals: {
      discoveredFamilies: new Set(discovered.map((candidate) => candidate.strategyFamilyId)).size,
      generated: generationAttempts,
      uniqueGenerated: seen.size,
      deduped: generationAttempts - seen.size,
      evaluated: evaluated.size,
      failed: observability.TOTAL_FAILED,
      eliminated: eliminated.length,
      survived: stagePool.length,
      finalists: finalists.length,
    },
    observability,
    stages: stageCounts,
    eliminationReasonCounts: reasonCounts,
    eliminations: eliminated,
    finalists,
    alphaCandidateEvidence,
    executionRealismEvidence: { credited: false, observations: [] },
    phase4Handoff: { status: "AWAITING_PHASE4_CANDIDATE_FREEZE", candidateFreezePerformed: false, finalistIds: finalists.map((finalist) => finalist.candidateId) },
    PROFITABILITY_PROVEN: false,
    NET_ALPHA_PROVEN: false,
    CHAMPION: "NONE",
    safety: safetyEnvelope(),
  };
  return deepFreeze(output);
}
