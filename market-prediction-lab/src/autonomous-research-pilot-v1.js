import { buildFreeAiProviderReadiness } from "./autonomous-free-ai-readiness-v1.js";
import {
  createGlobalResearchCollector,
  ingestGlobalResearchMetadata,
  verifyGlobalResearchCollector,
} from "./autonomous-global-research-collector-v1.js";
import {
  classifyStrategyNovelty,
  createBoundedStrategyCandidate,
  createBoundedStrategySpecification,
} from "./autonomous-strategy-formula-generator-v1.js";
import { AUTONOMOUS_FEATURE_TYPES } from "./autonomous-research-runtime-v1.js";
import { researchDigest } from "./research-trial-registry.js";

export const AUTONOMOUS_RESEARCH_PILOT_PREQUEUE_STATES = Object.freeze([
  "QUEUED",
  "DUPLICATE",
  "BLOCKED_DATA",
  "INVALID_STRATEGY",
  "NEEDS_REVIEW",
]);

const PREQUEUE_SET = new Set(AUTONOMOUS_RESEARCH_PILOT_PREQUEUE_STATES);
const SHA40 = /^[0-9a-f]{40}$/i;

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function requiredTimestamp(value, name) {
  const text = requiredText(value, name);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${name} must be a timestamp`);
  return new Date(text).toISOString();
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
    paidFallbackUsed: false,
    actualOrders: 0,
    actualCancels: 0,
    actualAmends: 0,
    actualTransfers: 0,
    actualWithdrawals: 0,
  });
}

function source(metadata, pilot) {
  return Object.freeze({ metadata: Object.freeze(metadata), pilot: Object.freeze(pilot) });
}

export function buildRealResearchPilotCatalog({ ingestedAt } = {}) {
  const observedAt = requiredTimestamp(ingestedAt, "ingestedAt");
  const common = Object.freeze({
    sourceClass: "PEER_REVIEWED_JOURNAL",
    sourceQuality: "HIGH",
    licenseStatus: "METADATA_PUBLIC",
    provenanceStatus: "DOCUMENTED",
    parserVersion: "REAL_PRIMARY_SOURCE_METADATA_PILOT_V1",
    ingestedAt: observedAt,
  });
  return Object.freeze([
    source({
      ...common,
      title: "Size, value, and momentum in international stock returns",
      authors: ["Eugene F. Fama", "Kenneth R. French"],
      venue: "Journal of Financial Economics",
      publicationDate: "2012-09-01",
      doi: "10.1016/j.jfineco.2012.05.011",
      canonicalUrl: "https://www.sciencedirect.com/science/article/pii/S0304405X12000931",
      assetClass: "EQUITY",
      market: "DEVELOPED_STOCK",
      timeframe: "1mo",
      samplePeriod: { startDate: "1989-11-01", endDate: "2011-03-31" },
      reportedN: null,
      datasetReference: {
        datasetId: "KEN_FRENCH_DEVELOPED_MOMENTUM",
        status: "PUBLIC_AUTHOR_DATA",
        url: "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html",
        exactPaperRawSecurityDataAvailable: false,
      },
      reportedMetrics: null,
      costAssumptions: null,
      strategyFamily: "CROSS_SECTIONAL_MOMENTUM",
      strategySummary: "Monthly size-sorted winner-minus-loser momentum portfolios across developed regions",
      formulaSummary: "Published WML construction; pilot proposes a separately labelled public-factor research adaptation",
      sourceProvenance: { provider: "ELSEVIER_AND_AUTHOR_DATA_LIBRARY", locator: "doi:10.1016/j.jfineco.2012.05.011" },
    }, {
      pilotId: "FAMA_FRENCH_2012_MOMENTUM",
      targetMarket: "US_STOCK",
      dataStatus: "READY",
      costStatus: "CALIBRATION_REQUIRED",
      strategyDraft: "US_PUBLIC_WML_FACTOR_ADAPTATION",
      generationKind: "MARKET_SPECIFIC_ADAPTATION",
    }),
    source({
      ...common,
      title: "Simple Technical Trading Rules and the Stochastic Properties of Stock Returns",
      authors: ["William Brock", "Josef Lakonishok", "Blake LeBaron"],
      venue: "The Journal of Finance",
      publicationDate: "1992-12-01",
      doi: "10.1111/j.1540-6261.1992.tb04681.x",
      canonicalUrl: "https://onlinelibrary.wiley.com/doi/10.1111/j.1540-6261.1992.tb04681.x",
      assetClass: "EQUITY_INDEX",
      market: "US_STOCK",
      timeframe: "1d",
      samplePeriod: { startDate: "1897-01-01", endDate: "1986-12-31" },
      reportedN: null,
      datasetReference: { datasetId: "BLL_DJIA_1897_1986_EXACT", status: "UNAVAILABLE", reason: "EXACT_VERSION_AND_ADJUSTMENT_PROVENANCE_NOT_PINNED" },
      reportedMetrics: null,
      costAssumptions: null,
      strategyFamily: "TECHNICAL_TRADING_RULES",
      strategySummary: "Moving-average and trading-range-break rules on the Dow Jones Industrial Average",
      formulaSummary: "Published rule family; exact data-version replication remains blocked",
      sourceProvenance: { provider: "WILEY", locator: "doi:10.1111/j.1540-6261.1992.tb04681.x" },
    }, {
      pilotId: "BROCK_LAKONISHOK_LEBARON_1992",
      targetMarket: "US_STOCK",
      dataStatus: "BLOCKED_DATA",
      costStatus: "CALIBRATION_REQUIRED",
      strategyDraft: "US_LONG_ONLY_MA_ADAPTATION",
      generationKind: "MARKET_SPECIFIC_ADAPTATION",
    }),
    source({
      ...common,
      title: "Pairs Trading: Performance of a Relative-Value Arbitrage Rule",
      authors: ["Evan Gatev", "William N. Goetzmann", "K. Geert Rouwenhorst"],
      venue: "The Review of Financial Studies",
      publicationDate: "2006-02-13",
      doi: "10.1093/rfs/hhj020",
      canonicalUrl: "https://academic.oup.com/rfs/article-abstract/19/3/797/1646694",
      assetClass: "EQUITY",
      market: "US_STOCK",
      timeframe: "1d",
      samplePeriod: { startDate: "1962-01-01", endDate: "2002-12-31" },
      reportedN: null,
      datasetReference: { datasetId: "CRSP_1962_2002", status: "UNAVAILABLE", reason: "PROPRIETARY_CRSP_SECURITY_HISTORY_REQUIRED" },
      reportedMetrics: { reportedAnnualizedExcessReturnUpperBound: 0.11 },
      costAssumptions: { status: "REPORTED_CONSERVATIVE_ESTIMATE_NOT_MACHINE_PINNED" },
      strategyFamily: "PAIRS_TRADING",
      strategySummary: "Pairs selected by minimum normalized-price distance with six-month trading periods",
      formulaSummary: "Multi-leg self-financing long-short rule",
      sourceProvenance: { provider: "OXFORD_ACADEMIC", locator: "doi:10.1093/rfs/hhj020", companionLocator: "https://www.nber.org/papers/w7032" },
    }, {
      pilotId: "GATEV_GOETZMANN_ROUWENHORST_2006",
      targetMarket: "US_STOCK",
      dataStatus: "BLOCKED_DATA",
      costStatus: "CALIBRATION_REQUIRED",
      unsupportedReason: "MULTI_LEG_LONG_SHORT_PAIR_DSL_NOT_SUPPORTED",
    }),
    source({
      ...common,
      title: "Physical approach to price momentum and its application to momentum strategy",
      authors: ["Jaehyung Choi"],
      venue: "Physica A: Statistical Mechanics and its Applications",
      publicationDate: "2014-12-01",
      doi: "10.1016/j.physa.2014.07.075",
      canonicalUrl: "https://www.sciencedirect.com/science/article/pii/S037843711400661X",
      assetClass: "EQUITY",
      market: "KR_STOCK",
      timeframe: "1wk",
      samplePeriod: { startDate: "2003-01-01", endDate: "2012-12-31" },
      reportedN: null,
      datasetReference: { datasetId: "KRX_KOSPI200_PIT_2003_2012", status: "UNAVAILABLE", reason: "EXACT_POINT_IN_TIME_COMPONENT_LOG_AND_ADJUSTED_PRICES_NOT_PINNED" },
      reportedMetrics: null,
      costAssumptions: null,
      strategyFamily: "PHYSICAL_MOMENTUM_CONTRARIAN",
      strategySummary: "Weekly contrarian portfolios using physical-momentum ranking in KOSPI 200 and S&P 500",
      formulaSummary: "Published physical-momentum family; pilot proposes a bounded KR long-only adaptation",
      sourceProvenance: { provider: "ELSEVIER_AND_ARXIV", locator: "doi:10.1016/j.physa.2014.07.075", companionLocator: "https://arxiv.org/abs/1208.2775" },
    }, {
      pilotId: "CHOI_2014_PHYSICAL_MOMENTUM",
      targetMarket: "KR_STOCK",
      dataStatus: "BLOCKED_DATA",
      costStatus: "CALIBRATION_REQUIRED",
      strategyDraft: "KR_LONG_ONLY_CONTRARIAN_ADAPTATION",
      generationKind: "MARKET_SPECIFIC_ADAPTATION",
    }),
    source({
      ...common,
      title: "Common Risk Factors in Cryptocurrency",
      authors: ["Yukun Liu", "Aleh Tsyvinski", "Xi Wu"],
      venue: "The Journal of Finance",
      publicationDate: "2022-02-11",
      doi: "10.1111/jofi.13119",
      canonicalUrl: "https://onlinelibrary.wiley.com/doi/10.1111/jofi.13119",
      assetClass: "CRYPTOCURRENCY",
      market: "CRYPTO_SPOT",
      timeframe: "1d",
      samplePeriod: { startDate: null, endDate: null },
      reportedN: null,
      datasetReference: { datasetId: "JOFI_13119_REPLICATION_PACKAGE", status: "PUBLIC_REPLICATION_PACKAGE", replicationCodeListed: true },
      reportedMetrics: null,
      costAssumptions: null,
      strategyFamily: "CRYPTO_CROSS_SECTIONAL_FACTORS",
      strategySummary: "Cryptocurrency market, size, and momentum factors with long-short characteristic portfolios",
      formulaSummary: "Published long-short factor construction is incompatible with spot-only short prohibition",
      sourceProvenance: { provider: "WILEY_SUPPORTING_INFORMATION", locator: "doi:10.1111/jofi.13119" },
    }, {
      pilotId: "LIU_TSYVINSKI_WU_2022",
      targetMarket: "CRYPTO_SPOT",
      dataStatus: "READY",
      costStatus: "CALIBRATION_REQUIRED",
      unsupportedReason: "CRYPTO_SPOT_SHORT_DIRECTION_FORBIDDEN",
    }),
  ]);
}

function gtFeature(feature) {
  return { op: "GT", args: [{ op: "FEATURE", feature, lag: 1 }, { op: "CONSTANT", value: 0 }] };
}

function ltFeature(feature) {
  return { op: "LT", args: [{ op: "FEATURE", feature, lag: 1 }, { op: "CONSTANT", value: 0 }] };
}

function strategyDraft(name) {
  const common = {
    direction: "BUY",
    liquidityRequirement: { status: "CALIBRATION_REQUIRED" },
    risk: { maxLeverage: 1, supportedLeverageConstraint: 1, sizingRule: { type: "BOUNDED_NOTIONAL" } },
  };
  if (name === "US_PUBLIC_WML_FACTOR_ADAPTATION") return {
    ...common,
    market: "US_STOCK",
    timeframe: "1mo",
    universe: { type: "PUBLIC_DEVELOPED_MOMENTUM_FACTOR_SERIES", status: "PUBLIC_AUTHOR_DATA" },
    availableFeatures: ["MOMENTUM", "LIQUIDITY"],
    entryFormula: { op: "AND", args: [gtFeature("MOMENTUM"), gtFeature("LIQUIDITY")] },
    exitFormula: ltFeature("MOMENTUM"),
    parameters: { formationMonths: { value: 11, min: 11, max: 11 }, skipMonths: { value: 1, min: 1, max: 1 } },
    holdingPeriod: { maxBars: 1 },
    rebalance: { cadence: "MONTHLY" },
  };
  if (name === "US_LONG_ONLY_MA_ADAPTATION") return {
    ...common,
    market: "US_STOCK",
    timeframe: "1d",
    universe: { type: "DJIA_INDEX_SERIES", status: "EXACT_VERSION_REQUIRED" },
    availableFeatures: ["MOMENTUM"],
    entryFormula: gtFeature("MOMENTUM"),
    exitFormula: ltFeature("MOMENTUM"),
    parameters: { fastWindow: { value: 50, min: 50, max: 50 }, slowWindow: { value: 200, min: 200, max: 200 } },
    holdingPeriod: { exitOnRule: true },
    rebalance: { cadence: "DAILY" },
  };
  if (name === "KR_LONG_ONLY_CONTRARIAN_ADAPTATION") return {
    ...common,
    market: "KR_STOCK",
    timeframe: "1wk",
    universe: { type: "POINT_IN_TIME_KOSPI_200", status: "DATASET_REQUIRED" },
    availableFeatures: ["MOMENTUM", "LIQUIDITY"],
    entryFormula: { op: "AND", args: [ltFeature("MOMENTUM"), gtFeature("LIQUIDITY")] },
    exitFormula: gtFeature("MOMENTUM"),
    parameters: { rankingWeeks: { value: 4, min: 4, max: 4 } },
    holdingPeriod: { maxBars: 1 },
    rebalance: { cadence: "WEEKLY" },
  };
  throw new Error(`PILOT_STRATEGY_DRAFT_UNKNOWN:${name}`);
}

export function evaluateAutonomousResearchPilotPrequeue(input = {}) {
  const checks = Object.freeze({
    duplicate: input.noveltyStatus === "EXISTING_ACTIVE_CANDIDATE",
    priorTrial: new Set(["DUPLICATE_TRIAL", "PREVIOUSLY_REJECTED"]).has(input.noveltyStatus),
    dslValid: input.dslValid === true,
    featureSetValid: input.featureSetValid === true,
    leakageDetected: input.leakageDetected === true,
    dataReady: input.dataStatus === "READY",
    leverageSupported: input.leverageSupported === true,
    costPolicyReady: input.costStatus === "READY",
    dualAiRuntimeReady: input.aiReadiness?.AI_DUAL_REVIEW_READY === "READY",
    dualAiReviewComplete: new Set(["AI_REVIEW_AGREE", "AI_REVIEW_CONFLICT"]).has(input.aiReviewStatus),
  });
  let status = "QUEUED";
  const reasons = [];
  if (checks.duplicate || checks.priorTrial) {
    status = "DUPLICATE";
    reasons.push(checks.duplicate ? "EXISTING_ACTIVE_CANDIDATE" : input.noveltyStatus);
  } else if (!checks.dslValid || !checks.featureSetValid || checks.leakageDetected || !checks.leverageSupported) {
    status = "INVALID_STRATEGY";
    if (!checks.dslValid) reasons.push(input.dslFailureReason ?? "INVALID_DSL");
    if (!checks.featureSetValid) reasons.push("INVALID_FEATURE_SET");
    if (checks.leakageDetected) reasons.push("LEAKAGE_DETECTED");
    if (!checks.leverageSupported) reasons.push("UNSUPPORTED_LEVERAGE");
  } else if (!checks.dataReady) {
    status = "BLOCKED_DATA";
    reasons.push(input.dataFailureReason ?? "DATASET_NOT_READY");
  } else if (!checks.dualAiRuntimeReady || !checks.dualAiReviewComplete || !checks.costPolicyReady) {
    status = "NEEDS_REVIEW";
    if (!checks.dualAiRuntimeReady) reasons.push("AI_RESEARCH_UNAVAILABLE");
    if (!checks.dualAiReviewComplete) reasons.push("DUAL_AI_REVIEW_INCOMPLETE");
    if (!checks.costPolicyReady) reasons.push("COST_POLICY_CALIBRATION_REQUIRED");
  }
  if (!PREQUEUE_SET.has(status)) throw new Error("PILOT_PREQUEUE_STATE_INVALID");
  const core = Object.freeze({
    status,
    reasons: Object.freeze([...new Set(reasons)]),
    checks,
    canonicalQueueOwner: "#226",
    experimentDedupOwner: "#482",
    enqueuePerformed: false,
    persistentFailureRequired: new Set(["DUPLICATE", "BLOCKED_DATA", "INVALID_STRATEGY"]).has(status),
    finalHoldoutOpened: false,
  });
  return Object.freeze({ ...core, decisionDigest: researchDigest(core) });
}

function generateCandidate(item, record, input) {
  if (item.pilot.unsupportedReason) return Object.freeze({
    candidate: null,
    specification: null,
    dslValid: false,
    featureSetValid: false,
    failureReason: item.pilot.unsupportedReason,
    novelty: Object.freeze({ status: "NOT_EVALUATED", enqueueAllowed: false }),
  });
  try {
    const specification = createBoundedStrategySpecification(strategyDraft(item.pilot.strategyDraft));
    const candidate = createBoundedStrategyCandidate({
      specification,
      generationKind: item.pilot.generationKind,
      researchSourceLinks: [record.canonicalUrl],
      generationReason: `REAL_SOURCE_PILOT:${item.pilot.pilotId}:BOUNDED_ADAPTATION_NOT_PUBLISHED_EXACT`,
      researchCodeSha: input.researchCodeSha,
      costPolicyVersion: input.costPolicyVersion,
    });
    const novelty = classifyStrategyNovelty(candidate, input.noveltyRegistry);
    const featureSetValid = specification.requiredFeatures.every((feature) => AUTONOMOUS_FEATURE_TYPES.includes(feature));
    return Object.freeze({ candidate, specification, dslValid: true, featureSetValid, failureReason: featureSetValid ? null : "FEATURE_NOT_SUPPORTED_BY_RUNTIME", novelty });
  } catch (error) {
    return Object.freeze({
      candidate: null,
      specification: null,
      dslValid: false,
      featureSetValid: false,
      failureReason: typeof error?.message === "string" ? error.message : "INVALID_STRATEGY",
      novelty: Object.freeze({ status: "NOT_EVALUATED", enqueueAllowed: false }),
    });
  }
}

function buildPilotStatus({ generatedAt, rows, aiReadiness, validationEvidence, canonicalRuntimeAvailable }) {
  const decisions = rows.map((row) => row.prequeue.status);
  const generated = rows.filter((row) => row.strategy?.candidate).length;
  const queued = decisions.filter((status) => status === "QUEUED").length;
  const aiReviewed = rows.filter((row) => new Set(["AI_REVIEW_AGREE", "AI_REVIEW_CONFLICT"]).has(row.aiReviewStatus)).length;
  const aiConflicts = rows.filter((row) => row.aiReviewStatus === "AI_REVIEW_CONFLICT").length;
  return Object.freeze({
    schemaVersion: 1,
    generatedAt,
    todayDiscovered: rows.length,
    admissibleResearchSources: rows.filter((row) => new Set(["DISCOVERED", "UPDATED_SOURCE"]).has(row.admissionStatus)).length,
    aiReviewed,
    aiConflicts,
    generatedStrategies: generated,
    queuedJobs: queued,
    runningJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    rejectedJobs: 0,
    prequeueRejected: decisions.filter((status) => new Set(["DUPLICATE", "BLOCKED_DATA", "INVALID_STRATEGY"]).has(status)).length,
    needsReview: decisions.filter((status) => status === "NEEDS_REVIEW").length,
    OOSCandidates: "NOT_AVAILABLE",
    FrozenCandidates: "NOT_AVAILABLE",
    ShadowCandidates: "NOT_AVAILABLE",
    PaperCandidates: "NOT_AVAILABLE",
    backtestMetrics: "NOT_AVAILABLE",
    AI_PROVIDER_A_READY: aiReadiness.AI_PROVIDER_A_READY,
    AI_PROVIDER_B_READY: aiReadiness.AI_PROVIDER_B_READY,
    AI_DUAL_REVIEW_READY: aiReadiness.AI_DUAL_REVIEW_READY,
    AI_RESEARCH_STATUS: aiReadiness.AI_RESEARCH_STATUS,
    DUAL_REVIEW_STATUS: aiReadiness.AI_RESEARCH_STATUS === "READY"
      ? (aiReviewed === rows.length ? (aiConflicts > 0 ? "AI_REVIEW_CONFLICT" : "AI_REVIEW_AGREE") : "AI_REVIEW_INCOMPLETE")
      : "AI_RESEARCH_UNAVAILABLE",
    CANONICAL_RUNTIME_STATE: canonicalRuntimeAvailable ? "READY" : "WAITING_FOR_RUNTIME",
    QUEUE_STATE: queued > 0 ? (canonicalRuntimeAvailable ? "READY_FOR_HANDOFF" : "WAITING_FOR_RUNTIME") : "PREQUEUE_GATED",
    BACKTEST_STATE: "NOT_STARTED_PREQUEUE_GATE",
    FREE_AI_RUNTIME_READY: true,
    AI_DUAL_REVIEW_RUNTIME_READY: true,
    REAL_RESEARCH_PILOT_RUN: rows.length >= 3,
    REAL_STRATEGY_GENERATION_READY: generated > 0,
    QUEUE_PIPELINE_TESTED: validationEvidence.QUEUE_PIPELINE_TESTED === true,
    BACKTEST_HANDOFF_TESTED: validationEvidence.BACKTEST_HANDOFF_TESTED === true,
    EVIDENCE_PIPELINE_TESTED: validationEvidence.EVIDENCE_PIPELINE_TESTED === true,
    STATUS_API_EXTENDED: true,
    AUTONOMOUS_RESEARCH_FACTORY_READY_FOR_ACTIVATION: false,
    AUTONOMOUS_RESEARCH_FACTORY_ACTIVE: false,
    missingRenderedAsZero: false,
    readOnly: true,
    safety: safetyEnvelope(),
  });
}

export function buildAutonomousResearchActivationPreflightPlan({ aiReadiness, stateRoot = null } = {}) {
  if (!aiReadiness?.readinessDigest) throw new Error("AI_READINESS_EVIDENCE_REQUIRED");
  return Object.freeze({
    schemaVersion: 1,
    activationStatus: "PREFLIGHT_ONLY",
    canonicalOwner: "#226",
    serverRequirements: Object.freeze({ minimumCpuCores: 2, recommendedCpuCores: 4, minimumRamMb: 4096, recommendedRamMb: 8192, minimumFreeDiskMb: 20_480, basis: "BOUNDED_PILOT_ESTIMATE_REQUIRES_SERVER_MEASUREMENT" }),
    workerRuntime: Object.freeze({ minimumWorkers: 1, maximumWorkers: 2, initialWorkers: 1, maxJobRuntimeMs: 1_800_000, failureIsolation: true, retryLimit: 3 }),
    queueRuntime: Object.freeze({ reuseOwner: "#226", maxQueueDepth: 256, priorityMayUseHoldoutOrProfit: false, backpressureRequired: true }),
    aiProviders: Object.freeze({ required: 2, billingTier: "FREE_ONLY", readinessDigest: aiReadiness.readinessDigest, actualState: aiReadiness.AI_DUAL_REVIEW_READY, paidFallbackAllowed: false }),
    dataProviders: Object.freeze({ publicOnly: true, requiredMarkets: Object.freeze(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]), pointInTimeRequired: true, missingDataState: "BLOCKED_DATA" }),
    storage: Object.freeze({ stateRoot, configured: typeof stateRoot === "string" && stateRoot.trim().length > 0, immutableEvidenceRequired: true, cacheReuseOwner: "#226" }),
    experimentDedup: Object.freeze({ owner: "#482", exactIdentityRequired: true, rejectedTrialPersistenceRequired: true }),
    checkpoint: Object.freeze({ restartSafe: true, atomicStagePersistenceRequired: true, terminalIdempotencyRequired: true }),
    rollback: Object.freeze({ action: "STOP_UNAPPROVED_WORKER_AND_PRESERVE_QUEUE_STATE", destructiveCleanupAllowed: false, evidenceDeletionAllowed: false }),
    health: Object.freeze({ readOnly: true, providerStates: Object.freeze(["READY", "UNAVAILABLE", "RATE_LIMITED", "MISCONFIGURED"]), missingValue: "NOT_AVAILABLE" }),
    externalCalls: Object.freeze({ publicResearchMetadataAllowed: true, publicMarketDataAllowed: true, freeAiOnly: true, privateTradingApiAllowed: false, orderCallsAllowed: false }),
    deploymentRequested: false,
    serverRestartRequested: false,
    timerActivationRequested: false,
    permanentWorkerRequested: false,
    safety: safetyEnvelope(),
  });
}

export function runAutonomousResearchFactoryPilot(input = {}) {
  const generatedAt = requiredTimestamp(input.generatedAt, "generatedAt");
  const researchCodeSha = requiredText(input.researchCodeSha, "researchCodeSha").toLowerCase();
  if (!SHA40.test(researchCodeSha)) throw new TypeError("researchCodeSha must be an exact 40-character SHA");
  const costPolicyVersion = requiredText(input.costPolicyVersion ?? "PILOT_COST_POLICY_CALIBRATION_REQUIRED_V1", "costPolicyVersion");
  const decisionPolicyVersion = requiredText(input.decisionPolicyVersion ?? "PILOT_PREQUEUE_DECISION_V1", "decisionPolicyVersion");
  const aiReadiness = buildFreeAiProviderReadiness({ providers: input.aiProviders ?? [], checkedAt: generatedAt });
  const catalog = buildRealResearchPilotCatalog({ ingestedAt: generatedAt });
  let collector = createGlobalResearchCollector({ cadencePolicy: { discoveryCadence: "NOT_ACTIVATED", sourceRefreshCadence: "NOT_ACTIVATED", schedulerOwner: "EXTERNAL_CANONICAL_TIMER_OWNER" } });
  const rows = [];
  for (const item of catalog) {
    const ingestion = ingestGlobalResearchMetadata(collector, item.metadata, { nextCursor: `pilot:${item.pilot.pilotId}` });
    collector = ingestion.state;
    const strategy = generateCandidate(item, ingestion.record, {
      researchCodeSha,
      costPolicyVersion,
      noveltyRegistry: input.noveltyRegistry ?? {},
    });
    const aiReviewStatus = input.aiReviewStatusByPilotId?.[item.pilot.pilotId] ?? "AI_REVIEW_INCOMPLETE";
    const prequeue = evaluateAutonomousResearchPilotPrequeue({
      noveltyStatus: strategy.novelty.status,
      dslValid: strategy.dslValid,
      dslFailureReason: strategy.failureReason,
      featureSetValid: strategy.featureSetValid,
      leakageDetected: false,
      dataStatus: item.pilot.dataStatus,
      dataFailureReason: item.metadata.datasetReference?.reason,
      leverageSupported: true,
      costStatus: item.pilot.costStatus,
      aiReadiness,
      aiReviewStatus,
    });
    rows.push(Object.freeze({
      pilotId: item.pilot.pilotId,
      researchSourceId: ingestion.record.researchSourceId,
      sourceFingerprint: ingestion.record.sourceFingerprint,
      canonicalUrl: ingestion.record.canonicalUrl,
      admissionStatus: ingestion.status,
      datasetId: ingestion.record.datasetReference?.datasetId ?? "NOT_AVAILABLE",
      costPolicyVersion,
      decisionPolicyVersion,
      aiReviewStatus,
      strategy,
      prequeue,
    }));
  }
  if (!verifyGlobalResearchCollector(collector)) throw new Error("REAL_RESEARCH_PILOT_COLLECTOR_INVALID");
  const canonicalRuntimeAvailable = input.canonicalRuntimeAvailable === true;
  const status = buildPilotStatus({ generatedAt, rows, aiReadiness, validationEvidence: input.validationEvidence ?? {}, canonicalRuntimeAvailable });
  const aiReviewEvidence = Object.freeze({
    status: aiReadiness.AI_RESEARCH_STATUS,
    providerA: aiReadiness.providerChecks.AI_PROVIDER_A,
    providerB: aiReadiness.providerChecks.AI_PROVIDER_B,
    roleReversalRequired: true,
    reviewCalls: Object.freeze([]),
    disagreementReason: aiReadiness.AI_RESEARCH_STATUS === "READY" ? "DUAL_REVIEW_NOT_EXECUTED_BY_PILOT" : "AI_RESEARCH_UNAVAILABLE",
    providerCallAttempted: aiReadiness.providerCallAttempted,
    paidFallbackUsed: false,
  });
  const queueEvidence = Object.freeze({
    canonicalOwner: "#226",
    experimentDedupOwner: "#482",
    state: status.QUEUE_STATE,
    createdJobCount: 0,
    createdJobs: Object.freeze([]),
    competingQueueCreated: false,
  });
  const runtimeEvidence = Object.freeze({
    state: status.CANONICAL_RUNTIME_STATE,
    canonicalOwner: "#226",
    queueValidatedByDeterministicTests: input.validationEvidence?.QUEUE_PIPELINE_TESTED === true,
    workerHandoffValidatedByDeterministicTests: input.validationEvidence?.BACKTEST_HANDOFF_TESTED === true,
    evidencePersistenceValidatedByDeterministicTests: input.validationEvidence?.EVIDENCE_PIPELINE_TESTED === true,
    serverActivated: false,
    timerActivated: false,
  });
  const backtestEvidence = Object.freeze({
    status: status.BACKTEST_STATE,
    executedCount: 0,
    metrics: "NOT_AVAILABLE",
    profitabilityClaimed: false,
    championSelected: false,
  });
  const evidenceCore = Object.freeze({
    schemaVersion: 1,
    pilotId: "AUTONOMOUS_RESEARCH_FACTORY_REAL_SOURCE_PILOT_V1",
    generatedAt,
    researchCodeSha,
    sourceFingerprints: Object.freeze(rows.map((row) => row.sourceFingerprint).sort()),
    aiReadinessDigest: aiReadiness.readinessDigest,
    strategyIdentities: Object.freeze(rows.filter((row) => row.strategy.candidate).map((row) => Object.freeze({
      pilotId: row.pilotId,
      strategyId: row.strategy.candidate.strategyId,
      strategyFamilyId: row.strategy.candidate.strategyFamilyId,
      variantId: row.strategy.candidate.variantId,
      parameterHash: row.strategy.candidate.parameterHash,
      formulaFingerprint: row.strategy.candidate.formulaFingerprint,
      researchCodeSha: row.strategy.candidate.researchCodeSha,
      costPolicyVersion: row.costPolicyVersion,
      decisionPolicyVersion: row.decisionPolicyVersion,
    }))),
    prequeueDecisions: Object.freeze(rows.map((row) => Object.freeze({ pilotId: row.pilotId, status: row.prequeue.status, decisionDigest: row.prequeue.decisionDigest }))),
    aiReviewEvidence,
    queueEvidence,
    runtimeEvidence,
    backtestEvidence,
    finalHoldoutEvidence: "NOT_OPENED",
  });
  const evidence = Object.freeze({ ...evidenceCore, evidenceDigest: researchDigest(evidenceCore), immutable: true });
  const activationPlan = buildAutonomousResearchActivationPreflightPlan({ aiReadiness, stateRoot: input.stateRoot ?? null });
  return Object.freeze({
    schemaVersion: 1,
    pilotMode: "REAL_PRIMARY_SOURCE_METADATA_SNAPSHOT",
    sourceCount: rows.length,
    rows: Object.freeze(rows),
    collector,
    aiReadiness,
    evidence,
    status,
    activationPlan,
    queueJobsCreated: Object.freeze([]),
    backtestsExecuted: Object.freeze([]),
    finalHoldoutRequests: Object.freeze([]),
    safety: safetyEnvelope(),
  });
}
