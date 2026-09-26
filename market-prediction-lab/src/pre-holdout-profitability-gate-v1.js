import {
  parseKenFrenchDevelopedMomentumCsv,
  runFirstRealGlobalReplication,
} from "./first-real-global-replication-v1.js";
import { researchDigest } from "./research-trial-registry.js";

export const PRE_HOLDOUT_PROFITABILITY_GATE_SCHEMA_VERSION = 1;
export const PRE_HOLDOUT_COST_POLICY_VERSION = "FF_DEVELOPED_MOMENTUM_COST_POLICY_PREHOLDOUT_V1";
export const PRE_HOLDOUT_DECISION_POLICY_VERSION = "FF_DEVELOPED_MOMENTUM_DECISION_POLICY_PREHOLDOUT_V1";

const OOS_START = "201210";
const OOS_END = "202012";
const FINAL_HOLDOUT_START = "202101";
const STRESS_MULTIPLIERS = Object.freeze([1, 1.25, 1.5, 2]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value;
}

function sampleStdev(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1));
}

function summarizeReturns(rows, valueKey) {
  if (rows.length < 2) throw new Error("RETURN_SERIES_INSUFFICIENT");
  const values = rows.map((row) => row[valueKey]);
  const sampleN = values.length;
  const meanMonthlyPct = values.reduce((sum, value) => sum + value, 0) / sampleN;
  const stdevMonthlyPct = sampleStdev(values);
  const positive = values.filter((value) => value > 0);
  const negative = values.filter((value) => value < 0);
  const positiveSumPct = positive.reduce((sum, value) => sum + value, 0);
  const negativeSumAbsPct = Math.abs(negative.reduce((sum, value) => sum + value, 0));
  let wealth = 1;
  let peak = 1;
  let maxDrawdownPct = 0;
  for (const value of values) {
    wealth *= 1 + (value / 100);
    peak = Math.max(peak, wealth);
    maxDrawdownPct = Math.min(maxDrawdownPct, ((wealth / peak) - 1) * 100);
  }
  return deepFreeze({
    sampleN,
    startPeriod: rows[0].period,
    endPeriod: rows.at(-1).period,
    meanMonthlyPct,
    expectedValueMonthlyPct: meanMonthlyPct,
    stdevMonthlyPct,
    tStatistic: meanMonthlyPct / (stdevMonthlyPct / Math.sqrt(sampleN)),
    annualizedSharpe: (meanMonthlyPct / stdevMonthlyPct) * Math.sqrt(12),
    annualizedArithmeticReturnPct: meanMonthlyPct * 12,
    annualizedCompoundedReturnPct: ((wealth ** (12 / sampleN)) - 1) * 100,
    cumulativeReturnPct: (wealth - 1) * 100,
    profitFactorMonthlyReturnRatio: negativeSumAbsPct > 0 ? positiveSumPct / negativeSumAbsPct : null,
    maxDrawdownPct,
    positiveMonthRatePct: (positive.length / sampleN) * 100,
    positiveMonths: positive.length,
    negativeMonths: negative.length,
  });
}

export function redactFinalHoldoutRows(csvText, sourceName = "KEN_FRENCH") {
  const text = requiredText(csvText, `${sourceName}CsvText`);
  let redactedObservationRows = 0;
  const retained = text.split(/\r?\n/).filter((line) => {
    const match = line.match(/^\s*(\d{6})\s*,/);
    if (match && match[1] >= FINAL_HOLDOUT_START) {
      redactedObservationRows += 1;
      return false;
    }
    return true;
  });
  const preHoldoutCsvText = retained.join("\n");
  if (new RegExp(`^\\s*(?:${FINAL_HOLDOUT_START.slice(0, 4)}|202[2-9]|20[3-9]\\d)\\d{2}\\s*,`, "m").test(preHoldoutCsvText)) {
    throw new Error(`${sourceName}_FINAL_HOLDOUT_REDACTION_FAILED`);
  }
  return deepFreeze({
    preHoldoutCsvText,
    redactedObservationRows,
    holdoutValuesParsed: 0,
    cutoffPeriod: OOS_END,
  });
}

export function createPreHoldoutCostEvidence() {
  const core = {
    policyVersion: PRE_HOLDOUT_COST_POLICY_VERSION,
    status: "PARTIAL_EMPIRICAL_PROXY_BASELINE",
    allInCostComplete: false,
    admissionGrade: false,
    empiricalProxy: {
      strategyAnalogue: "INTERNATIONAL_NON_OPTIMIZED_UMD",
      appliedAnnualCostPct: 2.70,
      observedRangeAnnualPct: { lowerGlobalUmdPct: 2.45, referenceInternationalUmdPct: 2.70, upperNonOptimizedUmdExamplePct: 4.78 },
      applicationMethod: "ARITHMETIC_ANNUAL_COST_DRAG_DIVIDED_EQUALLY_BY_12",
      source: {
        title: "Trading Costs of Asset Pricing Anomalies",
        authors: ["Andrea Frazzini", "Ronen Israel", "Tobias J. Moskowitz"],
        sourceUrl: "https://pages.stern.nyu.edu/~afrazzin/pdf/Trading%20Cost%20of%20Asset%20Pricing%20Anomalies%20-%20Frazzini%2C%20Israel%20and%20Moskowitz.pdf",
        evidenceLocation: "Table VII Panels B/C and Table VIII discussion",
        liveTradeCoverage: "NEARLY_ONE_TRILLION_USD; 19_DEVELOPED_EQUITY_MARKETS; 1998_2011",
        limitations: [
          "NOT_THE_KENNETH_FRENCH_CONSTITUENT_BOOK",
          "FUND_SIZE_AND_SECURITY_LEVEL_TURNOVER_NOT_AVAILABLE",
          "SHORT_BORROW_FEES_EXCLUDED_BY_SOURCE",
          "AGGREGATE_PROXY_DOES_NOT_SEPARATE_SPREAD_SLIPPAGE_AND_PRICE_IMPACT",
        ],
      },
    },
    dimensions: {
      commission: {
        status: "OFFICIAL_FORMULA_AVAILABLE_CALIBRATION_REQUIRED",
        appliedToProxyNetMetrics: false,
        sourceUrl: "https://www.interactivebrokers.com/en/pricing/commissions-stocks.php",
        examples: ["US_FIXED_USD_0.005_PER_SHARE_MIN_USD_1_MAX_1PCT_TRADE_VALUE", "UK_TIER1_0.05PCT_TRADE_VALUE_MIN_GBP_1"],
        blocker: "COUNTRY_VENUE_SHARE_PRICE_ORDER_SIZE_AND_ORDER_COUNT_MISSING",
      },
      spread: {
        status: "EMPIRICAL_PROXY_INCLUDED_NOT_SEPARABLE",
        appliedToProxyNetMetrics: true,
        blocker: "NO_SECURITY_LEVEL_QUOTES_OR_EXECUTIONS",
      },
      slippage: {
        status: "IMPLEMENTATION_SHORTFALL_PROXY_INCLUDED_NOT_SEPARABLE",
        appliedToProxyNetMetrics: true,
        blocker: "NO_INTENDED_VERSUS_EXECUTED_SECURITY_LEVEL_ORDERS",
      },
      tax: {
        status: "OFFICIAL_MARKET_FORMULA_AVAILABLE_CALIBRATION_REQUIRED",
        appliedToProxyNetMetrics: false,
        sourceUrl: "https://www.gov.uk/tax-buy-shares/buy-shares-electronically",
        example: "UK_SDRT_0.5PCT_ON_CHARGEABLE_ELECTRONIC_SHARE_PURCHASES_SUBJECT_TO_RELIEF_AND_SCOPE",
        blocker: "COUNTRY_SECURITY_DATE_WEIGHT_TURNOVER_AND_EXEMPTION_FLAGS_MISSING",
      },
      fx: {
        status: "OFFICIAL_FORMULA_AVAILABLE_CALIBRATION_REQUIRED",
        appliedToProxyNetMetrics: false,
        sourceUrl: "https://www.interactivebrokers.com/en/pricing/commissions-spot-currencies.php",
        example: "TIER1_0.20_BASIS_POINT_TIMES_TRADE_VALUE_MIN_USD_2",
        blocker: "BASE_CURRENCY_COUNTRY_FLOWS_NETTING_AND_FX_NOTIONAL_MISSING",
      },
      liquidityImpact: {
        status: "APPLIED_EMPIRICAL_PROXY",
        appliedToProxyNetMetrics: true,
        sourceUrl: "https://www.aqr.com/insights/research/working-paper/trading-costs-of-asset-pricing-anomalies",
        blocker: "TARGET_NAV_PARTICIPATION_RATE_AND_SECURITY_LEVEL_ADV_MISSING",
      },
      borrow: {
        status: "OFFICIAL_DYNAMIC_FORMULA_CALIBRATION_REQUIRED",
        appliedToProxyNetMetrics: false,
        sourceUrl: "https://www.interactivebrokers.com/en/pricing/short-sale-cost.php",
        formulaInputs: ["SETTLED_SHORT_POSITION", "COLLATERAL_VALUE", "BORROW_FEE_RATE", "SHORT_PROCEEDS_INTEREST_RATE"],
        blocker: "SHORT_CONSTITUENTS_POSITION_VALUES_AND_POINT_IN_TIME_BORROW_RATES_MISSING",
      },
    },
    unresolvedAllInDimensions: ["commission", "tax", "fx", "borrow", "securityLevelSpreadSlippageDecomposition"],
    noDoubleCountingRule: "DO_NOT_ADD_UNSEPARATED_SPREAD_SLIPPAGE_OR_IMPACT_ON_TOP_OF_THE_2.70PCT_PROXY",
  };
  return deepFreeze({ ...core, costEvidenceDigest: researchDigest(core) });
}

export function createPreHoldoutDecisionPolicy() {
  const core = {
    policyVersion: PRE_HOLDOUT_DECISION_POLICY_VERSION,
    registeredAt: "2026-08-21T01:33:35Z",
    registeredBeforeFinalHoldout: true,
    immutableAfterHoldoutOpen: true,
    thresholdSelectionBasis: "PRE_HOLDOUT_GOVERNANCE_THRESHOLDS; NOT_CALIBRATED_ON_2021_PLUS_DATA",
    thresholds: {
      minimumOosSample: { operator: "GTE", value: 60, unit: "MONTHS" },
      netExpectancy: { operator: "GT", value: 0, unit: "PCT_PER_MONTH", requiredAtStressMultiplier: 1 },
      profitFactor: { applicable: true, metric: "MONTHLY_RETURN_GAIN_LOSS_RATIO", operator: "GTE", value: 1.10 },
      maximumDrawdown: { operator: "GTE", value: -25, unit: "PCT" },
      minimumRiskAdjustedPerformance: { metric: "ANNUALIZED_SHARPE", operator: "GTE", value: 0.50 },
      walkForwardStability: { positiveNetExpectancyWindows: { operator: "GTE", value: 4 }, windowCount: 6, stressMultiplier: 2 },
      dsr: { metric: "PROBABILITY", operator: "GTE", value: 0.95 },
      pbo: { operator: "LTE", value: 0.20 },
      realityCheckAndSpa: { bothPValuesOperator: "LTE", value: 0.05 },
      parameterStability: { parameterRefits: 0, optimizationTrials: 0, exactParameterHashAcrossWindows: true },
      regimeRobustness: { minimumRegimes: 3, minimumObservationsPerRegime: 24, eachRegimeNetExpectancyOperator: "GT_ZERO" },
      costStressSurvivability: { requiredMultiplier: 2, netExpectancyOperator: "GT_ZERO", profitFactorOperator: "GTE_ONE", sharpeOperator: "GT_ZERO", maximumDrawdownPct: -25 },
      allInCostPolicyComplete: { required: true },
    },
    antiTuning: {
      finalHoldoutMayCalibratePolicy: false,
      finalHoldoutMaySelectParameters: false,
      policyMayBeRelaxedAfterSeeingHoldout: false,
      parameterRefitsAllowed: 0,
    },
  };
  return deepFreeze({ ...core, decisionPolicyDigest: researchDigest(core) });
}

function applyAnnualCostProxy(rows, annualCostPct) {
  const monthlyCostPct = annualCostPct / 12;
  return deepFreeze(rows.map((row) => ({ ...row, netReturnPct: row.returnPct - monthlyCostPct })));
}

function buildCostStress(oosRows, costEvidence) {
  const grossMetrics = summarizeReturns(oosRows, "returnPct");
  return deepFreeze(STRESS_MULTIPLIERS.map((multiplier) => {
    const annualProxyCostPct = Number(
      (costEvidence.empiricalProxy.appliedAnnualCostPct * multiplier).toFixed(6),
    );
    const monthlyProxyCostPct = annualProxyCostPct / 12;
    const netRows = applyAnnualCostProxy(oosRows, annualProxyCostPct);
    const netMetrics = summarizeReturns(netRows, "netReturnPct");
    return {
      multiplier,
      annualProxyCostPct,
      monthlyProxyCostPct,
      status: "COMPLETED_PARTIAL_EMPIRICAL_PROXY_NOT_ALL_IN",
      grossMetrics,
      netMetrics,
      costDrag: {
        annualInputPct: annualProxyCostPct,
        monthlyAppliedPct: monthlyProxyCostPct,
        annualizedCompoundedReturnDragPct: grossMetrics.annualizedCompoundedReturnPct - netMetrics.annualizedCompoundedReturnPct,
        cumulativeReturnDragPct: grossMetrics.cumulativeReturnPct - netMetrics.cumulativeReturnPct,
      },
    };
  }));
}

function buildAfterCostWalkForward(oosRows, costStress) {
  const windowMonths = 36;
  const stepMonths = 12;
  return deepFreeze(costStress.map((stress) => {
    const windows = [];
    for (let start = 0; start + windowMonths <= oosRows.length; start += stepMonths) {
      const grossRows = oosRows.slice(start, start + windowMonths);
      const netRows = applyAnnualCostProxy(grossRows, stress.annualProxyCostPct);
      windows.push({
        windowIndex: windows.length + 1,
        gross: summarizeReturns(grossRows, "returnPct"),
        net: summarizeReturns(netRows, "netReturnPct"),
      });
    }
    return {
      multiplier: stress.multiplier,
      method: "FIXED_RULE_ROLLING_36_MONTH_WINDOWS_STEP_12",
      parameterRefits: 0,
      optimizationTrials: 0,
      uniqueEvaluationSampleN: oosRows.length,
      windowCount: windows.length,
      positiveNetExpectancyWindows: windows.filter((window) => window.net.expectedValueMonthlyPct > 0).length,
      positiveNetSharpeWindows: windows.filter((window) => window.net.annualizedSharpe > 0).length,
      worstNetMaxDrawdownPct: Math.min(...windows.map((window) => window.net.maxDrawdownPct)),
      windows,
    };
  }));
}

function gate(status, observed, threshold, reason = null) {
  return deepFreeze({ status, observed, threshold, reason });
}

function evaluatePolicy({ base, costEvidence, decisionPolicy, costStress, walkForwardAfterCosts }) {
  const thresholds = decisionPolicy.thresholds;
  const baseline = costStress.find((stress) => stress.multiplier === 1);
  const doubled = costStress.find((stress) => stress.multiplier === 2);
  const doubledWalkForward = walkForwardAfterCosts.find((stress) => stress.multiplier === 2);
  const dsr = base.statisticalFirewall.dsr.result.probability;
  const pbo = base.statisticalFirewall.pbo.result.pbo;
  const realityCheckP = base.statisticalFirewall.realityCheckAndSpa.result.realityCheck.pValue;
  const spaP = base.statisticalFirewall.realityCheckAndSpa.result.spa.pValue;
  const gates = {
    minimumOosSample: gate(base.oos.sampleN >= thresholds.minimumOosSample.value ? "PASS" : "FAIL", base.oos.sampleN, thresholds.minimumOosSample),
    netExpectancy: gate(baseline.netMetrics.expectedValueMonthlyPct > 0 ? "PASS" : "FAIL", baseline.netMetrics.expectedValueMonthlyPct, thresholds.netExpectancy),
    profitFactor: gate(baseline.netMetrics.profitFactorMonthlyReturnRatio >= thresholds.profitFactor.value ? "PASS" : "FAIL", baseline.netMetrics.profitFactorMonthlyReturnRatio, thresholds.profitFactor),
    maximumDrawdown: gate(baseline.netMetrics.maxDrawdownPct >= thresholds.maximumDrawdown.value ? "PASS" : "FAIL", baseline.netMetrics.maxDrawdownPct, thresholds.maximumDrawdown),
    minimumRiskAdjustedPerformance: gate(baseline.netMetrics.annualizedSharpe >= thresholds.minimumRiskAdjustedPerformance.value ? "PASS" : "FAIL", baseline.netMetrics.annualizedSharpe, thresholds.minimumRiskAdjustedPerformance),
    walkForwardStability: gate(doubledWalkForward.positiveNetExpectancyWindows >= thresholds.walkForwardStability.positiveNetExpectancyWindows.value ? "PASS" : "FAIL", doubledWalkForward.positiveNetExpectancyWindows, thresholds.walkForwardStability),
    dsr: gate(dsr >= thresholds.dsr.value ? "PASS" : "FAIL", dsr, thresholds.dsr),
    pbo: gate(pbo <= thresholds.pbo.value ? "PASS" : "FAIL", pbo, thresholds.pbo),
    realityCheckAndSpa: gate(realityCheckP <= thresholds.realityCheckAndSpa.value && spaP <= thresholds.realityCheckAndSpa.value ? "PASS" : "FAIL", { realityCheckP, spaP }, thresholds.realityCheckAndSpa),
    parameterStability: gate(base.walkForward.parameterRefits === 0 && base.walkForward.optimizationTrials === 0 ? "PASS" : "FAIL", { parameterRefits: base.walkForward.parameterRefits, optimizationTrials: base.walkForward.optimizationTrials }, thresholds.parameterStability),
    regimeRobustness: gate("CALIBRATION_REQUIRED", null, thresholds.regimeRobustness, "NO_POINT_IN_TIME_PRE_HOLDOUT_REGIME_LABEL_DATASET"),
    costStressSurvivability: gate(
      doubled.netMetrics.expectedValueMonthlyPct > 0
        && doubled.netMetrics.profitFactorMonthlyReturnRatio >= 1
        && doubled.netMetrics.annualizedSharpe > 0
        && doubled.netMetrics.maxDrawdownPct >= thresholds.costStressSurvivability.maximumDrawdownPct
        ? "PASS" : "FAIL",
      doubled.netMetrics,
      thresholds.costStressSurvivability,
    ),
    allInCostPolicyComplete: gate(costEvidence.allInCostComplete ? "PASS" : "CALIBRATION_REQUIRED", costEvidence.allInCostComplete, thresholds.allInCostPolicyComplete, "COMMISSION_TAX_FX_BORROW_AND_SECURITY_LEVEL_EXECUTION_INPUTS_INCOMPLETE"),
  };
  const blockers = Object.entries(gates).filter(([, value]) => value.status !== "PASS").map(([name, value]) => `${name}:${value.status}`);
  return deepFreeze({
    status: blockers.length ? "PRE_HOLDOUT_GATE_FAILED" : "PRE_HOLDOUT_GATE_PASSED",
    gates,
    blockers,
    everyRequiredGatePassed: blockers.length === 0,
  });
}

function buildSampleAccounting(base) {
  return deepFreeze({
    externalStudyCount: base.researchBatch.rawStudyCount,
    effectiveIndependentStudyCount: base.researchBatch.effectiveStudyCount,
    externalObservationN: base.tierCounts.externalPaperN,
    externalDatasetObservationN: base.tierCounts.externalDatasetN,
    ourReplicationN: base.tierCounts.ourReplicationN,
    ourOosN: base.tierCounts.ourOosN,
    ourWalkForwardN: base.tierCounts.ourWalkForwardN,
    ourHoldoutN: 0,
    ourShadowN: base.tierCounts.ourShadowN,
    ourPaperN: base.tierCounts.ourPaperN,
    ourSettledN: base.tierCounts.ourSettledN,
    observationCountsAreNeverStudyCounts: true,
  });
}

function buildResearchProductionPlan({ candidateIdentity, costEvidence, decisionPolicy }) {
  const experimentCore = {
    owner: "#226_QUANT_LAB_RESEARCH_PRODUCTION_QUEUE_CACHE",
    jobType: "PRE_HOLDOUT_PROFITABILITY_GATE_V1",
    strategyId: candidateIdentity.strategyId,
    researchCodeSha: candidateIdentity.researchCodeSha,
    datasetId: candidateIdentity.datasetId,
    costPolicyVersion: candidateIdentity.costPolicyVersion,
    decisionPolicyVersion: candidateIdentity.decisionPolicyVersion,
    finalHoldoutMounted: false,
  };
  const experimentId = `experiment:${researchDigest(experimentCore)}`;
  return deepFreeze({
    status: "SPEC_ONLY_NOT_ACTIVATED",
    reusedOwner: "#226",
    jobSpec: { ...experimentCore, experimentId, expectedOutput: "IMMUTABLE_PRE_HOLDOUT_GATE_ARTIFACT" },
    datasetAndCacheReuse: {
      immutableDatasetId: candidateIdentity.datasetId,
      costEvidenceDigest: costEvidence.costEvidenceDigest,
      decisionPolicyDigest: decisionPolicy.decisionPolicyDigest,
      cacheKeys: [candidateIdentity.datasetId, costEvidence.costEvidenceDigest, decisionPolicy.decisionPolicyDigest],
      rawArchiveRedownloadRequiredOnCacheHit: false,
    },
    experimentDedup: { idempotencyKey: experimentId, duplicateExecutionPolicy: "RETURN_EXISTING_IMMUTABLE_RESULT" },
    restartSafeCheckpoint: {
      phases: ["INPUT_FINGERPRINTED", "HOLDOUT_REDACTED", "COST_STRESS_COMPLETE", "OOS_COMPLETE", "WALK_FORWARD_COMPLETE", "GATES_EVALUATED", "ARTIFACT_WRITTEN"],
      resumeOnlyWhenAllFingerprintsMatch: true,
      partialResultMayFreezeCandidate: false,
    },
    actualServerChanges: 0,
    actualJobsSubmitted: 0,
    actualProcessesRestarted: 0,
    actualTimersActivated: 0,
  });
}

export function runPreHoldoutProfitabilityGate({ momentumCsvText, sixPortfolioCsvText, researchCodeSha } = {}) {
  const momentumInput = redactFinalHoldoutRows(momentumCsvText, "MOMENTUM");
  const sixPortfolioInput = redactFinalHoldoutRows(sixPortfolioCsvText, "SIX_PORTFOLIO");
  const base = runFirstRealGlobalReplication({
    momentumCsvText: momentumInput.preHoldoutCsvText,
    sixPortfolioCsvText: sixPortfolioInput.preHoldoutCsvText,
    researchCodeSha,
  });
  const momentumRows = parseKenFrenchDevelopedMomentumCsv(momentumInput.preHoldoutCsvText);
  const oosRows = deepFreeze(momentumRows.filter((row) => row.period >= OOS_START && row.period <= OOS_END));
  if (oosRows.length !== 99) throw new Error(`PRE_HOLDOUT_OOS_COUNT_MISMATCH:${oosRows.length}`);
  const costEvidence = createPreHoldoutCostEvidence();
  const decisionPolicy = createPreHoldoutDecisionPolicy();
  const costStress = buildCostStress(oosRows, costEvidence);
  const walkForwardAfterCosts = buildAfterCostWalkForward(oosRows, costStress);
  const policyEvaluation = evaluatePolicy({ base, costEvidence, decisionPolicy, costStress, walkForwardAfterCosts });
  const strategyIdentity = base.tierLedger.strategyIdentity;
  const candidateIdentity = deepFreeze({
    strategyId: strategyIdentity.strategyId,
    strategyFamilyId: strategyIdentity.strategyFamilyId,
    parameterHash: strategyIdentity.parameterHash,
    researchCodeSha: base.researchCodeSha,
    datasetId: base.replicationAssessments[0].datasetFingerprint,
    costPolicyVersion: costEvidence.policyVersion,
    decisionPolicyVersion: decisionPolicy.policyVersion,
  });
  const frozenResearchCandidate = policyEvaluation.everyRequiredGatePassed;
  const freezeRecord = frozenResearchCandidate ? deepFreeze({ ...candidateIdentity, freezeTimestamp: "NOT_SET_UNTIL_AUTHORIZED_ONE_SHOT_FREEZE_COMMIT" }) : null;
  return deepFreeze({
    schemaVersion: PRE_HOLDOUT_PROFITABILITY_GATE_SCHEMA_VERSION,
    phase: "PRE_HOLDOUT_PROFITABILITY_GATE",
    researchCodeSha: base.researchCodeSha,
    sampleAccounting: buildSampleAccounting(base),
    costEvidence,
    costStress,
    oosAfterCosts: {
      status: "COMPLETED_PARTIAL_EMPIRICAL_PROXY_NOT_ADMISSION_GRADE",
      fixedRule: true,
      parameterRefits: 0,
      optimizationTrials: 0,
      gross: costStress[0].grossMetrics,
      scenarios: costStress,
    },
    walkForwardAfterCosts: {
      status: "COMPLETED_PARTIAL_EMPIRICAL_PROXY_NOT_ADMISSION_GRADE",
      fixedRule: true,
      parameterRefits: 0,
      optimizationTrials: 0,
      scenarios: walkForwardAfterCosts,
    },
    statisticalEvidence: base.statisticalFirewall,
    decisionPolicy,
    policyEvaluation,
    candidateIdentityPreview: candidateIdentity,
    frozenResearchCandidate,
    freezeRecord,
    finalHoldoutProtection: {
      finalHoldoutNotOpened: true,
      holdoutStartPeriod: FINAL_HOLDOUT_START,
      numericHoldoutValuesParsed: 0,
      holdoutUsedForSelection: false,
      holdoutUsedForTuning: false,
      holdoutUsedForCalibration: false,
      momentumRowsRedactedBeforeNumericParse: momentumInput.redactedObservationRows,
      sixPortfolioRowsRedactedBeforeNumericParse: sixPortfolioInput.redactedObservationRows,
      ourHoldoutN: 0,
      oneShotFinalHoldoutReady: frozenResearchCandidate,
    },
    researchProductionPlan: buildResearchProductionPlan({ candidateIdentity, costEvidence, decisionPolicy }),
    safety: {
      profitabilityProven: false,
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
      scannerEligibility: false,
      shadowActivation: false,
      paperActivation: false,
      executionAuthority: "NONE",
      actualOrders: 0,
      actualCancels: 0,
      actualAmends: 0,
      actualTransfers: 0,
      actualWithdrawals: 0,
    },
  });
}
