import {
  computeWalkForwardStability,
  evaluateMinimumGate,
} from "./automated-research-orchestrator.js";
import { buildAutonomousQuantLabContract } from "./autonomous-quant-lab-contract.js";
import {
  buildStrategyResultCacheProvenance,
  validateCacheReuse,
} from "./research-cache-provenance.js";
import {
  recordGlobalEvidence,
  verifyGlobalEvidenceLedger,
} from "./global-evidence-dedup-ledger-v1.js";
import { researchDigest } from "./research-trial-registry.js";

export const AUTONOMOUS_RESEARCH_JOB_STAGES = Object.freeze([
  "QUEUED",
  "DATA_VALIDATION",
  "HISTORICAL_BACKTEST",
  "COST_EVALUATION",
  "STATISTICAL_FIREWALL",
  "OOS",
  "PURGED_WALK_FORWARD",
  "COST_STRESS",
  "REGIME_STRESS",
  "PRE_HOLDOUT_GATE",
  "FROZEN_ELIGIBLE",
]);

export const AUTONOMOUS_RESEARCH_REJECTION_CODES = Object.freeze([
  "BLOCKED_DATA",
  "CACHE_IDENTITY_MISMATCH",
  "BACKTEST_FAILED",
  "NON_POSITIVE_NET_EXPECTANCY",
  "STATISTICAL_FIREWALL_FAILED",
  "OOS_FAILED",
  "WALK_FORWARD_FAILED",
  "COST_STRESS_FAILED",
  "REGIME_STRESS_FAILED",
  "CALIBRATION_REQUIRED",
  "PRE_HOLDOUT_GATE_FAILED",
  "RUNTIME_CONTRACT_FAILED",
]);

const MARKET_DIRECTIONS = Object.freeze({
  KR_STOCK: new Set(["BUY"]),
  US_STOCK: new Set(["BUY"]),
  CRYPTO_SPOT: new Set(["BUY"]),
  CRYPTO_FUTURES: new Set(["LONG", "SHORT"]),
});
const STAGE_SET = new Set(AUTONOMOUS_RESEARCH_JOB_STAGES);
const SHA40 = /^[0-9a-f]{40}$/i;
const DIGEST64 = /^[0-9a-f]{64}$/i;

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function requiredTimestamp(value, name) {
  const text = requiredText(value, name);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${name} must be a timestamp`);
  return new Date(text).toISOString();
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeNumber(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative number`);
  return value;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
}

function immutableJson(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} is required`);
  return Object.freeze(canonical(value));
}

function resourceLimits(raw = {}) {
  const limits = Object.freeze({
    maxWorkers: positiveInteger(raw.maxWorkers ?? 2, "maxWorkers"),
    maxCpuPercent: nonNegativeNumber(raw.maxCpuPercent ?? 75, "maxCpuPercent"),
    maxMemoryMb: positiveInteger(raw.maxMemoryMb ?? 4096, "maxMemoryMb"),
    minFreeDiskMb: positiveInteger(raw.minFreeDiskMb ?? 2048, "minFreeDiskMb"),
    maxJobRuntimeMs: positiveInteger(raw.maxJobRuntimeMs ?? 1_800_000, "maxJobRuntimeMs"),
    maxQueueDepth: positiveInteger(raw.maxQueueDepth ?? 256, "maxQueueDepth"),
  });
  if (limits.maxCpuPercent > 100) throw new RangeError("maxCpuPercent cannot exceed 100");
  return limits;
}

function safetyEnvelope() {
  return Object.freeze({
    LIVE_TRADING: false,
    AUTO_TRADING: false,
    REAL_ORDER_ENABLED: false,
    PRIVATE_TRADING_API_ALLOWED: false,
    liveTradingAllowed: false,
    privateAccountRequestAllowed: false,
    orderSubmitted: false,
    orderCancelled: false,
    orderModified: false,
    transferSubmitted: false,
    withdrawalSubmitted: false,
    finalHoldoutOpened: false,
    scannerEligibilityAuthority: false,
  });
}

function jobPriority(input) {
  if (input.expectedProfit != null || input.profitabilityScore != null || input.holdoutMetric != null) {
    throw new Error("JOB_PRIORITY_CANNOT_USE_PROFIT_OR_HOLDOUT_RESULT");
  }
  const evidence = Object.freeze({ E2_REPLICATION: 40, E1_LITERATURE: 30, AI_HYPOTHESIS: 10, NONE: 0 });
  const novelty = Object.freeze({ NOVEL_FAMILY: 20, NOVEL_VARIANT: 12, KNOWN_VARIANT: 4, DUPLICATE_FAILED_TRIAL: 0 });
  const review = Object.freeze({
    AI_REVIEW_AGREE: 15,
    AI_REVIEW_CONFLICT: 8,
    AI_REVIEW_BOTH_REJECT: 0,
    AI_REVIEW_INCOMPLETE: 0,
  });
  const data = input.dataReady === true ? 20 : 0;
  return (evidence[input.evidenceClass] ?? 0) + (novelty[input.noveltyClassification] ?? 0) + (review[input.dualAiReviewStatus] ?? 0) + data;
}

function assertMarketDirection(market, direction) {
  const allowed = MARKET_DIRECTIONS[market];
  if (!allowed) throw new RangeError("market is outside the four-market research boundary");
  if (!allowed.has(direction)) throw new Error(`DIRECTION_NOT_ALLOWED:${market}:${direction}`);
}

function resolveRankingGroup(market, strategyType, direction) {
  const contract = buildAutonomousQuantLabContract();
  const canonicalDirection = direction === "BUY" ? "LONG" : direction;
  const group = contract.groups.find((item) => item.market === market && item.strategyType === strategyType && item.direction === canonicalDirection);
  if (!group) throw new Error("CANONICAL_QUANT_LAB_GROUP_NOT_FOUND");
  return group.id;
}

export function buildAutonomousResearchJob(input = {}) {
  const market = requiredText(input.market, "market").toUpperCase();
  const direction = requiredText(input.direction, "direction").toUpperCase();
  assertMarketDirection(market, direction);
  const researchCodeSha = requiredText(input.researchCodeSha, "researchCodeSha").toLowerCase();
  if (!SHA40.test(researchCodeSha)) throw new TypeError("researchCodeSha must be an exact 40-character SHA");
  const datasetDigest = requiredText(input.datasetDigest, "datasetDigest").toLowerCase();
  if (!DIGEST64.test(datasetDigest)) throw new TypeError("datasetDigest must be a SHA-256 digest");
  const rawCandidate = immutableJson(input.candidate, "candidate");
  const candidateIdentityDigest = requiredText(rawCandidate.candidateIdentity
    ?? rawCandidate.strategyIdentityDigest
    ?? (rawCandidate.strategyId && rawCandidate.variantId ? researchDigest({ strategyId: rawCandidate.strategyId, variantId: rawCandidate.variantId }) : null), "candidateIdentity");
  if (!DIGEST64.test(candidateIdentityDigest)) throw new TypeError("candidate identity must be a SHA-256 digest");
  const candidate = Object.freeze({
    ...rawCandidate,
    candidateIdentity: candidateIdentityDigest,
    formulaHash: rawCandidate.formulaHash ?? rawCandidate.formulaFingerprint,
    parameters: rawCandidate.parameters ?? rawCandidate.specification?.parameters,
  });
  const strategyType = requiredText(input.strategyType, "strategyType").toUpperCase();
  const splitPolicy = immutableJson(input.splitPolicy, "splitPolicy");
  if (splitPolicy.finalHoldoutExcluded !== true || splitPolicy.selectionUsesFinalHoldout !== false) {
    throw new Error("FINAL_HOLDOUT_PROTECTION_REQUIRED");
  }
  const costPolicy = immutableJson(input.costPolicy, "costPolicy");
  const identity = Object.freeze({
    candidateIdentityDigest,
    parameterHash: requiredText(candidate.parameterHash, "candidate.parameterHash"),
    formulaHash: requiredText(candidate.formulaHash, "candidate.formulaHash"),
    market,
    direction,
    strategyType,
    universeId: requiredText(input.universeId, "universeId"),
    timeframe: requiredText(input.timeframe, "timeframe"),
    datasetId: requiredText(input.datasetId, "datasetId"),
    datasetDigest,
    costPolicyVersion: requiredText(costPolicy.version, "costPolicy.version"),
    decisionPolicyVersion: requiredText(input.decisionPolicy?.version, "decisionPolicy.version"),
    researchCodeSha,
  });
  const jobId = `research-job-v1:${researchDigest(identity)}`;
  return Object.freeze({
    schemaVersion: 1,
    jobId,
    identity,
    candidate,
    market,
    direction,
    strategyType,
    rankingGroup: resolveRankingGroup(market, strategyType, direction),
    universeId: identity.universeId,
    timeframe: identity.timeframe,
    datasetId: identity.datasetId,
    datasetDigest,
    costPolicy,
    splitPolicy,
    decisionPolicy: immutableJson(input.decisionPolicy, "decisionPolicy"),
    historicalCacheProvenance: immutableJson(input.historicalCacheProvenance, "historicalCacheProvenance"),
    evidenceClass: requiredText(input.evidenceClass ?? "NONE", "evidenceClass"),
    noveltyClassification: requiredText(input.noveltyClassification ?? "NOVEL_VARIANT", "noveltyClassification"),
    dualAiReviewStatus: requiredText(input.dualAiReviewStatus ?? "AI_REVIEW_INCOMPLETE", "dualAiReviewStatus"),
    dataReady: input.dataReady === true,
    resourceClass: requiredText(input.resourceClass ?? "STANDARD", "resourceClass"),
    priority: jobPriority(input),
    submittedAt: requiredTimestamp(input.submittedAt, "submittedAt"),
    researchCodeSha,
    canonicalBacktestOwner: "#226",
    canonicalEvidenceDedupOwner: "#482",
    stage: "QUEUED",
    safety: safetyEnvelope(),
  });
}

function queueCore({ queueId, limits, jobs, checkpoints, results, events }) {
  return Object.freeze({
    schemaVersion: 1,
    queueId,
    limits,
    jobs,
    checkpoints,
    results,
    events,
    canonicalQueueOwner: "#226",
    canonicalCacheOwner: "#226",
    experimentDedupOwner: "#482",
    persistenceRequiredForActivation: true,
    safety: safetyEnvelope(),
  });
}

function withQueueDigest(core) {
  return Object.freeze({ ...core, queueDigest: researchDigest(core) });
}

export function createAutonomousResearchQueue({ queueId = "AUTONOMOUS_GLOBAL_RESEARCH_QUEUE_V1", limits = {} } = {}) {
  return withQueueDigest(queueCore({
    queueId: requiredText(queueId, "queueId"),
    limits: resourceLimits(limits),
    jobs: Object.freeze([]),
    checkpoints: Object.freeze({}),
    results: Object.freeze({}),
    events: Object.freeze([]),
  }));
}

export function verifyAutonomousResearchQueue(queue) {
  if (!queue || queue.schemaVersion !== 1 || !queue.limits || !Array.isArray(queue.jobs) || !queue.checkpoints || !queue.results || !Array.isArray(queue.events)) return false;
  const core = queueCore({
    queueId: queue.queueId,
    limits: queue.limits,
    jobs: Object.freeze([...queue.jobs]),
    checkpoints: Object.freeze({ ...queue.checkpoints }),
    results: Object.freeze({ ...queue.results }),
    events: Object.freeze([...queue.events]),
  });
  return queue.queueDigest === researchDigest(core)
    && queue.safety?.LIVE_TRADING === false
    && queue.safety?.REAL_ORDER_ENABLED === false;
}

function nextQueue(queue, updates) {
  if (!verifyAutonomousResearchQueue(queue)) throw new Error("AUTONOMOUS_RESEARCH_QUEUE_INVALID");
  return withQueueDigest(queueCore({
    queueId: queue.queueId,
    limits: queue.limits,
    jobs: Object.freeze(updates.jobs ?? [...queue.jobs]),
    checkpoints: Object.freeze(updates.checkpoints ?? { ...queue.checkpoints }),
    results: Object.freeze(updates.results ?? { ...queue.results }),
    events: Object.freeze(updates.events ?? [...queue.events]),
  }));
}

export function enqueueAutonomousResearchJob(queue, job) {
  if (!verifyAutonomousResearchQueue(queue)) throw new Error("AUTONOMOUS_RESEARCH_QUEUE_INVALID");
  if (!job?.jobId || job.stage !== "QUEUED") throw new TypeError("valid queued job is required");
  const known = queue.jobs.some((item) => item.jobId === job.jobId) || queue.results[job.jobId] != null;
  if (known) return Object.freeze({ status: "DUPLICATE_JOB", queue, queueDepthDelta: 0 });
  if (queue.jobs.length >= queue.limits.maxQueueDepth) return Object.freeze({ status: "QUEUE_WAIT", reason: "MAX_QUEUE_DEPTH", queue, queueDepthDelta: 0 });
  const jobs = [...queue.jobs, job].sort((left, right) => right.priority - left.priority || left.jobId.localeCompare(right.jobId));
  const event = Object.freeze({ type: "JOB_ENQUEUED", jobId: job.jobId, observedAt: job.submittedAt });
  return Object.freeze({ status: "QUEUED", queue: nextQueue(queue, { jobs, events: [...queue.events, event] }), queueDepthDelta: 1 });
}

function capacityReason(limits, resources = {}) {
  if (!Number.isInteger(resources.activeWorkers) || resources.activeWorkers < 0) return "RESOURCE_TELEMETRY_INVALID";
  if (!Number.isFinite(resources.cpuPercent) || resources.cpuPercent < 0) return "RESOURCE_TELEMETRY_INVALID";
  if (!Number.isFinite(resources.memoryUsedMb) || resources.memoryUsedMb < 0) return "RESOURCE_TELEMETRY_INVALID";
  if (!Number.isFinite(resources.freeDiskMb) || resources.freeDiskMb < 0) return "RESOURCE_TELEMETRY_INVALID";
  if (resources.activeWorkers >= limits.maxWorkers) return "MAX_WORKERS";
  if (resources.cpuPercent >= limits.maxCpuPercent) return "CPU_BACKPRESSURE";
  if (resources.memoryUsedMb >= limits.maxMemoryMb) return "MEMORY_BACKPRESSURE";
  if (resources.freeDiskMb < limits.minFreeDiskMb) return "DISK_BACKPRESSURE";
  return null;
}

export function claimNextAutonomousResearchJob(queue, resources, { claimedAt } = {}) {
  if (!verifyAutonomousResearchQueue(queue)) throw new Error("AUTONOMOUS_RESEARCH_QUEUE_INVALID");
  const reason = capacityReason(queue.limits, resources);
  if (reason) return Object.freeze({ status: "QUEUE_WAIT", reason, job: null, queue });
  const job = queue.jobs[0] ?? null;
  if (!job) return Object.freeze({ status: "QUEUE_EMPTY", reason: null, job: null, queue });
  const observedAt = requiredTimestamp(claimedAt, "claimedAt");
  const checkpoint = Object.freeze({ jobId: job.jobId, stage: "DATA_VALIDATION", attempts: (queue.checkpoints[job.jobId]?.attempts ?? 0) + 1, updatedAt: observedAt, terminal: false });
  const event = Object.freeze({ type: "JOB_CLAIMED", jobId: job.jobId, observedAt });
  return Object.freeze({
    status: "CLAIMED",
    reason: null,
    job,
    queue: nextQueue(queue, {
      jobs: queue.jobs.slice(1),
      checkpoints: { ...queue.checkpoints, [job.jobId]: checkpoint },
      events: [...queue.events, event],
    }),
  });
}

export function checkpointAutonomousResearchJob(queue, job, { stage, updatedAt }) {
  if (!verifyAutonomousResearchQueue(queue)) throw new Error("AUTONOMOUS_RESEARCH_QUEUE_INVALID");
  if (!STAGE_SET.has(stage) || stage === "QUEUED") throw new Error("RESEARCH_JOB_STAGE_INVALID");
  const previous = queue.checkpoints[job?.jobId];
  if (!previous || previous.terminal) throw new Error("ACTIVE_JOB_CHECKPOINT_REQUIRED");
  const currentIndex = AUTONOMOUS_RESEARCH_JOB_STAGES.indexOf(previous.stage);
  const nextIndex = AUTONOMOUS_RESEARCH_JOB_STAGES.indexOf(stage);
  if (nextIndex < currentIndex) throw new Error("RESEARCH_JOB_STAGE_REGRESSION_FORBIDDEN");
  const observedAt = requiredTimestamp(updatedAt, "updatedAt");
  const checkpoint = Object.freeze({ ...previous, stage, updatedAt: observedAt });
  return nextQueue(queue, {
    checkpoints: { ...queue.checkpoints, [job.jobId]: checkpoint },
    events: [...queue.events, Object.freeze({ type: "JOB_CHECKPOINTED", jobId: job.jobId, stage, observedAt })],
  });
}

function rejection(job, code, stage, detail, auditTrail) {
  if (!AUTONOMOUS_RESEARCH_REJECTION_CODES.includes(code)) throw new Error("REJECTION_CODE_INVALID");
  const core = Object.freeze({
    schemaVersion: 1,
    jobId: job.jobId,
    status: "REJECTED",
    rejectionCode: code,
    stage,
    detail: detail ?? null,
    auditTrail: Object.freeze(auditTrail),
    finalHoldoutOpened: false,
    frozenCandidate: false,
    safety: safetyEnvelope(),
  });
  return Object.freeze({ ...core, resultDigest: researchDigest(core) });
}

function successful(job, evidence, auditTrail) {
  const core = Object.freeze({
    schemaVersion: 1,
    jobId: job.jobId,
    status: "FROZEN_ELIGIBLE",
    rejectionCode: null,
    stage: "FROZEN_ELIGIBLE",
    evidence: Object.freeze(evidence),
    auditTrail: Object.freeze(auditTrail),
    finalHoldoutOpened: false,
    frozenCandidate: false,
    freezeAuthority: "LIFECYCLE_ADAPTER_ONLY",
    safety: safetyEnvelope(),
  });
  return Object.freeze({ ...core, resultDigest: researchDigest(core) });
}

function requireCallback(dependencies, name) {
  if (typeof dependencies?.[name] !== "function") throw new Error(`CANONICAL_CALLBACK_REQUIRED:${name}`);
  return dependencies[name];
}

function audit(stage, payload) {
  return Object.freeze({ stage, digest: researchDigest(payload), status: payload?.status ?? null });
}

export async function executeAutonomousResearchJob(job, dependencies = {}) {
  const auditTrail = [];
  if (!job?.jobId || job.canonicalBacktestOwner !== "#226") return rejection(job, "RUNTIME_CONTRACT_FAILED", "DATA_VALIDATION", "CANONICAL_JOB_REQUIRED", auditTrail);
  if (job.dataReady !== true) return rejection(job, "BLOCKED_DATA", "DATA_VALIDATION", "DATA_NOT_READY", auditTrail);
  const expectedHistorical = job.historicalCacheProvenance;
  const actualHistorical = await requireCallback(dependencies, "loadHistoricalCache")(expectedHistorical, job);
  const historicalReuse = validateCacheReuse(expectedHistorical, actualHistorical);
  auditTrail.push(audit("DATA_VALIDATION", historicalReuse));
  if (!historicalReuse.reusable) return rejection(job, "CACHE_IDENTITY_MISMATCH", "DATA_VALIDATION", historicalReuse.reason, auditTrail);

  const resultCacheProvenance = buildStrategyResultCacheProvenance({
    researchCodeSha: job.researchCodeSha,
    historicalCacheKey: expectedHistorical.cacheKey,
    strategyVersion: job.identity.formulaHash,
    parameters: job.candidate.parameters,
    costModel: job.costPolicy,
    splitContract: job.splitPolicy,
    direction: job.direction,
  });
  const cachedResult = typeof dependencies.loadStrategyResultCache === "function"
    ? await dependencies.loadStrategyResultCache(resultCacheProvenance, job)
    : null;
  if (cachedResult?.provenance) {
    const cacheReuse = validateCacheReuse(resultCacheProvenance, cachedResult.provenance);
    auditTrail.push(audit("HISTORICAL_BACKTEST", cacheReuse));
    if (!cacheReuse.reusable) return rejection(job, "CACHE_IDENTITY_MISMATCH", "HISTORICAL_BACKTEST", cacheReuse.reason, auditTrail);
    if (cachedResult.result?.resultDigest) return cachedResult.result;
  }

  const backtest = await requireCallback(dependencies, "runCanonicalBacktest")(job, actualHistorical);
  auditTrail.push(audit("HISTORICAL_BACKTEST", backtest));
  if (backtest?.status !== "COMPLETED" || !backtest.grossMetrics) return rejection(job, "BACKTEST_FAILED", "HISTORICAL_BACKTEST", backtest?.reason ?? null, auditTrail);

  const costs = await requireCallback(dependencies, "evaluateCanonicalCosts")(job, backtest);
  auditTrail.push(audit("COST_EVALUATION", costs));
  if (costs?.status !== "PASS" || !(costs.netMetrics?.expectancy > 0)) {
    return rejection(job, "NON_POSITIVE_NET_EXPECTANCY", "COST_EVALUATION", costs?.reason ?? null, auditTrail);
  }

  const statistics = await requireCallback(dependencies, "runStatisticalFirewall")(job, backtest, costs);
  auditTrail.push(audit("STATISTICAL_FIREWALL", statistics));
  if (statistics?.status === "CALIBRATION_REQUIRED") return rejection(job, "CALIBRATION_REQUIRED", "STATISTICAL_FIREWALL", statistics.reason ?? null, auditTrail);
  if (statistics?.status !== "PASS") return rejection(job, "STATISTICAL_FIREWALL_FAILED", "STATISTICAL_FIREWALL", statistics?.reason ?? null, auditTrail);

  const oos = await requireCallback(dependencies, "runCanonicalOos")(job, costs);
  auditTrail.push(audit("OOS", oos));
  if (oos?.status !== "PASS" || !oos.metrics) return rejection(job, "OOS_FAILED", "OOS", oos?.reason ?? null, auditTrail);

  const walkForward = await requireCallback(dependencies, "runCanonicalWalkForward")(job, costs);
  const walkForwardMetrics = computeWalkForwardStability(walkForward?.windows ?? []);
  auditTrail.push(audit("PURGED_WALK_FORWARD", { ...walkForward, metrics: walkForwardMetrics }));
  if (walkForward?.status !== "PASS" || walkForward?.leakFree !== true || walkForwardMetrics.windowCount === 0) {
    return rejection(job, "WALK_FORWARD_FAILED", "PURGED_WALK_FORWARD", walkForward?.reason ?? null, auditTrail);
  }

  const costStress = await requireCallback(dependencies, "runCanonicalCostStress")(job, costs);
  auditTrail.push(audit("COST_STRESS", costStress));
  if (costStress?.status !== "PASS" || ![1, 1.25, 1.5, 2].every((multiple) => costStress.survivedMultiples?.includes(multiple))) {
    return rejection(job, "COST_STRESS_FAILED", "COST_STRESS", costStress?.reason ?? null, auditTrail);
  }

  const regime = await requireCallback(dependencies, "runCanonicalRegimeStress")(job, costs);
  auditTrail.push(audit("REGIME_STRESS", regime));
  if (regime?.status !== "PASS") return rejection(job, "REGIME_STRESS_FAILED", "REGIME_STRESS", regime?.reason ?? null, auditTrail);

  const minimumGate = evaluateMinimumGate({
    oosMetrics: oos.metrics,
    walkForwardMetrics,
    dataCoverage: oos.dataCoverage,
    holdoutLeakDetected: oos.holdoutLeakDetected === true,
    config: job.decisionPolicy.minimumGate,
  });
  auditTrail.push(audit("PRE_HOLDOUT_GATE", minimumGate));
  if (minimumGate.status === "threshold_calibration_required") return rejection(job, "CALIBRATION_REQUIRED", "PRE_HOLDOUT_GATE", minimumGate.unconfiguredThresholds, auditTrail);
  if (!minimumGate.passed) return rejection(job, "PRE_HOLDOUT_GATE_FAILED", "PRE_HOLDOUT_GATE", minimumGate.reasons, auditTrail);

  const result = successful(job, {
    resultCacheProvenance,
    grossMetrics: backtest.grossMetrics,
    netMetrics: costs.netMetrics,
    costDrag: costs.costDrag ?? null,
    statistics,
    oos,
    walkForward: Object.freeze({ ...walkForward, metrics: walkForwardMetrics }),
    costStress,
    regime,
    minimumGate,
  }, auditTrail);
  if (typeof dependencies.storeStrategyResultCache === "function") await dependencies.storeStrategyResultCache(resultCacheProvenance, result, job);
  return result;
}

export function finalizeAutonomousResearchJob(queue, job, result, { completedAt }) {
  if (!verifyAutonomousResearchQueue(queue)) throw new Error("AUTONOMOUS_RESEARCH_QUEUE_INVALID");
  const previous = queue.checkpoints[job?.jobId];
  if (!previous || previous.terminal) throw new Error("ACTIVE_JOB_CHECKPOINT_REQUIRED");
  if (queue.results[job.jobId]) return Object.freeze({ status: "DUPLICATE_RESULT", queue, result: queue.results[job.jobId] });
  const observedAt = requiredTimestamp(completedAt, "completedAt");
  const checkpoint = Object.freeze({ ...previous, stage: result.stage, updatedAt: observedAt, terminal: true, resultDigest: result.resultDigest });
  const next = nextQueue(queue, {
    checkpoints: { ...queue.checkpoints, [job.jobId]: checkpoint },
    results: { ...queue.results, [job.jobId]: result },
    events: [...queue.events, Object.freeze({ type: "JOB_TERMINAL", jobId: job.jobId, status: result.status, observedAt })],
  });
  return Object.freeze({ status: result.status, queue: next, result });
}

export function recordAutonomousResearchResultEvidence(ledger, job, result, runtime = {}) {
  if (!verifyGlobalEvidenceLedger(ledger).valid) throw new Error("GLOBAL_EVIDENCE_LEDGER_INVALID");
  if (!result?.resultDigest || result.jobId !== job?.jobId) throw new Error("RESEARCH_RESULT_IDENTITY_MISMATCH");
  return recordGlobalEvidence(ledger, {
    producerFamily: "AUTONOMOUS_GLOBAL_RESEARCH_FACTORY_V1",
    strategyIdentityDigest: job.identity.candidateIdentityDigest,
    researchCodeSha: job.researchCodeSha,
    market: job.market,
    symbol: requiredText(runtime.symbol ?? job.universeId, "symbol"),
    timeframe: job.timeframe,
    side: job.direction,
    observationTimestamp: requiredTimestamp(runtime.observationTimestamp, "observationTimestamp"),
    horizon: requiredText(runtime.horizon ?? job.strategyType, "horizon"),
    sourceDatasetId: job.datasetId,
    provenanceDigest: job.datasetDigest,
    outcomeKind: result.status,
    workflowFamily: requiredText(runtime.workflowFamily ?? "AUTONOMOUS_RESEARCH_DISPATCHER_V1", "workflowFamily"),
    artifactLineageDigest: result.resultDigest,
    payload: Object.freeze({ jobId: job.jobId, resultDigest: result.resultDigest, status: result.status, rejectionCode: result.rejectionCode }),
  });
}

export function buildAutonomousResearchProductionPlan({ ownerRef = "#226", stateRoot = null } = {}) {
  return Object.freeze({
    schemaVersion: 1,
    ownerRef,
    serviceMode: "ALWAYS_ON_24X7",
    stateRoot,
    activationStatus: "PLAN_ONLY",
    executableWhenApproved: stateRoot != null,
    timerActivationRequested: false,
    serverRestartRequested: false,
    deploymentRequested: false,
    jobSpec: Object.freeze({ schemaVersion: 1, deterministicPriority: true, expectedProfitPriorityAllowed: false, finalHoldoutExcluded: true }),
    datasetCacheReuse: Object.freeze({ canonicalOwner: "#226", exactIdentityRequired: true, staleReuseAllowed: false, pointInTimeRequired: true }),
    experimentDedup: Object.freeze({ canonicalOwner: "#482", duplicateSampleCountIncrement: 0, renameBypassAllowed: false }),
    restartSafeCheckpoint: Object.freeze({ queueDigestRequired: true, monotonicStagesRequired: true, terminalResultIdempotent: true }),
    resourceBackpressure: Object.freeze({ queueWaitInsteadOfOverload: true, boundedWorkers: true, cpuMemoryDiskRuntimeLimits: true }),
    safety: safetyEnvelope(),
  });
}
