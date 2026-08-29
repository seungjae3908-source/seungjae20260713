import { createHash } from "node:crypto";
import {
  buildCompositeDatasetProvenance,
  sha256Canonical,
  validateCompositeDatasetProvenance,
} from "./research-cache-provenance.js";
import {
  compareCanonicalStrategyIdentities,
  resolveCanonicalStrategyIdentity,
} from "./canonical-strategy-identity-v1.js";
import {
  buildStrategyEvidenceEnvelope,
  STRATEGY_EVIDENCE_ENVELOPE_SCHEMA_VERSION,
} from "./strategy-evidence-envelope-v1.js";

export const BACKTESTER_STRATEGY_EVIDENCE_ADAPTER_SCHEMA_VERSION = "backtester-strategy-evidence-adapter-v1";
export const BACKTESTER_STRATEGY_EVIDENCE_AUTHORITY = "BACKTESTER_STRATEGY_EVIDENCE_ADAPTER_V1";
export const BACKTESTER_ADAPTER_SAFETY = Object.freeze({
  LIVE_TRADING: false,
  AUTO_TRADING: false,
  REAL_ORDER_ENABLED: false,
  PRIVATE_TRADING_API_ALLOWED: false,
  executionAuthority: "NONE",
  orderSubmitted: false,
});

const HASH_64 = /^[0-9a-f]{64}$/iu;
const SHA_40 = /^[0-9a-f]{40}$/iu;
const REQUIRED_STAGES = Object.freeze(["OOS", "WALK_FORWARD", "COST_STRESS", "STATISTICAL_FIREWALL"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const COST_POLICY = deepFreeze({
  costAssumption: "conservative_generic_perpetual_taker_assumption_not_historical_binance_fee_claim",
  entryFeeRate: 0.0006,
  exitFeeRate: 0.0006,
  taxRate: 0,
  slippageRate: 0.0002,
  spreadRate: 0.0002,
  latencyBars: 0,
  latencyDriftRate: 0,
  funding: "actual_same_venue_binance_usdm",
});
const RISK_POLICY = deepFreeze({ riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 });

export const PR191_BACKTESTER_EVIDENCE_CONTRACT_V1 = deepFreeze({
  researchCodeSha: "930857fdd41f629f4c7bb0510f075dfc85b68f3b",
  historicalHarnessSha: "ba181123e6b03c880d9c70174b16ae6eb528700b",
  workflowRunId: 32635101962,
  artifactNumericId: 9492152080,
  artifactArchiveDigest: "93dfe9c78a709ddee42cde7a547f5d58a27e03e44e92af469106ca2f3b447f22",
  costPolicy: COST_POLICY,
  riskPolicy: RISK_POLICY,
  costPolicyVersion: `pr191-cost-policy-v1:${sha256Canonical(COST_POLICY)}`,
  riskPolicyVersion: `pr191-risk-policy-v1:${sha256Canonical(RISK_POLICY)}`,
  resultContracts: {
    V3: {
      file: "V3.raw.json",
      artifactDigest: "39b3275050be798df3fa3922a29a3761d782257c5c2ef49530fccf0a9bbfb3f9",
      legacyResultDigest: "908ea8034d6bdb8062916a0001521c22f132c47dd1e3bcc6189197303b72a4a3",
    },
    V4: {
      file: "V4.raw.json",
      artifactDigest: "a20e652b0730f9dfd938162a7187fd7f5a5ec6db546465dd10ead5209708bb91",
      legacyResultDigest: "b6f2376553e7445dbc4054b7aa29d333b0f48b3843505c1f339eae811023a994",
    },
  },
});

function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function iso(value) {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function unique(values) { return [...new Set(values)].sort(); }
function equalCanonical(left, right) { return sha256Canonical(left) === sha256Canonical(right); }
function finiteOrNull(value) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function exactCostEvidence(metrics = {}) {
  return deepFreeze({
    costPolicyVersion: PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.costPolicyVersion,
    feeAmount: finiteOrNull(metrics.fees),
    spreadAmount: finiteOrNull(metrics.spread),
    slippageAmount: finiteOrNull(metrics.slippage),
    fundingAmount: finiteOrNull(metrics.funding),
    latencyAmount: finiteOrNull(metrics.latency),
  });
}
function missingPathMetrics(metrics = {}) {
  return [
    ...(finiteOrNull(metrics.mae) === null ? ["MAE"] : []),
    ...(finiteOrNull(metrics.mfe) === null ? ["MFE"] : []),
    ...(finiteOrNull(metrics.entryContribution) === null ? ["ENTRY_CONTRIBUTION"] : []),
    ...(finiteOrNull(metrics.exitContribution) === null ? ["EXIT_CONTRIBUTION"] : []),
  ];
}

function normalizeResearchCodeIdentity(value) {
  if (Array.isArray(value)) return value.map(normalizeResearchCodeIdentity);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    ["researchCodeSha", "researchSHA", "collectionCodeSHA"].includes(key)
      && typeof child === "string"
      && SHA_40.test(child)
      ? "<CURRENT_SHA>"
      : normalizeResearchCodeIdentity(child),
  ]));
}

export function backtesterLegacyResultDigestV1(artifactPayload) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  };
  return createHash("sha256")
    .update(JSON.stringify(stable(normalizeResearchCodeIdentity(artifactPayload))))
    .digest("hex");
}

function compositeDatasetIdentity(artifactPayload, source) {
  const start = iso(artifactPayload?.selectionPeriod?.start);
  const end = iso(artifactPayload?.selectionPeriod?.end);
  const provenance = buildCompositeDatasetProvenance({
    datasetId: source?.datasetKey,
    components: {
      candles: source?.sourceDigest,
      funding: source?.fundingDigest,
    },
  });
  const validation = validateCompositeDatasetProvenance(provenance);
  if (validation.valid !== true || validation.status !== "VALID"
    || validation.datasetDigest !== provenance.datasetDigest) {
    throw new TypeError("authoritative composite dataset provenance is invalid");
  }
  return deepFreeze({
    ...provenance,
    datasetStart: start,
    datasetEnd: end,
  });
}

export function buildBacktesterCompositeDatasetIdentityV1(artifactPayload = {}) {
  const sources = (Array.isArray(artifactPayload.results) ? artifactPayload.results : [])
    .map((row) => row?.source)
    .filter(Boolean);
  if (sources.length !== 1) throw new TypeError("exactly one Backtester dataset source is required");
  return compositeDatasetIdentity(artifactPayload, sources[0]);
}

function nestedCandidateRows(artifactPayload) {
  const rows = [];
  for (const result of Array.isArray(artifactPayload?.results) ? artifactPayload.results : []) {
    for (const family of Array.isArray(result?.research?.families) ? result.research.families : []) {
      for (const candidate of Array.isArray(family?.candidates) ? family.candidates : []) {
        rows.push({ candidate, family, research: result.research, source: result.source, group: result.group });
      }
    }
  }
  return rows;
}

function projectedFlatCandidate(nested, group) {
  const oos = nested.oos ?? {};
  return {
    group,
    family: nested.family ?? nested.strategy,
    structuralFamily: nested.structuralFamily,
    version: nested.version,
    candidateId: nested.candidateId,
    market: nested.market,
    symbol: nested.symbol,
    direction: nested.direction,
    parameters: nested.parameters,
    filter: nested.filter,
    developmentTradeCount: nested.development?.tradeCount,
    oosTradeCount: oos.tradeCount,
    wfTradeCount: nested.statisticalQuality?.wfTradeCount,
    expectancy: oos.expectancy,
    profitFactor: oos.profitFactor,
    totalReturn: oos.totalReturn,
    MDD: oos.maximumDrawdown,
    sharpe: oos.sharpe,
    winRate: oos.winRate,
    turnover: oos.turnover,
    statisticalQuality: nested.statisticalQuality,
    concentration: oos.concentration,
    regimePerformance: oos.regimePerformance,
    overfitDiagnostics: nested.overfitDiagnostics,
    wfStability: nested.walkForward?.stability,
    executionCostStress: nested.executionCostStress,
    promotionEligible: nested.promotionEligible,
    promotionBlockReasons: nested.promotionBlockReasons,
    researchStatus: nested.researchStatus,
    finalHoldoutUsed: nested.finalHoldoutUsed,
  };
}

function failure(status, blockers, missingEvidence = []) {
  return deepFreeze({
    schemaVersion: BACKTESTER_STRATEGY_EVIDENCE_ADAPTER_SCHEMA_VERSION,
    status,
    candidate: null,
    blockers: unique(blockers),
    missingEvidence: unique(missingEvidence),
    currentProvisionalChampion: "NONE",
    currentValidatedChampion: "NONE",
    profitabilityProven: false,
    forwardEvidenceSufficient: false,
    executionAuthority: "NONE",
    orderSubmitted: false,
    safety: BACKTESTER_ADAPTER_SAFETY,
  });
}

function stagePayload({
  stage,
  strategyIdentity,
  strategyIdentityDigest,
  sourceSha,
  artifactId,
  artifactDigest,
  artifactPayload,
  measuredAt,
  datasetIdentity,
  sample,
  metrics,
  costs = null,
  validation,
  missingEvidence,
  limitations,
  verdict,
}) {
  const result = buildStrategyEvidenceEnvelope({
    strategyIdentity,
    strategyIdentityDigest,
    evidenceType: "PR191_IMMUTABLE_BACKTEST_RESULT_V1",
    evidenceStage: stage,
    source: "PR191_V34_ONE_PASS_IMMUTABLE_ARTIFACT",
    sourceSha,
    artifactId,
    artifactDigest,
    artifactPayload,
    measuredAt,
    datasetIdentity,
    sample,
    metrics,
    costs,
    validation,
    missingEvidence,
    limitations,
    verdict,
    executionAuthority: "NONE",
  });
  return deepFreeze({ ...result, safety: BACKTESTER_ADAPTER_SAFETY });
}

export function adaptBacktesterStrategyEvidenceV1(input = {}) {
  const blockers = [];
  const missingEvidence = [];
  const artifactPayload = input.artifactPayload;
  const testOnly = input.testOnly === true;
  if (!artifactPayload || typeof artifactPayload !== "object" || Array.isArray(artifactPayload)) {
    return failure("ADAPTER_REJECTED", ["ARTIFACT_PAYLOAD_REQUIRED"]);
  }

  const artifactDigest = HASH_64.test(input.artifactDigest ?? "")
    ? input.artifactDigest.toLowerCase()
    : null;
  const legacyResultDigest = backtesterLegacyResultDigestV1(artifactPayload);
  if (!artifactDigest || (testOnly && artifactDigest !== sha256Canonical(artifactPayload))) {
    blockers.push("ARTIFACT_DIGEST_MISMATCH");
  }
  if (!HASH_64.test(input.legacyResultDigest ?? "") || input.legacyResultDigest.toLowerCase() !== legacyResultDigest) {
    blockers.push("LEGACY_RESULT_DIGEST_MISMATCH");
  }
  if (!HASH_64.test(input.artifactArchiveDigest ?? "")) blockers.push("ARTIFACT_ARCHIVE_DIGEST_INVALID");
  if (!nonEmpty(input.artifactId)) blockers.push("ARTIFACT_ID_REQUIRED");
  if (!SHA_40.test(input.sourceSha ?? "") || input.sourceSha.toLowerCase() !== artifactPayload.researchCodeSha) {
    blockers.push("SOURCE_SHA_MISMATCH");
  }
  if (!SHA_40.test(input.historicalHarnessSha ?? "")) blockers.push("HISTORICAL_HARNESS_SHA_INVALID");

  const nestedMatches = nestedCandidateRows(artifactPayload).filter((row) => row.candidate?.candidateId === input.candidateId);
  const flatMatches = (Array.isArray(artifactPayload.candidates) ? artifactPayload.candidates : [])
    .filter((candidate) => candidate?.candidateId === input.candidateId);
  if (nestedMatches.length !== 1 || flatMatches.length !== 1) blockers.push("STRATEGY_IDENTITY_MISMATCH:CANDIDATE_ID");
  const nestedRow = nestedMatches[0];
  const nested = nestedRow?.candidate;
  const flat = flatMatches[0];
  const version = nested?.version;
  const resultContract = PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.resultContracts[version];
  if (!resultContract) blockers.push("BACKTESTER_VERSION_UNSUPPORTED");

  if (!testOnly && resultContract) {
    const expectedArtifactId = `github-actions:${PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.workflowRunId}/${PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.artifactNumericId}/${resultContract.file}`;
    if (input.artifactId !== expectedArtifactId) blockers.push("ARTIFACT_ID_MISMATCH");
    if (artifactDigest !== resultContract.artifactDigest) blockers.push("ARTIFACT_DIGEST_NOT_CANONICAL_PR191_RESULT");
    if (legacyResultDigest !== resultContract.legacyResultDigest) blockers.push("LEGACY_RESULT_DIGEST_NOT_CANONICAL_PR191_RESULT");
    if (input.artifactArchiveDigest !== PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.artifactArchiveDigest) blockers.push("ARTIFACT_ARCHIVE_DIGEST_MISMATCH");
    if (input.sourceSha !== PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.researchCodeSha) blockers.push("SOURCE_SHA_NOT_CANONICAL_PR191_HEAD");
    if (input.historicalHarnessSha !== PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.historicalHarnessSha) blockers.push("HISTORICAL_HARNESS_SHA_MISMATCH");
  }

  const source = nestedRow?.source;
  const research = nestedRow?.research;
  const family = nestedRow?.family;
  const formulaIdentity = artifactPayload.adapterContracts?.[version];
  if (!source || source.selectionDataStatus !== "DATA_READY" || source.crossVenueMix !== false
    || !HASH_64.test(source.sourceDigest ?? "") || !HASH_64.test(source.fundingDigest ?? "")) {
    blockers.push("DATASET_INTEGRITY_UNPROVEN");
  }
  if (source?.costAssumption !== COST_POLICY.costAssumption) blockers.push("COST_POLICY_IDENTITY_MISMATCH");
  if (!formulaIdentity || !equalCanonical(formulaIdentity, family?.contract)
    || nested?.strategy !== formulaIdentity?.family
    || nested?.structuralFamily !== formulaIdentity?.structuralFamily) {
    blockers.push("STRATEGY_IDENTITY_MISMATCH:FORMULA_IDENTITY");
  }
  if (nested && flat && !equalCanonical(projectedFlatCandidate(nested, nestedRow.group), flat)) {
    blockers.push("ARTIFACT_CANDIDATE_PROJECTION_MISMATCH");
  }
  if (research && nested && (research.market !== nested.market || research.symbol !== nested.symbol
    || research.direction !== nested.direction || research.timeframe !== nested.timeframe)) {
    blockers.push("STRATEGY_IDENTITY_MISMATCH:RESEARCH_SCOPE");
  }

  let derivedDatasetIdentity = null;
  try {
    derivedDatasetIdentity = compositeDatasetIdentity(artifactPayload, source);
    const derivedValidation = validateCompositeDatasetProvenance(derivedDatasetIdentity);
    if (derivedValidation.valid !== true || derivedValidation.status !== "VALID"
      || derivedValidation.datasetDigest !== derivedDatasetIdentity.datasetDigest) {
      blockers.push("DATASET_IDENTITY_INVALID");
    }
  } catch {
    blockers.push("DATASET_IDENTITY_INVALID");
  }
  const suppliedDatasetValidation = validateCompositeDatasetProvenance(input.datasetIdentity);
  if (suppliedDatasetValidation.valid !== true || suppliedDatasetValidation.status !== "VALID") {
    blockers.push(suppliedDatasetValidation.status === "MISSING_EVIDENCE"
      ? "DATASET_IDENTITY_MISSING_EVIDENCE"
      : "DATASET_IDENTITY_MISMATCH");
  }
  let datasetIdentityMatches = false;
  try {
    datasetIdentityMatches = Boolean(derivedDatasetIdentity)
      && equalCanonical(input.datasetIdentity, derivedDatasetIdentity);
  } catch {
    blockers.push("DATASET_IDENTITY_MALFORMED");
  }
  if (!datasetIdentityMatches) {
    blockers.push("DATASET_IDENTITY_MISMATCH");
  }

  const strategyIdentityInput = nested && derivedDatasetIdentity ? {
    strategyId: nested.candidateId,
    strategyFamily: nested.family ?? nested.strategy,
    strategyVersion: nested.version,
    market: nested.market,
    direction: nested.direction,
    timeframe: nested.timeframe,
    formulaIdentity,
    formulaHash: formulaIdentity ? sha256Canonical(formulaIdentity) : null,
    parameterHash: sha256Canonical({ parameters: nested.parameters, filter: nested.filter }),
    researchCodeSha: artifactPayload.researchCodeSha,
    ...derivedDatasetIdentity,
    costPolicyVersion: PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.costPolicyVersion,
    riskPolicyVersion: PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.riskPolicyVersion,
    evidenceSchemaVersion: STRATEGY_EVIDENCE_ENVELOPE_SCHEMA_VERSION,
  } : null;
  const resolvedIdentity = resolveCanonicalStrategyIdentity(strategyIdentityInput ?? {});
  const identityComparison = compareCanonicalStrategyIdentities(strategyIdentityInput ?? {}, input.strategyIdentity ?? {});
  if (resolvedIdentity.status !== "IDENTITY_COMPLETE" || identityComparison.matched !== true) {
    blockers.push("STRATEGY_IDENTITY_MISMATCH");
  }

  const measuredAt = iso(input.measuredAt);
  if (!measuredAt) missingEvidence.push("MEASURED_AT");
  if (artifactPayload.finalHoldoutUsed !== false || artifactPayload.finalHoldoutRead !== false
    || nested?.finalHoldoutUsed !== false || nested?.executionCostStress?.finalHoldoutUsed !== false) {
    blockers.push("FINAL_HOLDOUT_ISOLATION_FAILED");
  }
  if (artifactPayload.privateApiUsed !== false || artifactPayload.orderSubmitted !== false
    || research?.privateApiUsed !== false || research?.orderSubmitted !== false || nested?.orderSubmitted !== false) {
    blockers.push("BACKTESTER_SAFETY_FLAG_MISMATCH");
  }

  const windows = nested?.walkForward?.windows;
  if (!Array.isArray(windows) || windows.length === 0 || windows.some((window) => window?.leakFree !== true)) {
    blockers.push("WALK_FORWARD_LEAKAGE_FAIL_CLOSE");
  }
  if (blockers.length > 0) return failure("ADAPTER_REJECTED", blockers, missingEvidence);
  if (missingEvidence.includes("MEASURED_AT")) return failure("MISSING_EVIDENCE", [], missingEvidence);

  const identity = resolvedIdentity.identity;
  const identityDigest = resolvedIdentity.strategyIdentityDigest;
  const oos = nested.oos;
  const wfStability = nested.walkForward.stability;
  const costStress = nested.executionCostStress;
  const stressed = costStress.stressed;
  const commonValidation = {
    datasetIntegrity: true,
    noFutureLeakage: "UNKNOWN",
    noSameBarLeakage: "UNKNOWN",
  };
  const commonMissing = ["SAMPLE_N", "SETTLED_N", "NO_SAME_BAR_LEAKAGE_EVIDENCE", "NO_FUTURE_LEAKAGE_EVIDENCE"];
  const commonLimitations = [
    "read-only transport of immutable PR #191 Backtester result",
    "no Backtester metric, trade, capital, cost, risk, ranking, or Final Holdout recalculation",
  ];
  const base = {
    strategyIdentity: identity,
    strategyIdentityDigest: identityDigest,
    sourceSha: input.sourceSha,
    artifactId: input.artifactId,
    artifactDigest,
    artifactPayload: testOnly ? artifactPayload : undefined,
    measuredAt,
    datasetIdentity: derivedDatasetIdentity,
    limitations: commonLimitations,
  };

  const evidenceEnvelopes = [
    stagePayload({
      ...base,
      stage: "OOS",
      sample: { sampleN: null, tradeN: oos.tradeCount, settledN: null },
      metrics: {
        netReturn: oos.totalReturn, winRate: oos.winRate, profitFactor: oos.profitFactor,
        expectancy: oos.expectancy, mdd: oos.maximumDrawdown, sharpe: oos.sharpe,
        mae: finiteOrNull(oos.mae), mfe: finiteOrNull(oos.mfe), turnover: oos.turnover,
      },
      costs: exactCostEvidence(oos),
      validation: { ...commonValidation, mddAcceptable: "UNKNOWN" },
      missingEvidence: [...commonMissing, "MDD_ACCEPTABLE", ...missingPathMetrics(oos)],
      verdict: { originalOosMetrics: oos },
    }),
    stagePayload({
      ...base,
      stage: "WALK_FORWARD",
      sample: { sampleN: null, tradeN: nested.statisticalQuality.wfTradeCount, settledN: null },
      metrics: { positiveWindowRatio: wfStability.profitableWindowsRatio },
      validation: { ...commonValidation, noFutureLeakage: true, parameterStability: "UNKNOWN" },
      missingEvidence: [...commonMissing.filter((item) => item !== "NO_FUTURE_LEAKAGE_EVIDENCE"), "PARAMETER_STABILITY"],
      verdict: { originalWalkForwardStability: wfStability, originalWalkForwardWindows: windows },
    }),
    stagePayload({
      ...base,
      stage: "COST_STRESS",
      sample: { sampleN: null, tradeN: stressed.tradeCount, settledN: null },
      metrics: {
        netReturn: stressed.totalReturn, winRate: stressed.winRate, profitFactor: stressed.profitFactor,
        expectancy: stressed.expectancy, mdd: stressed.maximumDrawdown, sharpe: stressed.sharpe,
        mae: finiteOrNull(stressed.mae), mfe: finiteOrNull(stressed.mfe),
        turnover: stressed.turnover, costAdjustedReturn: stressed.totalReturn,
      },
      costs: {
        ...exactCostEvidence(stressed),
        scenarioId: costStress.scenarioId,
        multiplier: costStress.multiplier,
        includes: costStress.includes,
      },
      validation: { ...commonValidation, costStressSurvived: costStress.positiveAfterStress === true },
      missingEvidence: [...commonMissing, ...missingPathMetrics(stressed)],
      verdict: {
        originalStatus: costStress.status,
        originalBaseline: costStress.baseline,
        originalStressed: stressed,
        originalReasons: costStress.reasons,
      },
    }),
    stagePayload({
      ...base,
      stage: "STATISTICAL_FIREWALL",
      sample: { sampleN: null, tradeN: nested.statisticalQuality.totalIndependentTrades, settledN: null },
      metrics: { dsr: null, pbo: null },
      validation: { ...commonValidation, overfitVerdict: "UNKNOWN" },
      missingEvidence: [...commonMissing, "DSR", "PBO", "OVERFIT_VERDICT"],
      verdict: {
        originalStatisticalQuality: nested.statisticalQuality,
        originalOverfitDiagnostics: nested.overfitDiagnostics,
      },
    }),
  ];
  if (evidenceEnvelopes.some((result) => result.status !== "LINKED")) {
    return failure("ADAPTER_REJECTED", evidenceEnvelopes.flatMap((result) => result.blockers),
      evidenceEnvelopes.flatMap((result) => result.missingEvidence));
  }

  const authority = deepFreeze({
    schemaVersion: BACKTESTER_STRATEGY_EVIDENCE_ADAPTER_SCHEMA_VERSION,
    authority: BACKTESTER_STRATEGY_EVIDENCE_AUTHORITY,
    evidenceClass: testOnly ? "TEST_ONLY" : "CANONICAL",
    sourceSha: input.sourceSha,
    historicalHarnessSha: input.historicalHarnessSha,
    artifactId: input.artifactId,
    artifactDigest,
    artifactArchiveDigest: input.artifactArchiveDigest,
    legacyResultDigest,
    strategyIdentityDigest: identityDigest,
    evidenceDigests: evidenceEnvelopes.map((result) => ({
      stage: result.envelope.evidenceStage,
      evidenceDigest: result.evidenceDigest,
    })),
  });
  const candidate = deepFreeze({
    adapterStatus: "ADAPTED",
    strategyIdentity: identity,
    strategyIdentityDigest: identityDigest,
    evidenceEnvelopes,
    canonicalEvidenceAuthority: authority,
    canonicalEvidenceAuthorityDigest: sha256Canonical(authority),
    testOnly,
    profitabilityProven: false,
    forwardEvidenceSufficient: false,
    executionAuthority: "NONE",
    orderSubmitted: false,
    safety: BACKTESTER_ADAPTER_SAFETY,
  });
  return deepFreeze({
    schemaVersion: BACKTESTER_STRATEGY_EVIDENCE_ADAPTER_SCHEMA_VERSION,
    status: "ADAPTED",
    candidate,
    blockers: [],
    missingEvidence: unique(evidenceEnvelopes.flatMap((result) => result.missingEvidence)),
    currentProvisionalChampion: "NONE",
    currentValidatedChampion: "NONE",
    profitabilityProven: false,
    forwardEvidenceSufficient: false,
    executionAuthority: "NONE",
    orderSubmitted: false,
    safety: BACKTESTER_ADAPTER_SAFETY,
  });
}

export function verifyBacktesterStrategyEvidenceAdapterV1(candidate = {}) {
  const blockers = [];
  const authority = candidate.canonicalEvidenceAuthority;
  if (candidate.adapterStatus !== "ADAPTED") blockers.push("ADAPTER_STATUS_INVALID");
  if (authority?.schemaVersion !== BACKTESTER_STRATEGY_EVIDENCE_ADAPTER_SCHEMA_VERSION
    || authority?.authority !== BACKTESTER_STRATEGY_EVIDENCE_AUTHORITY) blockers.push("ADAPTER_AUTHORITY_INVALID");
  if (!authority || candidate.canonicalEvidenceAuthorityDigest !== sha256Canonical(authority)) blockers.push("ADAPTER_AUTHORITY_DIGEST_MISMATCH");
  if (candidate.executionAuthority !== "NONE") blockers.push("EXECUTION_AUTHORITY_FORBIDDEN");
  if (candidate.orderSubmitted !== false) blockers.push("ORDER_SUBMISSION_FORBIDDEN");
  if (!candidate.safety || sha256Canonical(candidate.safety) !== sha256Canonical(BACKTESTER_ADAPTER_SAFETY)
    || candidate.profitabilityProven !== false || candidate.forwardEvidenceSufficient !== false) {
    blockers.push("ADAPTER_SAFETY_INVALID");
  }
  if (candidate.strategyIdentityDigest !== authority?.strategyIdentityDigest) blockers.push("STRATEGY_IDENTITY_MISMATCH");
  if (candidate.testOnly !== (authority?.evidenceClass === "TEST_ONLY")) blockers.push("EVIDENCE_CLASS_MISMATCH");
  if (authority?.evidenceClass === "CANONICAL") {
    const canonicalResult = Object.values(PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.resultContracts)
      .find((contract) => authority.artifactId
        === `github-actions:${PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.workflowRunId}/${PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.artifactNumericId}/${contract.file}`);
    if (!canonicalResult) blockers.push("CANONICAL_ARTIFACT_ID_MISMATCH");
    if (authority.sourceSha !== PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.researchCodeSha) blockers.push("CANONICAL_SOURCE_SHA_MISMATCH");
    if (authority.historicalHarnessSha !== PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.historicalHarnessSha) blockers.push("CANONICAL_HARNESS_SHA_MISMATCH");
    if (authority.artifactArchiveDigest !== PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.artifactArchiveDigest) blockers.push("CANONICAL_ARCHIVE_DIGEST_MISMATCH");
    if (canonicalResult && authority.artifactDigest !== canonicalResult.artifactDigest) blockers.push("CANONICAL_ARTIFACT_DIGEST_MISMATCH");
    if (canonicalResult && authority.legacyResultDigest !== canonicalResult.legacyResultDigest) blockers.push("CANONICAL_LEGACY_RESULT_DIGEST_MISMATCH");
  }

  const evidence = Array.isArray(candidate.evidenceEnvelopes) ? candidate.evidenceEnvelopes : [];
  if (evidence.length !== REQUIRED_STAGES.length) blockers.push("REQUIRED_EVIDENCE_STAGE_COUNT_MISMATCH");
  for (let index = 0; index < REQUIRED_STAGES.length; index += 1) {
    const result = evidence[index];
    const proof = authority?.evidenceDigests?.[index];
    const stage = REQUIRED_STAGES[index];
    if (result?.status !== "LINKED" || result?.envelope?.evidenceStage !== stage) blockers.push(`REQUIRED_EVIDENCE_STAGE_INVALID:${stage}`);
    if (result?.envelope?.strategyIdentityDigest !== candidate.strategyIdentityDigest) blockers.push(`STRATEGY_IDENTITY_MISMATCH:${stage}`);
    if (result?.envelope?.sourceSha !== authority?.sourceSha) blockers.push(`SOURCE_SHA_MISMATCH:${stage}`);
    if (result?.envelope?.artifactId !== authority?.artifactId || result?.envelope?.artifactDigest !== authority?.artifactDigest) {
      blockers.push(`ARTIFACT_IDENTITY_MISMATCH:${stage}`);
    }
    if (!result?.safety || sha256Canonical(result.safety) !== sha256Canonical(BACKTESTER_ADAPTER_SAFETY)) {
      blockers.push(`ADAPTER_SAFETY_INVALID:${stage}`);
    }
    if (proof?.stage !== stage || proof?.evidenceDigest !== result?.evidenceDigest) blockers.push(`EVIDENCE_DIGEST_MISMATCH:${stage}`);
  }
  return deepFreeze({
    schemaVersion: BACKTESTER_STRATEGY_EVIDENCE_ADAPTER_SCHEMA_VERSION,
    status: blockers.length === 0 ? "VERIFIED" : "REJECTED",
    verified: blockers.length === 0,
    blockers: unique(blockers),
    executionAuthority: "NONE",
    orderSubmitted: false,
    safety: BACKTESTER_ADAPTER_SAFETY,
  });
}
