import {
  createGlobalStrategyResearchRegistry,
  verifyGlobalStrategyResearchRegistry,
} from "./global-alpha-literature-registry-v1.js";
import {
  admitCollectorRecordToRegistry,
  createGlobalResearchCollector,
  ingestGlobalResearchMetadata,
  verifyGlobalResearchCollector,
} from "./autonomous-global-research-collector-v1.js";
import {
  classifyStrategyNovelty,
  createBoundedStrategyCandidate,
  createBoundedStrategySpecification,
  createDualFreeAiReviewPlan,
  recordDualFreeAiReview,
  synthesizeDualFreeAiReview,
} from "./autonomous-strategy-formula-generator-v1.js";
import {
  buildAutonomousResearchJob,
  claimNextAutonomousResearchJob,
  createAutonomousResearchQueue,
  enqueueAutonomousResearchJob,
  executeAutonomousResearchJob,
  finalizeAutonomousResearchJob,
  recordAutonomousResearchResultEvidence,
  verifyAutonomousResearchQueue,
} from "./autonomous-research-dispatcher-v1.js";
import {
  buildAutonomousResearchFactoryStatus,
  freezeAutonomousResearchCandidate,
} from "./autonomous-research-lifecycle-v1.js";
import {
  createGlobalEvidenceLedger,
  verifyGlobalEvidenceLedger,
} from "./global-evidence-dedup-ledger-v1.js";
import { researchDigest } from "./research-trial-registry.js";

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function requiredTimestamp(value, name) {
  const text = requiredText(value, name);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${name} must be a timestamp`);
  return new Date(text).toISOString();
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) throw new RangeError(`${name} must be between 1 and ${maximum}`);
  return value;
}

function safetyEnvelope() {
  return Object.freeze({
    AUTONOMOUS_RESEARCH_FACTORY_ACTIVE: false,
    LIVE_TRADING: false,
    AUTO_TRADING: false,
    REAL_ORDER_ENABLED: false,
    PRIVATE_TRADING_API_ALLOWED: false,
    finalHoldoutOpened: false,
    shadowActivated: false,
    paperActivated: false,
    scannerEligibilityActivated: false,
    orderSubmitted: false,
  });
}

function factoryCore({ factoryId, collector, registry, queue, evidenceLedger, cycleNumber, lastCycleAt, knownCandidates, trialFingerprints, rejectedFingerprints, activeCandidateFingerprints }) {
  return Object.freeze({
    schemaVersion: 1,
    factoryId,
    collector,
    registry,
    queue,
    evidenceLedger,
    cycleNumber,
    lastCycleAt,
    knownCandidates,
    trialFingerprints,
    rejectedFingerprints,
    activeCandidateFingerprints,
    canonicalOwners: Object.freeze({ registry: "#543", aiCommittee: "#548", queueBacktestCache: "#226", evidenceDedup: "#482", lifecycle: "ADAPTER_ONLY" }),
    safety: safetyEnvelope(),
  });
}

function withFactoryDigest(core) {
  return Object.freeze({ ...core, factoryStateDigest: researchDigest(core) });
}

export function createAutonomousGlobalResearchFactoryState({
  factoryId = "AUTONOMOUS_GLOBAL_STRATEGY_RESEARCH_FACTORY_V1",
  collector = createGlobalResearchCollector(),
  registry = createGlobalStrategyResearchRegistry(),
  queue = createAutonomousResearchQueue(),
  evidenceLedger = createGlobalEvidenceLedger(),
} = {}) {
  return withFactoryDigest(factoryCore({
    factoryId: requiredText(factoryId, "factoryId"),
    collector,
    registry,
    queue,
    evidenceLedger,
    cycleNumber: 0,
    lastCycleAt: null,
    knownCandidates: Object.freeze([]),
    trialFingerprints: Object.freeze([]),
    rejectedFingerprints: Object.freeze([]),
    activeCandidateFingerprints: Object.freeze([]),
  }));
}

export function verifyAutonomousGlobalResearchFactoryState(state) {
  if (!state || state.schemaVersion !== 1 || !verifyGlobalResearchCollector(state.collector) || !verifyGlobalStrategyResearchRegistry(state.registry)) return false;
  if (!verifyAutonomousResearchQueue(state.queue) || !verifyGlobalEvidenceLedger(state.evidenceLedger).valid) return false;
  if (!Number.isInteger(state.cycleNumber) || state.cycleNumber < 0) return false;
  const core = factoryCore({
    factoryId: state.factoryId,
    collector: state.collector,
    registry: state.registry,
    queue: state.queue,
    evidenceLedger: state.evidenceLedger,
    cycleNumber: state.cycleNumber,
    lastCycleAt: state.lastCycleAt,
    knownCandidates: Object.freeze([...(state.knownCandidates ?? [])]),
    trialFingerprints: Object.freeze([...(state.trialFingerprints ?? [])]),
    rejectedFingerprints: Object.freeze([...(state.rejectedFingerprints ?? [])]),
    activeCandidateFingerprints: Object.freeze([...(state.activeCandidateFingerprints ?? [])]),
  });
  return state.factoryStateDigest === researchDigest(core)
    && state.safety?.AUTONOMOUS_RESEARCH_FACTORY_ACTIVE === false
    && state.safety?.LIVE_TRADING === false;
}

function requireCallback(dependencies, name) {
  if (typeof dependencies?.[name] !== "function") throw new Error(`FACTORY_ADAPTER_REQUIRED:${name}`);
  return dependencies[name];
}

function normalizeDualAiStatus(status) {
  return Object.freeze({
    AI_REVIEW_AGREE: "AI_REVIEW_AGREE",
    AI_REVIEW_CONFLICT: "CONFLICT",
    AI_REVIEW_BOTH_REJECT: "BOTH_REJECT",
    AI_REVIEW_INCOMPLETE: "INCOMPLETE",
  })[status] ?? "INCOMPLETE";
}

function nextFactoryState(state, updates, cycleAt) {
  const core = factoryCore({
    factoryId: state.factoryId,
    collector: updates.collector ?? state.collector,
    registry: updates.registry ?? state.registry,
    queue: updates.queue ?? state.queue,
    evidenceLedger: updates.evidenceLedger ?? state.evidenceLedger,
    cycleNumber: state.cycleNumber + 1,
    lastCycleAt: cycleAt,
    knownCandidates: Object.freeze(updates.knownCandidates ?? [...state.knownCandidates]),
    trialFingerprints: Object.freeze(updates.trialFingerprints ?? [...state.trialFingerprints]),
    rejectedFingerprints: Object.freeze(updates.rejectedFingerprints ?? [...state.rejectedFingerprints]),
    activeCandidateFingerprints: Object.freeze(updates.activeCandidateFingerprints ?? [...state.activeCandidateFingerprints]),
  });
  return withFactoryDigest(core);
}

export function buildAutonomousGlobalResearchLoopContract({ cadenceMs = 300_000, maxDiscoveriesPerCycle = 8, maxJobsPerCycle = 1 } = {}) {
  return Object.freeze({
    schemaVersion: 1,
    serviceMode: "ALWAYS_ON_24X7",
    cadenceMs: positiveInteger(cadenceMs, "cadenceMs"),
    maxDiscoveriesPerCycle: positiveInteger(maxDiscoveriesPerCycle, "maxDiscoveriesPerCycle", 64),
    maxJobsPerCycle: positiveInteger(maxJobsPerCycle, "maxJobsPerCycle", 8),
    cycleFunction: "runAutonomousGlobalResearchFactoryCycle",
    restartSafeStateDigestRequired: true,
    externalTimerOwnerRequired: true,
    timerActivationRequested: false,
    serverActivationRequested: false,
    safety: safetyEnvelope(),
  });
}

export async function runAutonomousGlobalResearchFactoryCycle(state, input = {}, dependencies = {}) {
  if (!verifyAutonomousGlobalResearchFactoryState(state)) throw new Error("AUTONOMOUS_GLOBAL_RESEARCH_FACTORY_STATE_INVALID");
  const cycleAt = requiredTimestamp(input.cycleAt, "cycleAt");
  const loopContract = buildAutonomousGlobalResearchLoopContract(input.loopContract ?? {});
  const discoveryBatch = await requireCallback(dependencies, "discoverResearchMetadata")({
    cursor: state.collector.cursor,
    limit: loopContract.maxDiscoveriesPerCycle,
  });
  if (!Array.isArray(discoveryBatch?.records)) throw new Error("RESEARCH_DISCOVERY_BATCH_INVALID");
  if (discoveryBatch.records.length > loopContract.maxDiscoveriesPerCycle) throw new Error("RESEARCH_DISCOVERY_BATCH_LIMIT_EXCEEDED");

  let collector = state.collector;
  let registry = state.registry;
  let queue = state.queue;
  let evidenceLedger = state.evidenceLedger;
  const discoveries = [];
  const analyses = [];
  const candidates = [];
  const reviews = [];
  const jobs = [];
  const results = [];
  const freezes = [];
  const knownCandidates = [...state.knownCandidates];
  const trialFingerprints = [...state.trialFingerprints];

  for (let index = 0; index < discoveryBatch.records.length; index += 1) {
    const nextCursor = index === discoveryBatch.records.length - 1 ? discoveryBatch.nextCursor ?? collector.cursor : collector.cursor;
    const discovery = ingestGlobalResearchMetadata(collector, discoveryBatch.records[index], { nextCursor });
    collector = discovery.state;
    discoveries.push(Object.freeze({ status: discovery.status, researchSourceId: discovery.record.researchSourceId }));
    if (!new Set(["DISCOVERED", "UPDATED_SOURCE"]).has(discovery.status)) continue;
    const entry = collector.records.find((item) => item.record.researchSourceId === discovery.record.researchSourceId);
    const analysis = await requireCallback(dependencies, "analyzeResearchRecord")(entry.record);
    if (!analysis?.paperGenome || !analysis?.strategySpecification || !analysis?.jobInput) throw new Error("RESEARCH_ANALYSIS_ADAPTER_INVALID");
    registry = admitCollectorRecordToRegistry(registry, entry, { paperGenome: analysis.paperGenome });
    const plan = createDualFreeAiReviewPlan({ evidenceFingerprint: entry.record.sourceFingerprint, providers: input.freeAiProviders ?? [] });
    if (plan.status !== "DUAL_FREE_AI_READY") {
      reviews.push(Object.freeze({ researchSourceId: entry.record.researchSourceId, status: "INCOMPLETE", ai1Review: null, ai2Review: null, reviewConflictReason: "TWO_DISTINCT_FREE_PROVIDERS_UNAVAILABLE" }));
      analyses.push(Object.freeze({ researchSourceId: entry.record.researchSourceId, status: "AI_REVIEW_INCOMPLETE" }));
      continue;
    }
    const recordedReviews = [];
    for (const slot of plan.slots) {
      const raw = await requireCallback(dependencies, "callFreeAiReviewProvider")({ slot, plan, researchRecord: entry.record, analysis });
      recordedReviews.push(recordDualFreeAiReview(plan, raw));
    }
    const synthesis = synthesizeDualFreeAiReview({ plan, reviews: recordedReviews });
    const dualAiStatus = normalizeDualAiStatus(synthesis.status);
    reviews.push(Object.freeze({
      researchSourceId: entry.record.researchSourceId,
      status: dualAiStatus,
      ai1Review: synthesis.ai1Review,
      ai2Review: synthesis.ai2Review,
      reviewConflictReason: synthesis.reviewConflictReason,
      preservedReviewOutputs: synthesis.preservedReviewOutputs,
    }));
    analyses.push(Object.freeze({ researchSourceId: entry.record.researchSourceId, status: synthesis.status }));
    if (dualAiStatus === "BOTH_REJECT" || dualAiStatus === "INCOMPLETE") continue;

    const specification = createBoundedStrategySpecification(analysis.strategySpecification);
    const candidate = createBoundedStrategyCandidate({
      specification,
      generationKind: analysis.generationKind ?? "AI_PROPOSED_RESEARCH_HYPOTHESIS",
      researchSourceLinks: analysis.researchSourceLinks ?? [entry.record.researchSourceId],
      generationReason: analysis.generationReason ?? "BOUNDED_DUAL_AI_RESEARCH_HYPOTHESIS",
      strategyFamilyId: analysis.strategyFamilyId ?? null,
      researchCodeSha: input.researchCodeSha,
      costPolicyVersion: analysis.jobInput.costPolicy?.version,
      dualAiReview: synthesis,
    });
    const novelty = classifyStrategyNovelty(candidate, {
      knownCandidates,
      trialFingerprints,
      rejectedFingerprints: state.rejectedFingerprints,
      activeCandidateFingerprints: state.activeCandidateFingerprints,
    });
    candidates.push(Object.freeze({ candidate, novelty }));
    if (!novelty.enqueueAllowed) continue;
    knownCandidates.push(candidate);
    const job = buildAutonomousResearchJob({
      ...analysis.jobInput,
      candidate,
      evidenceClass: analysis.evidenceClass ?? "AI_HYPOTHESIS",
      noveltyClassification: novelty.status === "KNOWN_VARIANT" ? "KNOWN_VARIANT" : "NOVEL_VARIANT",
      dualAiReviewStatus: dualAiStatus,
      researchCodeSha: input.researchCodeSha,
      submittedAt: cycleAt,
    });
    const enqueued = enqueueAutonomousResearchJob(queue, job);
    queue = enqueued.queue;
    jobs.push(Object.freeze({ jobId: job.jobId, status: enqueued.status }));
    if (enqueued.status === "QUEUED") trialFingerprints.push(novelty.exactFingerprint);
  }

  let jobsExecuted = 0;
  while (jobsExecuted < loopContract.maxJobsPerCycle) {
    const claim = claimNextAutonomousResearchJob(queue, input.resources, { claimedAt: cycleAt });
    queue = claim.queue;
    if (claim.status !== "CLAIMED") {
      if (claim.status === "QUEUE_WAIT") results.push(Object.freeze({ status: "QUEUE_WAIT", reason: claim.reason }));
      break;
    }
    const result = await executeAutonomousResearchJob(claim.job, dependencies.backtestDependencies);
    const finalized = finalizeAutonomousResearchJob(queue, claim.job, result, { completedAt: cycleAt });
    queue = finalized.queue;
    const evidence = recordAutonomousResearchResultEvidence(evidenceLedger, claim.job, result, {
      symbol: claim.job.universeId,
      observationTimestamp: input.evidenceObservationTimestamp ?? cycleAt,
      horizon: claim.job.strategyType,
    });
    evidenceLedger = evidence.ledger;
    const freeze = freezeAutonomousResearchCandidate(claim.job, result, { freezeTimestamp: cycleAt });
    results.push(result);
    freezes.push(freeze);
    jobsExecuted += 1;
  }

  const nextState = nextFactoryState(state, { collector, registry, queue, evidenceLedger, knownCandidates, trialFingerprints }, cycleAt);
  const latestReview = reviews.at(-1) ?? { status: "INCOMPLETE" };
  const status = buildAutonomousResearchFactoryStatus({
    generatedAt: cycleAt,
    codeComplete: true,
    dualAiReview: latestReview,
    evidenceAccounting: {
      externalStudyCount: registry.records.length,
      effectiveIndependentStudyCount: new Set(registry.records.map((record) => record.independenceGroupId ?? record.strategyFamilyId)).size,
      externalObservationN: registry.records.reduce((sum, record) => sum + (record.sourceMetadata?.sampleN ?? 0), 0),
      externalDatasetObservationN: 0,
      ourReplicationN: results.length,
      ourOosN: results.filter((result) => result.evidence?.oos).length,
      ourWalkForwardN: results.reduce((sum, result) => sum + (result.evidence?.walkForward?.metrics?.windowCount ?? 0), 0),
      ourHoldoutN: 0,
      ourShadowN: 0,
      ourPaperN: 0,
      ourSettledN: 0,
    },
    activationReadiness: input.activationReadiness ?? { ready: false, blockers: ["SERVER_ACTIVATION_NOT_APPROVED"] },
  });
  return Object.freeze({
    schemaVersion: 1,
    cycleAt,
    state: nextState,
    discoveries: Object.freeze(discoveries),
    analyses: Object.freeze(analyses),
    reviews: Object.freeze(reviews),
    candidates: Object.freeze(candidates),
    jobs: Object.freeze(jobs),
    results: Object.freeze(results),
    freezes: Object.freeze(freezes),
    status,
    finalHoldoutRequests: Object.freeze([]),
    safety: safetyEnvelope(),
  });
}
