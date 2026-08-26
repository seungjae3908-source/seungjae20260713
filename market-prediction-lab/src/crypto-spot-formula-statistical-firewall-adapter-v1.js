import { runEvidenceBackedFormulaTournamentAdapterV1 } from "./evidence-backed-formula-tournament-adapter-v1.js";
import {
  bindCryptoSpotPublicDatasetToAdapterInputV1,
  buildCryptoSpotPublicFormulaDatasetSummaryV1,
  collectCryptoSpotPublicFormulaTournamentDatasetV1,
  createCryptoSpotPublicFormulaTournamentDependenciesV1,
} from "./crypto-spot-public-formula-tournament-v1.js";
import { evaluateGlobalStrategyStatisticalFirewall } from "./global-strategy-statistical-firewall-v1.js";
import { researchDigest } from "./research-trial-registry.js";

export const CRYPTO_SPOT_FORMULA_STATISTICAL_FIREWALL_ADAPTER_VERSION = 1;
export const CRYPTO_SPOT_FORMULA_STATISTICAL_FIREWALL_ADAPTER_CONTRACT = "crypto-spot-formula-statistical-firewall-adapter/v1";
export const CRYPTO_SPOT_CANONICAL_STATISTICAL_TOURNAMENT_CONTRACT = "crypto-spot-canonical-statistical-tournament/v1";

const DAY_MS = 24 * 60 * 60 * 1000;
const CANONICAL_STATISTICAL_OWNER = "#547";
const CANONICAL_PBO_BLOCK_COUNT = 8;
const CANONICAL_PBO_MAX_COMBINATIONS = 5000;

export class CryptoSpotFormulaStatisticalFirewallAdapterError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "CryptoSpotFormulaStatisticalFirewallAdapterError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, details = {}) {
  throw new CryptoSpotFormulaStatisticalFirewallAdapterError(code, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function finite(value, code, details = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(code, { ...details, value });
  return value;
}

function positiveInteger(value, code, details = {}) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code, { ...details, value });
  return value;
}

function assertSelectionOnlyPeriod(period) {
  if (!period || !Number.isSafeInteger(period.startTime) || !Number.isSafeInteger(period.endTime) || period.startTime >= period.endTime) {
    fail("STATISTICAL_RETURN_PERIOD_INVALID", { period });
  }
  if (period.includeFinalHoldout === true || period.finalHoldoutEvaluation === true || period.selectionAllowed === false) {
    fail("STATISTICAL_FINAL_HOLDOUT_ACCESS_FORBIDDEN", { period });
  }
  return period;
}

function nearlyEqual(left, right) {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= scale * 1e-9;
}

export function buildAlignedRealizedEquityReturnSeriesV1({ backtest, period, bucketMs } = {}) {
  const selectedPeriod = assertSelectionOnlyPeriod(period ?? backtest?.period);
  positiveInteger(bucketMs, "STATISTICAL_RETURN_BUCKET_INVALID");
  const initialCapital = finite(backtest?.initialCapital, "STATISTICAL_INITIAL_CAPITAL_MISSING");
  if (!(initialCapital > 0)) fail("STATISTICAL_INITIAL_CAPITAL_INVALID", { initialCapital });
  if (!Array.isArray(backtest?.trades)) fail("STATISTICAL_TRADES_MISSING");

  const trades = [...backtest.trades].sort((left, right) => left.exitTime - right.exitTime || String(left.id ?? "").localeCompare(String(right.id ?? "")));
  let expectedEquity = initialCapital;
  let previousExitTime = null;
  for (const [index, trade] of trades.entries()) {
    if (!Number.isSafeInteger(trade?.exitTime) || trade.exitTime < selectedPeriod.startTime || trade.exitTime > selectedPeriod.endTime) {
      fail("STATISTICAL_TRADE_EXIT_OUTSIDE_PERIOD", { index, exitTime: trade?.exitTime, period: selectedPeriod });
    }
    if (previousExitTime !== null && trade.exitTime < previousExitTime) fail("STATISTICAL_TRADES_NOT_ORDERED", { index });
    const equityBefore = finite(trade.equityBefore, "STATISTICAL_EQUITY_BEFORE_MISSING", { index });
    const equityAfter = finite(trade.equityAfter, "STATISTICAL_EQUITY_AFTER_MISSING", { index });
    const netPnl = finite(trade.netPnl, "STATISTICAL_NET_PNL_MISSING", { index });
    if (!nearlyEqual(equityBefore, expectedEquity)) fail("STATISTICAL_EQUITY_CHAIN_MISMATCH", { index, expectedEquity, equityBefore });
    if (!nearlyEqual(equityAfter, equityBefore + netPnl)) {
      fail("STATISTICAL_EQUITY_PNL_RECONCILIATION_FAILED", { index, equityBefore, equityAfter, netPnl });
    }
    expectedEquity = equityAfter;
    previousExitTime = trade.exitTime;
  }

  const returns = [];
  const buckets = [];
  let tradeIndex = 0;
  let equity = initialCapital;
  for (let bucketStart = selectedPeriod.startTime; bucketStart <= selectedPeriod.endTime; bucketStart += bucketMs) {
    const bucketEnd = Math.min(selectedPeriod.endTime, bucketStart + bucketMs - 1);
    const startEquity = equity;
    let tradeCount = 0;
    while (tradeIndex < trades.length && trades[tradeIndex].exitTime <= bucketEnd) {
      if (trades[tradeIndex].exitTime < bucketStart) fail("STATISTICAL_TRADE_BUCKET_ALIGNMENT_FAILED", { tradeIndex, bucketStart });
      equity = trades[tradeIndex].equityAfter;
      tradeIndex += 1;
      tradeCount += 1;
    }
    if (!(startEquity > 0) || !Number.isFinite(equity)) fail("STATISTICAL_EQUITY_NON_POSITIVE_OR_NON_FINITE", { bucketStart, startEquity, equity });
    const realizedReturn = (equity / startEquity) - 1;
    finite(realizedReturn, "STATISTICAL_RETURN_NON_FINITE", { bucketStart });
    returns.push(realizedReturn);
    buckets.push(Object.freeze({ startTime: bucketStart, endTime: bucketEnd, startEquity, endEquity: equity, tradeCount, realizedReturn }));
  }
  if (tradeIndex !== trades.length) fail("STATISTICAL_UNCONSUMED_TRADE", { tradeIndex, tradeCount: trades.length });
  return deepFreeze({
    schemaVersion: 1,
    method: "REALIZED_EQUITY_FIXED_TIME_BUCKETS",
    bucketMs,
    period: { startTime: selectedPeriod.startTime, endTime: selectedPeriod.endTime },
    initialCapital,
    finalEquity: equity,
    tradeCount: trades.length,
    returns,
    buckets,
    noTradeBucketReturn: 0,
    markToMarketFabricated: false,
    finalHoldoutUsed: false,
  });
}

function canonicalFirewallFailureReason(firewall) {
  const missing = [];
  if (firewall?.dsr?.status !== "EVIDENCE_READY") missing.push("DSR");
  if (firewall?.pbo?.status !== "EVIDENCE_READY") missing.push("PBO");
  if (firewall?.realityCheckAndSpa?.status !== "EVIDENCE_READY") missing.push("REALITY_CHECK_AND_SPA");
  if (firewall?.decision?.status !== "STATISTICAL_REVIEW_READY") missing.push("EMPIRICAL_DECISION_POLICY");
  return missing.length ? `canonical #547 evidence is not admission-ready: ${missing.join(",")}` : "canonical #547 evidence did not authorize statistical admission";
}

export function evaluateCanonicalCryptoSpotFormulaStatisticalEvidenceV1({ trials, selectedTrialId, candidateFamilySize, requiredAdjustedAlpha } = {}) {
  if (!Array.isArray(trials) || trials.length === 0) fail("STATISTICAL_TRIALS_REQUIRED");
  positiveInteger(candidateFamilySize, "STATISTICAL_CANDIDATE_FAMILY_SIZE_INVALID");
  finite(requiredAdjustedAlpha, "STATISTICAL_ADJUSTED_ALPHA_INVALID");
  if (!(requiredAdjustedAlpha > 0 && requiredAdjustedAlpha <= 1)) fail("STATISTICAL_ADJUSTED_ALPHA_INVALID", { requiredAdjustedAlpha });
  if (candidateFamilySize < trials.length) fail("STATISTICAL_FAMILY_SIZE_UNDERCOUNTS_TRIALS", { candidateFamilySize, trialCount: trials.length });
  if (!trials.some((trial) => trial?.trialId === selectedTrialId)) fail("STATISTICAL_SELECTED_TRIAL_MISSING", { selectedTrialId });
  const lengths = new Set(trials.map((trial) => trial?.returnSeries?.length));
  if (lengths.size !== 1) fail("STATISTICAL_TRIAL_SERIES_NOT_ALIGNED", { lengths: [...lengths] });

  const canonicalFirewall = evaluateGlobalStrategyStatisticalFirewall({
    trials,
    selectedTrialId,
    benchmarkReturns: null,
    blockCount: CANONICAL_PBO_BLOCK_COUNT,
    maxCombinations: CANONICAL_PBO_MAX_COMBINATIONS,
    realityCheckPolicy: null,
    decisionPolicy: null,
  });
  if (canonicalFirewall?.safety?.executionAuthority !== "NONE"
    || canonicalFirewall?.safety?.profitabilityAuthority !== false
    || canonicalFirewall?.dataSnoopingDisclosure?.allSelectionTrialsCounted !== true
    || canonicalFirewall?.dataSnoopingDisclosure?.finalHoldoutMayBeUsedForSelection !== false) {
    fail("CANONICAL_STATISTICAL_FIREWALL_SAFETY_INVALID");
  }

  const dsrValue = Number.isFinite(canonicalFirewall.dsr?.result?.probability) ? canonicalFirewall.dsr.result.probability : null;
  const pboValue = Number.isFinite(canonicalFirewall.pbo?.result?.pbo) ? canonicalFirewall.pbo.result.pbo : null;
  const admissionReady = canonicalFirewall.status === "EVIDENCE_READY" && canonicalFirewall.decision?.status === "STATISTICAL_REVIEW_READY";
  const common = {
    status: "MISSING_EVIDENCE",
    failureCode: "STATISTICAL_EVIDENCE_MISSING",
    canonicalOwner: CANONICAL_STATISTICAL_OWNER,
    canonicalFirewall,
    multipleTesting: {
      method: "GLOBAL_FAMILY_ADJUSTED_ALPHA_INPUT",
      candidateFamilySize,
      adjustedAlpha: requiredAdjustedAlpha,
      passed: null,
    },
    dsr: { value: dsrValue, passed: null },
    pbo: { value: pboValue, passed: null },
    empiricalDecisionPolicyApplied: false,
    finalHoldoutAccess: false,
    executionAuthority: "NONE",
  };
  if (!admissionReady) return deepFreeze({ ...common, failureReason: canonicalFirewallFailureReason(canonicalFirewall) });

  return deepFreeze({
    ...common,
    failureReason: "canonical #547 produced review-ready evidence but this V1 adapter has no immutable empirical policy binding for #551 admission",
  });
}

async function planExactGeneratedRegistry(boundInput) {
  const registry = [];
  const plan = await runEvidenceBackedFormulaTournamentAdapterV1(boundInput, {
    loadDatasetMetadata: async ({ formulaCandidate, generatedCandidate }) => {
      registry.push(Object.freeze({ formulaCandidate, generatedCandidate }));
      return null;
    },
  });
  if (plan.status !== "COMPLETED" || !plan.tournament || registry.length === 0) {
    fail("STATISTICAL_GENERATED_REGISTRY_PLANNING_FAILED", { status: plan.status, registryCount: registry.length });
  }
  const generatedIds = registry.map((row) => row.generatedCandidate.generatedCandidateId);
  if (new Set(generatedIds).size !== generatedIds.length) fail("STATISTICAL_GENERATED_REGISTRY_DUPLICATE");
  const terminalIds = (plan.tournament.candidates ?? []).map((candidate) => candidate.generatedCandidateId).filter(Boolean);
  if (terminalIds.length !== generatedIds.length || terminalIds.some((id) => !generatedIds.includes(id))) {
    fail("STATISTICAL_GENERATED_REGISTRY_PLAN_MISMATCH", { generatedCount: generatedIds.length, terminalCount: terminalIds.length });
  }
  for (const candidate of plan.tournament.candidates ?? []) {
    if (candidate.terminalState !== "SANITY_CHECK" || candidate.failure?.failureCode !== "REQUIRED_DATA_MISSING") {
      fail("STATISTICAL_PLANNING_DRY_RUN_EXECUTED_BEYOND_SANITY", {
        generatedCandidateId: candidate.generatedCandidateId,
        terminalState: candidate.terminalState,
        failureCode: candidate.failure?.failureCode ?? null,
      });
    }
  }
  return deepFreeze({
    registry,
    globalPlannedCandidateFamilySize: plan.globalPlannedCandidateFamilySize,
    generatedCandidateCount: registry.length,
    planningTournamentId: plan.tournament.tournamentId,
    planningBacktestCount: 0,
    finalHoldoutAccess: false,
  });
}

export function createCryptoSpotFormulaCanonicalStatisticalFirewallAdapterV1({ boundInput, dataset, runSelectionBacktest } = {}) {
  if (!boundInput || boundInput.seedResult?.profile?.market !== "CRYPTO_SPOT") fail("STATISTICAL_BOUND_CRYPTO_SPOT_INPUT_REQUIRED");
  if (boundInput.tournament?.search?.finalHoldoutAccess !== false) fail("STATISTICAL_FINAL_HOLDOUT_ACCESS_FORBIDDEN");
  if (!dataset || dataset.market !== "CRYPTO_SPOT" || !Number.isSafeInteger(dataset.intervalMs)) fail("STATISTICAL_CRYPTO_SPOT_DATASET_REQUIRED");
  if (dataset.finalHoldoutExcluded !== true) fail("STATISTICAL_DATASET_FINAL_HOLDOUT_EXCLUSION_REQUIRED");
  assertSelectionOnlyPeriod({ ...dataset.trainPeriod, includeFinalHoldout: false, finalHoldoutEvaluation: false, selectionAllowed: true });
  if (typeof runSelectionBacktest !== "function") fail("STATISTICAL_SELECTION_BACKTEST_CALLBACK_REQUIRED");

  let planningPromise = null;
  let evidencePromise = null;
  const bucketMs = Math.max(7 * DAY_MS, 30 * dataset.intervalMs);
  const loadPlan = () => {
    planningPromise ??= planExactGeneratedRegistry(boundInput);
    return planningPromise;
  };
  const loadTrialEvidence = () => {
    evidencePromise ??= (async () => {
      const plan = await loadPlan();
      const trials = [];
      const trialEvidence = [];
      for (const row of plan.registry) {
        const backtest = await runSelectionBacktest({
          formulaCandidate: row.formulaCandidate,
          generatedCandidate: row.generatedCandidate,
          datasetIdentity: dataset.datasetIdentity,
          period: dataset.trainPeriod,
          finalHoldoutAccess: false,
        });
        if (!backtest || backtest.safeguards?.finalHoldoutUsedForSelection !== false || backtest.safeguards?.selectionAllowed !== true) {
          fail("STATISTICAL_SELECTION_BACKTEST_SAFETY_INVALID", { generatedCandidateId: row.generatedCandidate.generatedCandidateId });
        }
        const returnEvidence = buildAlignedRealizedEquityReturnSeriesV1({ backtest, period: backtest.period, bucketMs });
        trials.push(Object.freeze({ trialId: row.generatedCandidate.generatedCandidateId, returnSeries: Object.freeze([...returnEvidence.returns]) }));
        trialEvidence.push(Object.freeze({
          trialId: row.generatedCandidate.generatedCandidateId,
          formulaCandidateId: row.formulaCandidate.candidateId,
          strategyHash: row.formulaCandidate.formulaHash,
          parameterIdentity: row.generatedCandidate.parameterIdentity,
          returnSeriesDigest: researchDigest(returnEvidence.returns),
          returnObservationCount: returnEvidence.returns.length,
          tradeCount: returnEvidence.tradeCount,
          finalHoldoutUsed: false,
        }));
      }
      const lengths = new Set(trials.map((trial) => trial.returnSeries.length));
      if (lengths.size !== 1) fail("STATISTICAL_TRIAL_SERIES_NOT_ALIGNED", { lengths: [...lengths] });
      return deepFreeze({
        plan,
        trials,
        trialEvidence,
        registryDigest: researchDigest(trialEvidence),
        bucketMs,
        allSelectionTrialsCounted: true,
        finalHoldoutUsed: false,
      });
    })();
    return evidencePromise;
  };

  return Object.freeze({
    schemaVersion: CRYPTO_SPOT_FORMULA_STATISTICAL_FIREWALL_ADAPTER_VERSION,
    contract: CRYPTO_SPOT_FORMULA_STATISTICAL_FIREWALL_ADAPTER_CONTRACT,
    canonicalOwner: CANONICAL_STATISTICAL_OWNER,
    async runStatisticalFirewall({ formulaCandidate, generatedCandidate, canonicalOwner, candidateFamilySize, requiredAdjustedAlpha, finalHoldoutAccess } = {}) {
      if (canonicalOwner !== CANONICAL_STATISTICAL_OWNER) {
        return Object.freeze({ status: "MISSING_EVIDENCE", failureCode: "STATISTICAL_EVIDENCE_MISSING", failureReason: "canonical Statistical Firewall owner must be #547" });
      }
      if (finalHoldoutAccess !== false) {
        return Object.freeze({ status: "MISSING_EVIDENCE", failureCode: "HOLDOUT_PREACCESS_FORBIDDEN", failureReason: "Statistical Firewall cannot access Final Holdout during selection" });
      }
      const evidence = await loadTrialEvidence();
      const selectedTrialId = generatedCandidate?.generatedCandidateId;
      const selected = evidence.plan.registry.find((row) => row.generatedCandidate.generatedCandidateId === selectedTrialId);
      if (!selected || selected.formulaCandidate.formulaHash !== formulaCandidate?.formulaHash || selected.generatedCandidate.parameterIdentity !== generatedCandidate?.parameterIdentity) {
        return Object.freeze({ status: "MISSING_EVIDENCE", failureCode: "STATISTICAL_EVIDENCE_MISSING", failureReason: "current tournament candidate is absent from the exact #722 generated registry" });
      }
      if (!Number.isSafeInteger(candidateFamilySize) || candidateFamilySize < evidence.plan.globalPlannedCandidateFamilySize) {
        return Object.freeze({ status: "MISSING_EVIDENCE", failureCode: "STATISTICAL_EVIDENCE_MISSING", failureReason: "global candidate-family size is smaller than the exact #722 planned family" });
      }
      if (!Number.isFinite(requiredAdjustedAlpha) || requiredAdjustedAlpha <= 0
        || requiredAdjustedAlpha > (boundInput.tournament.policy.multipleTestingBaseAlpha / candidateFamilySize)) {
        return Object.freeze({ status: "MISSING_EVIDENCE", failureCode: "MULTIPLE_TESTING_FAIL", failureReason: "global adjusted alpha is missing or weaker than the exact family-size correction" });
      }
      const result = evaluateCanonicalCryptoSpotFormulaStatisticalEvidenceV1({
        trials: evidence.trials,
        selectedTrialId,
        candidateFamilySize,
        requiredAdjustedAlpha,
      });
      return deepFreeze({
        ...result,
        selectionTrialRegistry: {
          generatedCandidateCount: evidence.plan.generatedCandidateCount,
          globalPlannedCandidateFamilySize: evidence.plan.globalPlannedCandidateFamilySize,
          registryDigest: evidence.registryDigest,
          bucketMs: evidence.bucketMs,
          returnObservationCountPerTrial: evidence.trials[0]?.returnSeries.length ?? 0,
          allSelectionTrialsCounted: true,
          planningBacktestCount: 0,
          actualSelectionBacktestCount: evidence.trials.length,
          finalHoldoutUsed: false,
        },
      });
    },
    safety: Object.freeze({
      researchOnly: true,
      canonicalStatisticalOwner: CANONICAL_STATISTICAL_OWNER,
      planningBacktestCount: 0,
      finalHoldoutAccess: false,
      profitabilityClaimAllowed: false,
      championPromotionAllowed: false,
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
      executionAuthority: "NONE",
    }),
  });
}

export async function runCryptoSpotPublicFormulaTournamentWithCanonicalStatisticsV1({
  client,
  symbol,
  startTime,
  endTime,
  maxCandles = 250_000,
  minimumPartitionCandles = 120,
  adapterInput,
  onPage,
} = {}) {
  const timeframe = adapterInput?.seedResult?.profile?.timeframe;
  const dataset = await collectCryptoSpotPublicFormulaTournamentDatasetV1({
    client,
    symbol,
    timeframe,
    startTime,
    endTime,
    maxCandles,
    minimumPartitionCandles,
    onPage,
  });
  const boundInput = bindCryptoSpotPublicDatasetToAdapterInputV1(adapterInput, dataset);
  const baseDependencies = createCryptoSpotPublicFormulaTournamentDependenciesV1({ dataset });
  const statisticalAdapter = createCryptoSpotFormulaCanonicalStatisticalFirewallAdapterV1({
    boundInput,
    dataset,
    runSelectionBacktest: ({ formulaCandidate, generatedCandidate }) => baseDependencies.runHistoricalBacktest({
      formulaCandidate,
      generatedCandidate,
      datasetIdentity: dataset.datasetIdentity,
    }),
  });
  const dependencies = Object.freeze({
    ...baseDependencies,
    runStatisticalFirewall: statisticalAdapter.runStatisticalFirewall,
  });
  const result = await runEvidenceBackedFormulaTournamentAdapterV1(boundInput, dependencies);
  const candidates = result.tournament?.candidates ?? [];
  const statisticalRecords = candidates.flatMap((candidate) => candidate.stageRecords?.filter((record) => record.stage === "STATISTICAL_FIREWALL") ?? []);
  return deepFreeze({
    schemaVersion: CRYPTO_SPOT_FORMULA_STATISTICAL_FIREWALL_ADAPTER_VERSION,
    contract: CRYPTO_SPOT_CANONICAL_STATISTICAL_TOURNAMENT_CONTRACT,
    status: "COMPLETED",
    dataset: buildCryptoSpotPublicFormulaDatasetSummaryV1(dataset),
    result,
    canonicalStatisticalOwner: CANONICAL_STATISTICAL_OWNER,
    canonicalStatisticalInvocationCount: statisticalRecords.length,
    finalHoldoutEvaluated: false,
    profitabilityClaimAllowed: false,
    championPromotionAllowed: false,
    tradingAuthority: false,
    safety: {
      researchOnly: true,
      finalHoldoutPreAccessAllowed: false,
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
      executionAuthority: "NONE",
    },
  });
}
