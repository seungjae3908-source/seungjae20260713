import {
  recordDualFreeAiReview,
  synthesizeDualFreeAiReview,
  verifyDualFreeAiReviewPlan,
} from "./autonomous-strategy-formula-generator-v1.js";
import { executeAutonomousResearchJob } from "./autonomous-research-dispatcher-v1.js";
import { researchDigest } from "./research-trial-registry.js";

export const AUTONOMOUS_RUNTIME_WORKER_STAGES = Object.freeze([
  "QUEUE_JOB",
  "DATA_PREFLIGHT",
  "FEATURE_CACHE_CHECK",
  "STRATEGY_COMPILE",
  "BACKTEST_EXECUTION",
  "COST_MODEL",
  "STATISTICS",
  "EVIDENCE_ARTIFACT",
  "NEXT_STAGE",
]);

export const AUTONOMOUS_FEATURE_TYPES = Object.freeze([
  "RETURNS",
  "ATR",
  "VWAP",
  "RVOL",
  "MOMENTUM",
  "VOLATILITY",
  "REGIME",
  "FUNDING",
  "OI",
  "BASIS",
  "LIQUIDITY",
]);

const MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const SENSITIVE_KEY = /(api[_-]?key|access[_-]?token|authorization|password|private[_-]?key|secret)/i;
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

function canonical(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

function immutableJson(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} is required`);
  return Object.freeze(canonical(value));
}

function safetyEnvelope() {
  return Object.freeze({
    AUTONOMOUS_RESEARCH_FACTORY_ACTIVE: false,
    LIVE_TRADING: false,
    AUTO_TRADING: false,
    REAL_ORDER_ENABLED: false,
    PRIVATE_TRADING_API_ALLOWED: false,
    paidAiFallbackAllowed: false,
    finalHoldoutOpened: false,
    shadowActivated: false,
    paperActivated: false,
    scannerEligibilityActivated: false,
    financialMutationAllowed: false,
  });
}

function runtimeCore(input) {
  return Object.freeze({
    schemaVersion: 1,
    runtimeId: input.runtimeId,
    aiCalls: input.aiCalls,
    aiOutputs: input.aiOutputs,
    waitingForAi: input.waitingForAi,
    datasetInspections: input.datasetInspections,
    featureCache: input.featureCache,
    workerCheckpoints: input.workerCheckpoints,
    completedJobs: input.completedJobs,
    failedJobs: input.failedJobs,
    failureHistory: input.failureHistory,
    retryQueue: input.retryQueue,
    events: input.events,
    counters: input.counters,
    lastResearchTime: input.lastResearchTime,
    newResearchCount: input.newResearchCount,
    canonicalOwners: Object.freeze({ queueBacktestWorker: "#226", evidenceDedup: "#482", lifecycle: "ADAPTER_ONLY" }),
    safety: safetyEnvelope(),
  });
}

function withRuntimeDigest(core) {
  return Object.freeze({ ...core, runtimeStateDigest: researchDigest(core) });
}

export function createAutonomousResearchRuntimeState({ runtimeId = "AUTONOMOUS_RESEARCH_RUNTIME_V1" } = {}) {
  return withRuntimeDigest(runtimeCore({
    runtimeId: requiredText(runtimeId, "runtimeId"),
    aiCalls: Object.freeze([]),
    aiOutputs: Object.freeze({}),
    waitingForAi: Object.freeze({}),
    datasetInspections: Object.freeze({}),
    featureCache: Object.freeze({}),
    workerCheckpoints: Object.freeze({}),
    completedJobs: Object.freeze({}),
    failedJobs: Object.freeze({}),
    failureHistory: Object.freeze([]),
    retryQueue: Object.freeze({}),
    events: Object.freeze([]),
    counters: Object.freeze({ cacheHits: 0, cacheMisses: 0, backtestCount: 0, oosCount: 0, wfoCount: 0, frozenCount: 0, shadowReadyCount: 0, paperReadyCount: 0 }),
    lastResearchTime: null,
    newResearchCount: 0,
  }));
}

export function verifyAutonomousResearchRuntimeState(state) {
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.aiCalls) || !Array.isArray(state.failureHistory) || !state.featureCache || !state.workerCheckpoints) return false;
  const core = runtimeCore({
    runtimeId: state.runtimeId,
    aiCalls: Object.freeze([...state.aiCalls]),
    aiOutputs: Object.freeze({ ...state.aiOutputs }),
    waitingForAi: Object.freeze({ ...state.waitingForAi }),
    datasetInspections: Object.freeze({ ...state.datasetInspections }),
    featureCache: Object.freeze({ ...state.featureCache }),
    workerCheckpoints: Object.freeze({ ...state.workerCheckpoints }),
    completedJobs: Object.freeze({ ...state.completedJobs }),
    failedJobs: Object.freeze({ ...state.failedJobs }),
    failureHistory: Object.freeze([...state.failureHistory]),
    retryQueue: Object.freeze({ ...state.retryQueue }),
    events: Object.freeze([...state.events]),
    counters: Object.freeze({ ...state.counters }),
    lastResearchTime: state.lastResearchTime,
    newResearchCount: state.newResearchCount,
  });
  return state.runtimeStateDigest === researchDigest(core)
    && state.safety?.AUTONOMOUS_RESEARCH_FACTORY_ACTIVE === false
    && state.safety?.PRIVATE_TRADING_API_ALLOWED === false;
}

function nextRuntime(state, updates = {}) {
  if (!verifyAutonomousResearchRuntimeState(state)) throw new Error("AUTONOMOUS_RESEARCH_RUNTIME_STATE_INVALID");
  return withRuntimeDigest(runtimeCore({
    runtimeId: state.runtimeId,
    aiCalls: Object.freeze(updates.aiCalls ?? [...state.aiCalls]),
    aiOutputs: Object.freeze(updates.aiOutputs ?? { ...state.aiOutputs }),
    waitingForAi: Object.freeze(updates.waitingForAi ?? { ...state.waitingForAi }),
    datasetInspections: Object.freeze(updates.datasetInspections ?? { ...state.datasetInspections }),
    featureCache: Object.freeze(updates.featureCache ?? { ...state.featureCache }),
    workerCheckpoints: Object.freeze(updates.workerCheckpoints ?? { ...state.workerCheckpoints }),
    completedJobs: Object.freeze(updates.completedJobs ?? { ...state.completedJobs }),
    failedJobs: Object.freeze(updates.failedJobs ?? { ...state.failedJobs }),
    failureHistory: Object.freeze(updates.failureHistory ?? [...state.failureHistory]),
    retryQueue: Object.freeze(updates.retryQueue ?? { ...state.retryQueue }),
    events: Object.freeze(updates.events ?? [...state.events]),
    counters: Object.freeze(updates.counters ?? { ...state.counters }),
    lastResearchTime: updates.lastResearchTime === undefined ? state.lastResearchTime : updates.lastResearchTime,
    newResearchCount: updates.newResearchCount ?? state.newResearchCount,
  }));
}

function walkForSecrets(value, path = "provider") {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`AI_PROVIDER_SECRET_METADATA_FORBIDDEN:${path}.${key}`);
    if (item && typeof item === "object") walkForSecrets(item, `${path}.${key}`);
  }
}

export function assertSafeFreeAiProviderMetadata(providers = []) {
  if (!Array.isArray(providers)) throw new TypeError("providers must be an array");
  walkForSecrets(providers);
  for (const [index, provider] of providers.entries()) {
    if (requiredText(provider?.billingTier, `providers[${index}].billingTier`).toUpperCase() !== "FREE") {
      throw new Error("PAID_AI_PROVIDER_FORBIDDEN");
    }
  }
  return true;
}

function safeFailureCode(error, fallback) {
  const message = typeof error?.message === "string" ? error.message : "";
  return /^[A-Z0-9_.:-]{1,120}$/.test(message) ? message : fallback;
}

function waitingForAiRecord(previous, { researchSourceId, evidenceFingerprint, observedAt, reason }) {
  const core = Object.freeze({
    workId: `waiting-ai:${researchDigest({ researchSourceId, evidenceFingerprint })}`,
    researchSourceId,
    evidenceFingerprint,
    state: "WAITING_FOR_AI",
    retryDisposition: "RETRY_LATER",
    attempts: (previous?.attempts ?? 0) + 1,
    nextRetryAt: null,
    reason,
    lastUpdatedAt: observedAt,
  });
  return Object.freeze({ ...core, workDigest: researchDigest(core) });
}

function providerStatus(calls, prefix) {
  const relevant = calls.filter((call) => call.slot.startsWith(prefix));
  if (!relevant.length) return "AI_RESEARCH_UNAVAILABLE";
  if (relevant.every((call) => call.status === "COMPLETED")) return "AVAILABLE";
  if (relevant.some((call) => call.status === "FAILED")) return "FAILED";
  return "INCOMPLETE";
}

export async function executeDualFreeAiRuntime(state, input = {}, callProvider) {
  if (!verifyAutonomousResearchRuntimeState(state)) throw new Error("AUTONOMOUS_RESEARCH_RUNTIME_STATE_INVALID");
  if (!verifyDualFreeAiReviewPlan(input.plan)) throw new Error("DUAL_FREE_AI_PLAN_INVALID");
  const researchSourceId = requiredText(input.researchSourceId, "researchSourceId");
  const calledAt = requiredTimestamp(input.calledAt, "calledAt");
  const calls = [];
  const recordedReviews = [];
  const outputs = { ...state.aiOutputs };

  if (input.plan.status === "DUAL_FREE_AI_READY" && typeof callProvider !== "function") {
    throw new Error("AI_PROVIDER_RUNTIME_CALLBACK_REQUIRED");
  }
  if (input.plan.status === "DUAL_FREE_AI_READY") {
    for (const slot of input.plan.slots) {
      const callCore = {
        providerId: slot.providerId,
        modelId: slot.modelId,
        timestamp: calledAt,
        slot: slot.slot,
        role: slot.role,
        mode: slot.mode,
        inputEvidenceFingerprint: input.plan.evidenceFingerprint,
      };
      try {
        const raw = await callProvider({ slot, plan: input.plan, researchRecord: input.researchRecord, analysis: input.analysis });
        const review = recordDualFreeAiReview(input.plan, raw);
        const outputFingerprint = researchDigest(review);
        const auditCore = Object.freeze({ ...callCore, outputFingerprint, status: "COMPLETED", failureReason: null });
        const call = Object.freeze({ ...auditCore, callId: `ai-call:${researchDigest(auditCore)}` });
        calls.push(call);
        recordedReviews.push(review);
        outputs[review.reviewId] = review;
      } catch (error) {
        const auditCore = Object.freeze({
          ...callCore,
          outputFingerprint: null,
          status: "FAILED",
          failureReason: safeFailureCode(error, "AI_PROVIDER_CALL_FAILED"),
        });
        calls.push(Object.freeze({ ...auditCore, callId: `ai-call:${researchDigest(auditCore)}` }));
      }
    }
  }

  const synthesis = synthesizeDualFreeAiReview({ plan: input.plan, reviews: recordedReviews });
  const waiting = { ...state.waitingForAi };
  const waitKey = `waiting-ai:${researchDigest({ researchSourceId, evidenceFingerprint: input.plan.evidenceFingerprint })}`;
  if (synthesis.status === "AI_REVIEW_INCOMPLETE") {
    const reason = input.plan.status === "DUAL_FREE_AI_READY" ? "AI_REVIEW_INCOMPLETE" : "AI_RESEARCH_UNAVAILABLE";
    waiting[waitKey] = waitingForAiRecord(waiting[waitKey], {
      researchSourceId,
      evidenceFingerprint: input.plan.evidenceFingerprint,
      observedAt: calledAt,
      reason,
    });
  } else {
    delete waiting[waitKey];
  }
  const uniqueCalls = [...state.aiCalls];
  for (const call of calls) if (!uniqueCalls.some((known) => known.callId === call.callId)) uniqueCalls.push(call);
  const events = calls.map((call) => Object.freeze({ type: "AI_PROVIDER_CALL", callId: call.callId, status: call.status, observedAt: calledAt }));
  const next = nextRuntime(state, {
    aiCalls: uniqueCalls,
    aiOutputs: outputs,
    waitingForAi: waiting,
    events: [...state.events, ...events],
  });
  return Object.freeze({
    state: next,
    synthesis,
    reviews: Object.freeze(recordedReviews),
    calls: Object.freeze(calls),
    status: input.plan.status === "DUAL_FREE_AI_READY" ? synthesis.status : "AI_RESEARCH_UNAVAILABLE",
    AI1Status: providerStatus(calls, "AI1_"),
    AI2Status: providerStatus(calls, "AI2_"),
    paidFallbackUsed: false,
  });
}

function blockedInspection(job, adapter, observedAt, reason) {
  const core = Object.freeze({
    jobId: job.jobId,
    market: job.market,
    datasetId: job.datasetId,
    adapterId: adapter?.adapterId ?? null,
    provider: adapter?.provider ?? null,
    observedAt,
    status: "BLOCKED_DATA",
    reason,
  });
  return Object.freeze({ ...core, inspectionDigest: researchDigest(core) });
}

function validateDatasetInspection(job, adapter, raw, observedAt) {
  if (!raw || raw.status !== "READY") return blockedInspection(job, adapter, observedAt, raw?.reason ?? "DATASET_NOT_READY");
  if (requiredText(raw.datasetId, "dataset.datasetId") !== job.datasetId) return blockedInspection(job, adapter, observedAt, "DATASET_ID_MISMATCH");
  if (requiredText(raw.provider, "dataset.provider") !== requiredText(adapter.provider, "adapter.provider")) return blockedInspection(job, adapter, observedAt, "DATA_PROVIDER_MISMATCH");
  if (!raw.coverage || !raw.range || !raw.universe || !Array.isArray(raw.timeframes)) return blockedInspection(job, adapter, observedAt, "DATASET_PROVENANCE_INCOMPLETE");
  if (!raw.timeframes.includes(job.timeframe)) return blockedInspection(job, adapter, observedAt, "TIMEFRAME_NOT_COVERED");
  if (requiredText(raw.dataFingerprint, "dataset.dataFingerprint").toLowerCase() !== job.datasetDigest) return blockedInspection(job, adapter, observedAt, "DATA_FINGERPRINT_MISMATCH");
  if (!raw.quality || raw.quality.status !== "PASS" || raw.quality.pointInTimeSafe !== true) return blockedInspection(job, adapter, observedAt, "DATA_QUALITY_FAILED");
  const asOf = requiredTimestamp(raw.asOf, "dataset.asOf");
  const maxSourceTimestamp = requiredTimestamp(raw.maxSourceTimestamp, "dataset.maxSourceTimestamp");
  if (Date.parse(maxSourceTimestamp) > Date.parse(asOf)) return blockedInspection(job, adapter, observedAt, "PIT_LEAK_DETECTED");
  const core = Object.freeze({
    jobId: job.jobId,
    market: job.market,
    datasetId: job.datasetId,
    adapterId: requiredText(adapter.adapterId, "adapter.adapterId"),
    provider: requiredText(raw.provider, "dataset.provider"),
    coverage: immutableJson(raw.coverage, "dataset.coverage"),
    range: immutableJson(raw.range, "dataset.range"),
    universe: canonical(raw.universe),
    timeframes: Object.freeze([...raw.timeframes].map((value) => requiredText(value, "dataset.timeframe")).sort()),
    dataFingerprint: raw.dataFingerprint.toLowerCase(),
    quality: immutableJson(raw.quality, "dataset.quality"),
    asOf,
    maxSourceTimestamp,
    observedAt,
    status: "READY",
    reason: null,
  });
  return Object.freeze({ ...core, inspectionDigest: researchDigest(core) });
}

export async function inspectAutonomousDatasetRuntime(state, { job, adapter, observedAt }, inspectDataset) {
  if (!verifyAutonomousResearchRuntimeState(state)) throw new Error("AUTONOMOUS_RESEARCH_RUNTIME_STATE_INVALID");
  const timestamp = requiredTimestamp(observedAt, "observedAt");
  let inspection;
  if (!job?.jobId || !MARKETS.has(job.market)) throw new Error("AUTONOMOUS_RESEARCH_JOB_REQUIRED");
  if (!adapter || adapter.market !== job.market || adapter.state !== "AVAILABLE") {
    inspection = blockedInspection(job, adapter, timestamp, "DATA_ADAPTER_UNAVAILABLE");
  } else if (typeof inspectDataset !== "function") {
    inspection = blockedInspection(job, adapter, timestamp, "DATA_ADAPTER_RUNTIME_CALLBACK_REQUIRED");
  } else {
    try {
      const raw = await inspectDataset({ job, adapter });
      inspection = validateDatasetInspection(job, adapter, raw, timestamp);
    } catch (error) {
      inspection = blockedInspection(job, adapter, timestamp, safeFailureCode(error, "DATA_ADAPTER_CALL_FAILED"));
    }
  }
  const next = nextRuntime(state, {
    datasetInspections: { ...state.datasetInspections, [job.jobId]: inspection },
    events: [...state.events, Object.freeze({ type: "DATASET_PREFLIGHT", jobId: job.jobId, status: inspection.status, reason: inspection.reason, observedAt: timestamp })],
  });
  return Object.freeze({ state: next, inspection, status: inspection.status });
}

export function buildAutonomousFeatureCacheKey(input = {}) {
  const market = requiredText(input.market, "market").toUpperCase();
  if (!MARKETS.has(market)) throw new RangeError("feature cache market is unsupported");
  const core = Object.freeze({
    datasetId: requiredText(input.datasetId, "datasetId"),
    market,
    symbol: requiredText(input.symbol, "symbol"),
    timeframe: requiredText(input.timeframe, "timeframe"),
    featureVersion: requiredText(input.featureVersion, "featureVersion"),
    asOf: requiredTimestamp(input.asOf, "asOf"),
  });
  return Object.freeze({ ...core, cacheKey: `feature-cache-v1:${researchDigest(core)}` });
}

export function verifyAutonomousFeatureCacheEntry(entry) {
  if (!entry?.cacheKey || !entry.entryDigest || !DIGEST64.test(entry.datasetFingerprint ?? "")) return false;
  const core = Object.freeze({
    cacheKey: entry.cacheKey,
    identity: entry.identity,
    requestedFeatures: entry.requestedFeatures,
    datasetFingerprint: entry.datasetFingerprint,
    sourceMaxTimestamp: entry.sourceMaxTimestamp,
    featureBundle: entry.featureBundle,
    createdAt: entry.createdAt,
  });
  return entry.entryDigest === researchDigest(core)
    && Date.parse(entry.sourceMaxTimestamp) <= Date.parse(entry.identity?.asOf ?? "invalid");
}

function normalizeRequestedFeatures(features) {
  if (!Array.isArray(features) || !features.length) throw new TypeError("requestedFeatures is required");
  const values = [...new Set(features.map((value) => requiredText(value, "feature").toUpperCase()))].sort();
  for (const value of values) if (!AUTONOMOUS_FEATURE_TYPES.includes(value)) throw new Error(`FEATURE_NOT_SUPPORTED:${value}`);
  return Object.freeze(values);
}

export async function accessAutonomousFeatureCache(state, input = {}, computeFeatureBundle) {
  if (!verifyAutonomousResearchRuntimeState(state)) throw new Error("AUTONOMOUS_RESEARCH_RUNTIME_STATE_INVALID");
  const identity = buildAutonomousFeatureCacheKey(input);
  const requestedFeatures = normalizeRequestedFeatures(input.requestedFeatures);
  const known = state.featureCache[identity.cacheKey];
  if (known) {
    if (!verifyAutonomousFeatureCacheEntry(known)) throw new Error("FEATURE_CACHE_INTEGRITY_FAILED");
    return Object.freeze({
      state: nextRuntime(state, { counters: { ...state.counters, cacheHits: state.counters.cacheHits + 1 } }),
      status: "CACHE_HIT",
      entry: known,
    });
  }
  if (typeof computeFeatureBundle !== "function") throw new Error("FEATURE_COMPUTE_RUNTIME_CALLBACK_REQUIRED");
  const raw = await computeFeatureBundle({ identity, requestedFeatures, datasetInspection: input.datasetInspection });
  const sourceMaxTimestamp = requiredTimestamp(raw?.sourceMaxTimestamp, "feature.sourceMaxTimestamp");
  if (Date.parse(sourceMaxTimestamp) > Date.parse(identity.asOf)) throw new Error("PIT_LEAK_DETECTED");
  const datasetFingerprint = requiredText(raw?.datasetFingerprint, "feature.datasetFingerprint").toLowerCase();
  if (datasetFingerprint !== input.datasetInspection?.dataFingerprint) throw new Error("FEATURE_DATASET_FINGERPRINT_MISMATCH");
  const bundle = immutableJson(raw?.features, "feature.features");
  for (const feature of requestedFeatures) if (!(feature in bundle)) throw new Error(`FEATURE_OUTPUT_MISSING:${feature}`);
  const core = Object.freeze({
    cacheKey: identity.cacheKey,
    identity,
    requestedFeatures,
    datasetFingerprint,
    sourceMaxTimestamp,
    featureBundle: bundle,
    createdAt: requiredTimestamp(input.observedAt, "observedAt"),
  });
  const entry = Object.freeze({ ...core, entryDigest: researchDigest(core) });
  const next = nextRuntime(state, {
    featureCache: { ...state.featureCache, [identity.cacheKey]: entry },
    counters: { ...state.counters, cacheMisses: state.counters.cacheMisses + 1 },
    events: [...state.events, Object.freeze({ type: "FEATURE_CACHE_STORED", cacheKey: identity.cacheKey, observedAt: core.createdAt })],
  });
  return Object.freeze({ state: next, status: "CACHE_MISS_STORED", entry });
}

function workerCheckpoint(job, stage, observedAt, previous = null, terminal = false) {
  const core = Object.freeze({
    jobId: job.jobId,
    strategyIdentity: job.identity.candidateIdentityDigest,
    datasetId: job.datasetId,
    researchCodeSha: job.researchCodeSha,
    stage,
    attempts: previous?.attempts ?? 1,
    observedAt,
    terminal,
  });
  return Object.freeze({ ...core, checkpointDigest: researchDigest(core) });
}

function terminalWorkerCheckpoint(job, previous, observedAt, reference = {}) {
  const core = Object.freeze({
    jobId: job.jobId,
    strategyIdentity: job.identity.candidateIdentityDigest,
    datasetId: job.datasetId,
    researchCodeSha: job.researchCodeSha,
    stage: previous.stage,
    attempts: previous.attempts,
    observedAt,
    terminal: true,
    resultDigest: reference.resultDigest ?? null,
    failureDigest: reference.failureDigest ?? null,
  });
  return Object.freeze({ ...core, checkpointDigest: researchDigest(core) });
}

function advanceWorker(state, job, stage, observedAt) {
  const previous = state.workerCheckpoints[job.jobId] ?? null;
  const previousIndex = previous ? AUTONOMOUS_RUNTIME_WORKER_STAGES.indexOf(previous.stage) : -1;
  const nextIndex = AUTONOMOUS_RUNTIME_WORKER_STAGES.indexOf(stage);
  if (nextIndex < 0 || nextIndex < previousIndex) throw new Error("RUNTIME_WORKER_STAGE_REGRESSION_FORBIDDEN");
  const checkpoint = workerCheckpoint(job, stage, observedAt, previous);
  return nextRuntime(state, {
    workerCheckpoints: { ...state.workerCheckpoints, [job.jobId]: checkpoint },
    events: [...state.events, Object.freeze({ type: "WORKER_STAGE", jobId: job.jobId, stage, observedAt })],
  });
}

export function checkpointAutonomousRuntimeWorkerForRestart(state, job, { stage = "BACKTEST_EXECUTION", observedAt } = {}) {
  if (!verifyAutonomousResearchRuntimeState(state)) throw new Error("AUTONOMOUS_RESEARCH_RUNTIME_STATE_INVALID");
  const timestamp = requiredTimestamp(observedAt, "observedAt");
  let next = state.workerCheckpoints[job?.jobId] ? state : advanceWorker(state, job, "QUEUE_JOB", timestamp);
  const targetIndex = AUTONOMOUS_RUNTIME_WORKER_STAGES.indexOf(stage);
  for (let index = 1; index <= targetIndex; index += 1) {
    const target = AUTONOMOUS_RUNTIME_WORKER_STAGES[index];
    if (AUTONOMOUS_RUNTIME_WORKER_STAGES.indexOf(next.workerCheckpoints[job.jobId].stage) < index) next = advanceWorker(next, job, target, timestamp);
  }
  return next;
}

export function recoverAutonomousRuntimeWorkers(state, { recoveredAt } = {}) {
  if (!verifyAutonomousResearchRuntimeState(state)) throw new Error("AUTONOMOUS_RESEARCH_RUNTIME_STATE_INVALID");
  const timestamp = requiredTimestamp(recoveredAt, "recoveredAt");
  const retryQueue = { ...state.retryQueue };
  const checkpoints = { ...state.workerCheckpoints };
  for (const checkpoint of Object.values(checkpoints)) {
    if (checkpoint.terminal) continue;
    const retryCore = Object.freeze({ jobId: checkpoint.jobId, state: "RETRY_LATER", resumeFrom: checkpoint.stage, attempts: checkpoint.attempts, recoveredAt: timestamp });
    retryQueue[checkpoint.jobId] = Object.freeze({ ...retryCore, retryDigest: researchDigest(retryCore) });
    checkpoints[checkpoint.jobId] = Object.freeze({ ...checkpoint, attempts: checkpoint.attempts + 1, observedAt: timestamp, checkpointDigest: researchDigest({
      jobId: checkpoint.jobId,
      strategyIdentity: checkpoint.strategyIdentity,
      datasetId: checkpoint.datasetId,
      researchCodeSha: checkpoint.researchCodeSha,
      stage: checkpoint.stage,
      attempts: checkpoint.attempts + 1,
      observedAt: timestamp,
      terminal: false,
    }) });
  }
  return nextRuntime(state, {
    retryQueue,
    workerCheckpoints: checkpoints,
    events: [...state.events, Object.freeze({ type: "WORKER_RESTART_RECOVERY", recoveredAt: timestamp, recoveredJobs: Object.keys(retryQueue).length })],
  });
}

function durationMs(startedAt, completedAt) {
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(duration) || duration < 0) throw new Error("WORKER_DURATION_INVALID");
  return duration;
}

function failWorker(state, job, { reason, failedAt, startedAt }) {
  const failureCore = Object.freeze({
    jobId: job.jobId,
    strategyIdentity: job.identity.candidateIdentityDigest,
    datasetId: job.datasetId,
    researchCodeSha: job.researchCodeSha,
    status: "FAILED",
    reason,
    timestamp: failedAt,
    durationMs: durationMs(startedAt, failedAt),
  });
  const failure = Object.freeze({ ...failureCore, failureDigest: researchDigest(failureCore) });
  const previous = state.workerCheckpoints[job.jobId] ?? workerCheckpoint(job, "QUEUE_JOB", startedAt);
  const terminal = terminalWorkerCheckpoint(job, previous, failedAt, { failureDigest: failure.failureDigest });
  return Object.freeze({
    state: nextRuntime(state, {
      failedJobs: { ...state.failedJobs, [job.jobId]: failure },
      failureHistory: [...state.failureHistory, failure],
      workerCheckpoints: { ...state.workerCheckpoints, [job.jobId]: terminal },
      events: [...state.events, Object.freeze({ type: "WORKER_FAILED", jobId: job.jobId, reason, observedAt: failedAt })],
      lastResearchTime: failedAt,
    }),
    status: "FAILED",
    reason,
    result: null,
    failure,
  });
}

export async function executeAutonomousResearchWorkerRuntime(state, input = {}, dependencies = {}) {
  if (!verifyAutonomousResearchRuntimeState(state)) throw new Error("AUTONOMOUS_RESEARCH_RUNTIME_STATE_INVALID");
  const job = input.job;
  if (!job?.jobId || !job.identity) throw new Error("AUTONOMOUS_RESEARCH_JOB_REQUIRED");
  if (state.completedJobs[job.jobId]) return Object.freeze({ state, status: "DUPLICATE_RESULT", result: state.completedJobs[job.jobId].result });
  if (state.failedJobs[job.jobId] && input.retryFailed !== true) return Object.freeze({ state, status: "DUPLICATE_FAILURE", result: null, failure: state.failedJobs[job.jobId] });
  const startedAt = requiredTimestamp(input.startedAt, "startedAt");
  const completedAt = requiredTimestamp(input.completedAt, "completedAt");
  const elapsed = durationMs(startedAt, completedAt);
  let runtime;
  if (state.failedJobs[job.jobId] && input.retryFailed === true) {
    const previous = state.workerCheckpoints[job.jobId];
    const checkpoint = workerCheckpoint(job, "QUEUE_JOB", startedAt, { attempts: (previous?.attempts ?? 0) + 1 });
    runtime = nextRuntime(state, {
      workerCheckpoints: { ...state.workerCheckpoints, [job.jobId]: checkpoint },
      events: [...state.events, Object.freeze({ type: "WORKER_RETRY_STARTED", jobId: job.jobId, attempts: checkpoint.attempts, observedAt: startedAt })],
    });
  } else {
    runtime = advanceWorker(state, job, "QUEUE_JOB", startedAt);
  }
  if (elapsed > (input.maxRuntimeMs ?? Number.MAX_SAFE_INTEGER)) return failWorker(runtime, job, { reason: "WORKER_TIMEOUT", failedAt: completedAt, startedAt });
  try {
    runtime = advanceWorker(runtime, job, "DATA_PREFLIGHT", startedAt);
    const data = await inspectAutonomousDatasetRuntime(runtime, { job, adapter: input.dataAdapter, observedAt: startedAt }, dependencies.inspectDataset);
    runtime = data.state;
    if (data.status !== "READY") return failWorker(runtime, job, { reason: data.inspection.reason ?? "BLOCKED_DATA", failedAt: completedAt, startedAt });

    runtime = advanceWorker(runtime, job, "FEATURE_CACHE_CHECK", startedAt);
    const features = await accessAutonomousFeatureCache(runtime, {
      datasetId: job.datasetId,
      market: job.market,
      symbol: job.universeId,
      timeframe: job.timeframe,
      featureVersion: requiredText(input.featureVersion, "featureVersion"),
      asOf: data.inspection.asOf,
      observedAt: startedAt,
      requestedFeatures: input.requestedFeatures,
      datasetInspection: data.inspection,
    }, dependencies.computeFeatureBundle);
    runtime = features.state;

    runtime = advanceWorker(runtime, job, "STRATEGY_COMPILE", startedAt);
    if (typeof dependencies.compileStrategySpecification !== "function") throw new Error("STRATEGY_COMPILE_RUNTIME_CALLBACK_REQUIRED");
    const compiled = await dependencies.compileStrategySpecification({ job, featureEntry: features.entry });
    if (compiled?.status !== "COMPILED" || compiled?.candidateIdentity !== job.identity.candidateIdentityDigest) throw new Error("INVALID_DSL");

    runtime = advanceWorker(runtime, job, "BACKTEST_EXECUTION", startedAt);
    const result = await executeAutonomousResearchJob(job, dependencies.backtestDependencies);
    runtime = advanceWorker(runtime, job, "COST_MODEL", completedAt);
    runtime = advanceWorker(runtime, job, "STATISTICS", completedAt);

    runtime = advanceWorker(runtime, job, "EVIDENCE_ARTIFACT", completedAt);
    if (typeof dependencies.persistEvidenceArtifact !== "function") throw new Error("EVIDENCE_ARTIFACT_RUNTIME_CALLBACK_REQUIRED");
    const evidenceArtifact = await dependencies.persistEvidenceArtifact({ job, result, dataInspection: data.inspection, featureEntry: features.entry });
    if (!evidenceArtifact?.artifactDigest) throw new Error("EVIDENCE_ARTIFACT_PERSISTENCE_FAILED");

    runtime = advanceWorker(runtime, job, "NEXT_STAGE", completedAt);
    const nextStage = typeof dependencies.resolveNextStage === "function" ? await dependencies.resolveNextStage({ job, result }) : Object.freeze({ status: result.status, frozenCandidate: false });
    const completedCore = Object.freeze({
      jobId: job.jobId,
      strategyIdentity: job.identity.candidateIdentityDigest,
      datasetId: job.datasetId,
      researchCodeSha: job.researchCodeSha,
      durationMs: elapsed,
      status: result.status,
      result,
      evidenceArtifact,
      nextStage,
      completedAt,
    });
    const completed = Object.freeze({ ...completedCore, completedDigest: researchDigest(completedCore) });
    const checkpoint = terminalWorkerCheckpoint(job, runtime.workerCheckpoints[job.jobId], completedAt, { resultDigest: result.resultDigest });
    const counters = {
      ...runtime.counters,
      backtestCount: runtime.counters.backtestCount + 1,
      oosCount: runtime.counters.oosCount + (result.evidence?.oos ? 1 : 0),
      wfoCount: runtime.counters.wfoCount + (result.evidence?.walkForward ? 1 : 0),
      frozenCount: runtime.counters.frozenCount + (nextStage?.frozenCandidate === true ? 1 : 0),
    };
    const next = nextRuntime(runtime, {
      completedJobs: { ...runtime.completedJobs, [job.jobId]: completed },
      workerCheckpoints: { ...runtime.workerCheckpoints, [job.jobId]: checkpoint },
      retryQueue: Object.fromEntries(Object.entries(runtime.retryQueue).filter(([jobId]) => jobId !== job.jobId)),
      counters,
      lastResearchTime: completedAt,
      newResearchCount: runtime.newResearchCount + 1,
      events: [...runtime.events, Object.freeze({ type: "WORKER_COMPLETED", jobId: job.jobId, status: result.status, observedAt: completedAt })],
    });
    return Object.freeze({ state: next, status: result.status, result, dataInspection: data.inspection, featureCache: features.status, evidenceArtifact, nextStage, completed });
  } catch (error) {
    return failWorker(runtime, job, { reason: safeFailureCode(error, "WORKER_RUNTIME_FAILED"), failedAt: completedAt, startedAt });
  }
}

function known(value) {
  return value === undefined || value === null ? "NOT_AVAILABLE" : value;
}

function currentAiStatus(calls, prefix) {
  const relevant = calls.filter((call) => call.slot.startsWith(prefix));
  if (!relevant.length) return "NOT_AVAILABLE";
  const latestTimestamp = relevant.map((call) => call.timestamp).sort().at(-1);
  const latest = relevant.filter((call) => call.timestamp === latestTimestamp);
  if (latest.every((call) => call.status === "COMPLETED")) return "AVAILABLE";
  if (latest.some((call) => call.status === "FAILED")) return "FAILED";
  return "AI_RESEARCH_UNAVAILABLE";
}

export function buildAutonomousResearchRuntimeStatus(state, input = {}) {
  if (!verifyAutonomousResearchRuntimeState(state)) throw new Error("AUTONOMOUS_RESEARCH_RUNTIME_STATE_INVALID");
  const cacheRequests = state.counters.cacheHits + state.counters.cacheMisses;
  const runningWorkers = Object.values(state.workerCheckpoints).filter((checkpoint) => checkpoint.terminal !== true).length;
  return Object.freeze({
    schemaVersion: 1,
    generatedAt: requiredTimestamp(input.generatedAt, "generatedAt"),
    collectorStatus: known(input.collectorStatus),
    lastResearchTime: known(state.lastResearchTime),
    newResearchCount: known(state.newResearchCount),
    AI1Status: currentAiStatus(state.aiCalls, "AI1_"),
    AI2Status: currentAiStatus(state.aiCalls, "AI2_"),
    queueDepth: known(input.queueDepth),
    runningWorkers,
    completedJobs: Object.keys(state.completedJobs).length,
    failedJobs: Object.keys(state.failedJobs).length,
    cacheHitRate: cacheRequests === 0 ? "NOT_AVAILABLE" : state.counters.cacheHits / cacheRequests,
    candidateCount: known(input.candidateCount),
    backtestCount: known(state.counters.backtestCount),
    OOSCount: known(state.counters.oosCount),
    WFOCount: known(state.counters.wfoCount),
    FrozenCount: known(state.counters.frozenCount),
    ShadowReadyCount: known(state.counters.shadowReadyCount),
    PaperReadyCount: known(state.counters.paperReadyCount),
    missingRenderedAsZero: false,
    readOnly: true,
    safety: safetyEnvelope(),
  });
}

export function buildAutonomousResearchRuntimeReadiness(input = {}) {
  const flags = Object.freeze({
    AI_RUNTIME_CONNECTED: input.AI_RUNTIME_CONNECTED === true,
    DATA_ADAPTER_CONNECTED: input.DATA_ADAPTER_CONNECTED === true,
    QUEUE_RUNTIME_CONNECTED: input.QUEUE_RUNTIME_CONNECTED === true,
    BACKTEST_WORKER_CONNECTED: input.BACKTEST_WORKER_CONNECTED === true,
    EVIDENCE_PIPELINE_CONNECTED: input.EVIDENCE_PIPELINE_CONNECTED === true,
    STATUS_MODEL_CONNECTED: input.STATUS_MODEL_CONNECTED === true,
    RESTART_SAFETY_VERIFIED: input.RESTART_SAFETY_VERIFIED === true,
    END_TO_END_RUNTIME_TEST_PASS: input.END_TO_END_RUNTIME_TEST_PASS === true,
  });
  return Object.freeze({
    schemaVersion: 1,
    ...flags,
    AUTONOMOUS_RESEARCH_FACTORY_RUNTIME_READY: Object.values(flags).every(Boolean),
    AUTONOMOUS_RESEARCH_FACTORY_ACTIVE: false,
    requiresSeparateActivationApproval: true,
    deploymentRequested: false,
    serverRestartRequested: false,
    timerActivationRequested: false,
    safety: safetyEnvelope(),
  });
}

export function buildAutonomousResearchRuntimeProductionPlan({ stateRoot = null, ownerRef = "#226" } = {}) {
  return Object.freeze({
    schemaVersion: 1,
    ownerRef: requiredText(ownerRef, "ownerRef"),
    serviceMode: "ALWAYS_ON_24X7",
    activationStatus: "PLAN_ONLY",
    stateRoot,
    executableWhenSeparatelyApproved: typeof stateRoot === "string" && stateRoot.trim().length > 0,
    aiRuntime: Object.freeze({ providerCount: 2, billingTier: "FREE_ONLY", paidFallbackAllowed: false, unavailableState: "WAITING_FOR_AI", retryState: "RETRY_LATER" }),
    dataRuntime: Object.freeze({ markets: Object.freeze([...MARKETS]), missingState: "BLOCKED_DATA", pointInTimeRequired: true, exactFingerprintRequired: true }),
    workerRuntime: Object.freeze({ canonicalOwner: "#226", stages: AUTONOMOUS_RUNTIME_WORKER_STAGES, boundedConcurrency: true, timeoutRequired: true, failureIsolation: true }),
    featureCache: Object.freeze({ features: AUTONOMOUS_FEATURE_TYPES, exactIdentityRequired: true, pointInTimeRequired: true, integrityDigestRequired: true }),
    evidenceRuntime: Object.freeze({ canonicalDedupOwner: "#482", immutableArtifactRequired: true, failedWorkPreserved: true }),
    checkpointRuntime: Object.freeze({ restartSafe: true, monotonicStages: true, terminalIdempotency: true, retryAuditPreserved: true }),
    readOnlyStatusRuntime: Object.freeze({ missingValue: "NOT_AVAILABLE", fabricatedZeroAllowed: false, mutationAuthority: "NONE" }),
    deploymentRequested: false,
    serverRestartRequested: false,
    timerActivationRequested: false,
    shadowActivationRequested: false,
    paperActivationRequested: false,
    scannerEligibilityRequested: false,
    safety: safetyEnvelope(),
  });
}
