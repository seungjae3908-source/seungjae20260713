import {
  appendStrategyEvidenceTierEntry,
  createStrategyEvidenceTierLedger,
  summarizeStrategyEvidenceTiers,
} from "./global-alpha-literature-registry-v1.js";
import {
  auditFirstRealGlobalResearchDedup,
  buildFirstRealGlobalResearchBatch,
} from "./first-real-global-research-batch-v1.js";
import {
  createPaperReplicationAssessment,
  evaluateGlobalStrategyStatisticalFirewall,
  evaluateStrategyEconomicReality,
} from "./global-strategy-statistical-firewall-v1.js";
import { researchDigest } from "./research-trial-registry.js";

export const FIRST_REAL_GLOBAL_REPLICATION_SCHEMA_VERSION = 1;

const MOMENTUM_ARCHIVE_SHA256 = "2bee31ed74c88f01bc8c8b33327c2a8506901d1f95a3785b3237f84cfcd25109";
const SIX_PORTFOLIO_ARCHIVE_SHA256 = "75f6548f9a5de5ee90d7836fe2ae2deef38525fccb67304724cdfd135575f6ee";
const REPLICATION_START = "199011";
const REPLICATION_END = "201103";
const POST_PUBLICATION_OOS_START = "201210";
const POST_PUBLICATION_OOS_END = "202012";
const RESERVED_HOLDOUT_START = "202101";

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value;
}

function exactSha(value) {
  const sha = requiredText(value, "researchCodeSha").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new TypeError("researchCodeSha must be an exact 40-character SHA");
  return sha;
}

function nextMonth(period) {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(4, 6));
  return month === 12 ? `${year + 1}01` : `${year}${String(month + 1).padStart(2, "0")}`;
}

function validateMonthlyRows(rows, name) {
  if (rows.length < 2) throw new Error(`${name}_INSUFFICIENT_ROWS`);
  const periods = rows.map((row) => row.period);
  const duplicatePeriods = periods.filter((period, index) => periods.indexOf(period) !== index);
  if (duplicatePeriods.length) throw new Error(`${name}_DUPLICATE_PERIOD:${duplicatePeriods[0]}`);
  for (let index = 1; index < periods.length; index += 1) {
    if (periods[index] <= periods[index - 1]) throw new Error(`${name}_NOT_STRICTLY_SORTED:${periods[index]}`);
    if (periods[index] !== nextMonth(periods[index - 1])) throw new Error(`${name}_MONTH_GAP:${periods[index - 1]}:${periods[index]}`);
  }
}

function parsePercent(value, name) {
  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed === -99.99) throw new Error(`${name}_MISSING_OR_INVALID_RETURN`);
  return parsed;
}

export function parseKenFrenchDevelopedMomentumCsv(csvText) {
  const text = requiredText(csvText, "momentumCsvText");
  if (!text.includes("202606 Bloomberg database")) throw new Error("MOMENTUM_SOURCE_VERSION_MISMATCH");
  const rows = text.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(\d{6})\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    return match ? Object.freeze({ period: match[1], returnPct: parsePercent(match[2], "MOMENTUM") }) : null;
  }).filter(Boolean);
  validateMonthlyRows(rows, "MOMENTUM");
  return Object.freeze(rows);
}

export function parseKenFrenchDevelopedSixPortfolioCsv(csvText) {
  const text = requiredText(csvText, "sixPortfolioCsvText");
  if (!text.includes("202606 Bloomberg database")) throw new Error("SIX_PORTFOLIO_SOURCE_VERSION_MISMATCH");
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes("Average Value Weighted Returns -- Monthly"));
  const end = lines.findIndex((line, index) => index > start && line.includes("Average Equal Weighted Returns -- Monthly"));
  if (start < 0 || end < 0) throw new Error("SIX_PORTFOLIO_MONTHLY_SECTION_MISSING");
  const rows = lines.slice(start + 2, end).map((line) => {
    const values = line.split(",").map((value) => value.trim());
    if (!/^\d{6}$/.test(values[0] ?? "") || values.length !== 7) return null;
    const returns = values.slice(1).map((value, index) => parsePercent(value, `SIX_PORTFOLIO_${index}`));
    const [smallLoser, smallNeutral, smallWinner, bigLoser, bigNeutral, bigWinner] = returns;
    return Object.freeze({
      period: values[0],
      smallLoserPct: smallLoser,
      smallNeutralPct: smallNeutral,
      smallWinnerPct: smallWinner,
      bigLoserPct: bigLoser,
      bigNeutralPct: bigNeutral,
      bigWinnerPct: bigWinner,
      smallWmlPct: smallWinner - smallLoser,
      bigWmlPct: bigWinner - bigLoser,
      derivedWmlPct: 0.5 * ((smallWinner - smallLoser) + (bigWinner - bigLoser)),
    });
  }).filter(Boolean);
  validateMonthlyRows(rows, "SIX_PORTFOLIO");
  return Object.freeze(rows);
}

function sampleStdev(values) {
  const center = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - center) ** 2), 0) / (values.length - 1));
}

function summarize(rows, valueKey) {
  const values = rows.map((row) => row[valueKey]);
  const sampleN = values.length;
  const meanMonthlyPct = values.reduce((sum, value) => sum + value, 0) / sampleN;
  const stdevMonthlyPct = sampleStdev(values);
  let wealth = 1;
  let peak = 1;
  let maxDrawdownPct = 0;
  for (const value of values) {
    wealth *= 1 + (value / 100);
    peak = Math.max(peak, wealth);
    maxDrawdownPct = Math.min(maxDrawdownPct, ((wealth / peak) - 1) * 100);
  }
  return Object.freeze({
    sampleN,
    startPeriod: rows[0].period,
    endPeriod: rows.at(-1).period,
    meanMonthlyPct,
    stdevMonthlyPct,
    tStatistic: meanMonthlyPct / (stdevMonthlyPct / Math.sqrt(sampleN)),
    annualizedSharpe: (meanMonthlyPct / stdevMonthlyPct) * Math.sqrt(12),
    annualizedCompoundedReturnPct: ((wealth ** (12 / sampleN)) - 1) * 100,
    cumulativeReturnPct: (wealth - 1) * 100,
    maxDrawdownPct,
    positiveMonthRatePct: (values.filter((value) => value > 0).length / sampleN) * 100,
  });
}

function sliceRows(rows, start, end) {
  return Object.freeze(rows.filter((row) => row.period >= start && row.period <= end));
}

function buildWalkForward(rows) {
  const windowMonths = 36;
  const stepMonths = 12;
  const windows = [];
  for (let start = 0; start + windowMonths <= rows.length; start += stepMonths) {
    windows.push(Object.freeze({
      windowIndex: windows.length + 1,
      ...summarize(rows.slice(start, start + windowMonths), "returnPct"),
    }));
  }
  return Object.freeze({
    status: windows.length ? "COMPLETED_NOT_ADMISSION_GRADED" : "INSUFFICIENT_EVIDENCE",
    method: "FIXED_RULE_ROLLING_36_MONTH_WINDOWS_STEP_12",
    parameterRefits: 0,
    optimizationTrials: 0,
    uniqueEvaluationSampleN: rows.length,
    windowCount: windows.length,
    windows: Object.freeze(windows),
    admissionThresholdsApplied: false,
  });
}

function blockedAssessment(record, researchCodeSha, reason, datasetFingerprint) {
  return createPaperReplicationAssessment({
    researchRecord: record,
    replication: Object.freeze({
      sourceResearchId: record.researchSourceId,
      researchCodeSha,
      datasetFingerprint,
      dataProvenance: Object.freeze({ status: "UNAVAILABLE", reason }),
      parameterMappingStatus: "NOT_ATTEMPTED_DATA_UNAVAILABLE",
      metricDefinitionFingerprint: `metric-definition:${researchDigest({ status: "BLOCKED_DATA", reason })}`,
      status: "BLOCKED_DATA",
      failureReason: reason,
      metrics: null,
      ourReplicationSampleN: null,
    }),
  });
}

function appendEvidence(ledger, entry) {
  return appendStrategyEvidenceTierEntry(ledger, entry);
}

export function runFirstRealGlobalReplication({
  momentumCsvText,
  sixPortfolioCsvText,
  researchCodeSha,
  momentumArchiveSha256 = MOMENTUM_ARCHIVE_SHA256,
  sixPortfolioArchiveSha256 = SIX_PORTFOLIO_ARCHIVE_SHA256,
} = {}) {
  const started = performance.now();
  const codeSha = exactSha(researchCodeSha);
  if (String(momentumArchiveSha256).toLowerCase() !== MOMENTUM_ARCHIVE_SHA256) throw new Error("MOMENTUM_ARCHIVE_FINGERPRINT_MISMATCH");
  if (String(sixPortfolioArchiveSha256).toLowerCase() !== SIX_PORTFOLIO_ARCHIVE_SHA256) throw new Error("SIX_PORTFOLIO_ARCHIVE_FINGERPRINT_MISMATCH");

  const batch = buildFirstRealGlobalResearchBatch();
  const dedupAudit = auditFirstRealGlobalResearchDedup();
  const momentumRows = parseKenFrenchDevelopedMomentumCsv(momentumCsvText);
  const sixRows = parseKenFrenchDevelopedSixPortfolioCsv(sixPortfolioCsvText);
  if (momentumRows[0].period !== sixRows[0].period || momentumRows.at(-1).period !== sixRows.at(-1).period) {
    throw new Error("OFFICIAL_MOMENTUM_DATASETS_DATE_RANGE_MISMATCH");
  }
  const sixByPeriod = new Map(sixRows.map((row) => [row.period, row]));
  const joinedRows = Object.freeze(momentumRows.map((row) => {
    const portfolios = sixByPeriod.get(row.period);
    if (!portfolios) throw new Error(`SIX_PORTFOLIO_PERIOD_MISSING:${row.period}`);
    return Object.freeze({ ...row, ...portfolios });
  }));

  const replicationRows = sliceRows(joinedRows, REPLICATION_START, REPLICATION_END);
  if (replicationRows.length !== 245) throw new Error(`ORIGINAL_SAMPLE_COUNT_MISMATCH:${replicationRows.length}`);
  const directMetrics = summarize(replicationRows, "returnPct");
  const smallMetrics = summarize(replicationRows, "smallWmlPct");
  const bigMetrics = summarize(replicationRows, "bigWmlPct");
  const derivedMetrics = summarize(replicationRows, "derivedWmlPct");
  const maxDirectDerivedDifferencePct = Math.max(...replicationRows.map((row) => Math.abs(row.returnPct - row.derivedWmlPct)));
  if (maxDirectDerivedDifferencePct > 0.02) throw new Error("OFFICIAL_FACTOR_FORMULA_RECONCILIATION_FAILED");

  const famaRecord = batch.registry.records.find((record) => record.literatureStudy.doi === "10.1016/j.jfineco.2012.05.011");
  const brockRecord = batch.registry.records.find((record) => record.literatureStudy.doi === "10.1111/j.1540-6261.1992.tb04681.x");
  const gatevRecord = batch.registry.records.find((record) => record.literatureStudy.doi === "10.1093/rfs/hhj020");
  const datasetFingerprint = `dataset:${researchDigest({ momentumArchiveSha256: MOMENTUM_ARCHIVE_SHA256, sixPortfolioArchiveSha256: SIX_PORTFOLIO_ARCHIVE_SHA256 })}`;
  const reported = Object.freeze({
    globalWmlMonthlyMeanPct: 0.62,
    globalWmlTStatistic: 2.30,
    smallWmlMonthlyMeanPct: 0.82,
    smallWmlTStatistic: 3.14,
    bigWmlMonthlyMeanPct: 0.41,
    bigWmlTStatistic: 1.38,
  });
  const famaAssessment = createPaperReplicationAssessment({
    researchRecord: famaRecord,
    replication: Object.freeze({
      sourceResearchId: famaRecord.researchSourceId,
      researchCodeSha: codeSha,
      datasetFingerprint,
      dataProvenance: Object.freeze({
        status: "OFFICIAL_AUTHOR_DATA_LIBRARY_CURRENT_UPDATE",
        sourceDatabaseVersion: "202606 Bloomberg database",
        momentumArchiveUrl: famaRecord.sourceMetadata.datasetReference.officialMomentumArchiveUrl,
        sixPortfolioArchiveUrl: famaRecord.sourceMetadata.datasetReference.officialSixPortfolioArchiveUrl,
        momentumArchiveSha256: MOMENTUM_ARCHIVE_SHA256,
        sixPortfolioArchiveSha256: SIX_PORTFOLIO_ARCHIVE_SHA256,
        timezone: "NOT_APPLICABLE_MONTHLY_PERIOD",
      }),
      parameterMappingStatus: "EXACT_PUBLISHED_WML_FORMULA; UPDATED_AGGREGATED_INPUT_DATA",
      metricDefinitionFingerprint: `metric-definition:${researchDigest({ metric: "MONTHLY_WML_MEAN_AND_T_STATISTIC", sample: "199011_201103", units: "PERCENT" })}`,
      status: "PARTIALLY_REPLICATED",
      failureReason: "OFFICIAL_CURRENT_UPDATED_FACTOR_RETURNS_ARE_NOT_THE_ORIGINAL_FIRM_LEVEL_DATABASE; PUBLISHED_AND_CURRENT_ROUNDED_T_STATISTICS_DIFFER",
      metrics: Object.freeze({
        reported,
        ours: Object.freeze({ globalWml: directMetrics, smallWml: smallMetrics, bigWml: bigMetrics, derivedGlobalWml: derivedMetrics }),
        absoluteDifferences: Object.freeze({
          globalMeanPct: Math.abs(directMetrics.meanMonthlyPct - reported.globalWmlMonthlyMeanPct),
          globalTStatistic: Math.abs(directMetrics.tStatistic - reported.globalWmlTStatistic),
          smallMeanPct: Math.abs(smallMetrics.meanMonthlyPct - reported.smallWmlMonthlyMeanPct),
          smallTStatistic: Math.abs(smallMetrics.tStatistic - reported.smallWmlTStatistic),
          bigMeanPct: Math.abs(bigMetrics.meanMonthlyPct - reported.bigWmlMonthlyMeanPct),
          bigTStatistic: Math.abs(bigMetrics.tStatistic - reported.bigWmlTStatistic),
        }),
        formulaReconciliation: Object.freeze({ maxDirectDerivedDifferencePct, tolerancePct: 0.02, pass: true }),
      }),
      ourReplicationSampleN: replicationRows.length,
    }),
  });
  const brockAssessment = blockedAssessment(
    brockRecord,
    codeSha,
    "EXACT_DJIA_1897_1986_ADJUSTED_DAILY_SERIES_AND_RULE_PARAMETER_PACKAGE_NOT_AVAILABLE_WITH_ESTABLISHED_REDISTRIBUTION_RIGHTS",
    "unavailable:BLL1992_DJIA_1897_1986",
  );
  const gatevAssessment = blockedAssessment(
    gatevRecord,
    codeSha,
    "EXACT_CRSP_DAILY_1962_2002_SECURITY_LEVEL_DATA_REQUIRE_A_CRSP_LICENSE_NOT_PRESENT_IN_REPOSITORY",
    "unavailable:GGR2006_CRSP_DAILY_1962_2002",
  );

  const statisticalTrials = Object.freeze([
    Object.freeze({ trialId: "FF2012_GLOBAL_WML", returnSeries: Object.freeze(replicationRows.map((row) => row.returnPct / 100)) }),
    Object.freeze({ trialId: "FF2012_SMALL_WML", returnSeries: Object.freeze(replicationRows.map((row) => row.smallWmlPct / 100)) }),
    Object.freeze({ trialId: "FF2012_BIG_WML", returnSeries: Object.freeze(replicationRows.map((row) => row.bigWmlPct / 100)) }),
  ]);
  const statisticalFirewall = evaluateGlobalStrategyStatisticalFirewall({
    trials: statisticalTrials,
    selectedTrialId: "FF2012_GLOBAL_WML",
    benchmarkReturns: Array(replicationRows.length).fill(0),
    blockCount: 10,
    maxCombinations: 5000,
    realityCheckPolicy: Object.freeze({
      status: "empirically_calibrated",
      bootstrapIterations: 2000,
      blockLength: 12,
      seed: 201205011,
      alpha: 0.05,
      calibrationBasis: "MONTHLY_DATA_AND_THE_PUBLISHED_12_MONTH_MOMENTUM_SIGNAL_MEMORY",
    }),
    decisionPolicy: null,
  });

  const economicReality = evaluateStrategyEconomicReality({
    market: "DEVELOPED_STOCK",
    direction: "LONG_SHORT",
    costPolicyVersion: "FIRST_REAL_GLOBAL_COST_FIREWALL_V1",
    costs: {},
  });
  const oosRows = sliceRows(momentumRows, POST_PUBLICATION_OOS_START, POST_PUBLICATION_OOS_END);
  if (oosRows.length !== 99) throw new Error(`POST_PUBLICATION_OOS_COUNT_MISMATCH:${oosRows.length}`);
  const oosMetrics = summarize(oosRows, "returnPct");
  const walkForward = buildWalkForward(oosRows);

  let ledger = createStrategyEvidenceTierLedger({
    identity: Object.freeze({
      strategyId: "FF2012_DEVELOPED_WML_FIXED_RULE",
      strategyFamilyId: famaRecord.strategyDna.strategyFamilyId,
      strategyVersion: "PUBLISHED_RULE_V1",
      parameterHash: researchDigest({ formula: "WML_2X3_SIZE_PRIOR_12_2", parametersOptimized: false }),
      researchCodeSha: codeSha,
      market: "DEVELOPED_EQUITY_23_COUNTRIES",
      direction: "LONG_SHORT",
      timeframe: "MONTHLY",
      costPolicyVersion: "FIRST_REAL_GLOBAL_COST_FIREWALL_V1",
    }),
  });
  ledger = appendEvidence(ledger, Object.freeze({
    evidenceKind: "EXTERNAL_REPORTED_EVIDENCE",
    sampleCount: 245,
    sourceFingerprint: famaRecord.sourceMetadata.sourceFingerprint,
    evaluationSliceId: "FF2012_PUBLISHED_199011_201103",
    resultStatus: "REPORTED",
    reportedMetrics: reported,
  }));
  ledger = appendEvidence(ledger, Object.freeze({
    evidenceKind: "EXTERNAL_RAW_DATA_REFERENCE",
    sampleCount: 245,
    sourceFingerprint: datasetFingerprint,
    evaluationSliceId: "KEN_FRENCH_202606_ORIGINAL_PAPER_SLICE",
    resultStatus: "VALIDATED_EXTERNAL_DATA_REFERENCE",
    reportedMetrics: Object.freeze({ sourceDatabaseVersion: "202606 Bloomberg database" }),
  }));
  ledger = appendEvidence(ledger, Object.freeze({
    evidenceKind: "OUR_REPLICATION_ON_EXTERNAL_DATA",
    sampleCount: 245,
    sourceFingerprint: datasetFingerprint,
    evaluationSliceId: "OUR_FF2012_PARTIAL_REPLICATION_199011_201103",
    resultStatus: "PARTIALLY_REPLICATED",
    failureReason: famaAssessment.failureReason,
    deterministicMetrics: directMetrics,
  }));
  ledger = appendEvidence(ledger, Object.freeze({
    evidenceKind: "OUR_OOS",
    sampleCount: 99,
    sourceFingerprint: datasetFingerprint,
    evaluationSliceId: "POST_PUBLICATION_OOS_201210_202012",
    resultStatus: "COMPLETED_NOT_ADMISSION_GRADED",
    deterministicMetrics: oosMetrics,
  }));
  ledger = appendEvidence(ledger, Object.freeze({
    evidenceKind: "OUR_WALK_FORWARD",
    sampleCount: 99,
    sourceFingerprint: datasetFingerprint,
    evaluationSliceId: "POST_PUBLICATION_WF_201210_202012",
    resultStatus: walkForward.status,
    deterministicMetrics: Object.freeze({ method: walkForward.method, windowCount: walkForward.windowCount }),
  }));
  const tierCounts = summarizeStrategyEvidenceTiers(ledger);

  const ignoredHoldoutRows = momentumRows.filter((row) => row.period >= RESERVED_HOLDOUT_START).length;
  const completed = performance.now();
  const replicationAssessments = Object.freeze([famaAssessment, brockAssessment, gatevAssessment]);
  return Object.freeze({
    schemaVersion: FIRST_REAL_GLOBAL_REPLICATION_SCHEMA_VERSION,
    batchId: "FIRST_REAL_GLOBAL_RESEARCH_BATCH_V1",
    researchCodeSha: codeSha,
    firstRealE2ReplicationCompleted: true,
    replicationClassification: famaAssessment.status,
    researchBatch: Object.freeze({
      realExternalSourcesIngested: batch.counts.realExternalSourcesIngested,
      paperGenomeRealRecords: batch.counts.paperGenomeRealRecords,
      strategyDnaRealRecords: batch.counts.strategyDnaRealRecords,
      rawStudyCount: batch.metaAnalysis.studyCount,
      effectiveStudyCount: batch.metaAnalysis.effectiveStudyCount,
      metaAnalysisStatus: batch.metaAnalysis.status,
      pairwiseOverlap: batch.metaAnalysis.pairwiseOverlap,
      e1EvidenceSeparated: batch.evidenceSeparation.e1EvidenceSeparated,
    }),
    replicationAssessments,
    exactReplication: Object.freeze({
      status: famaAssessment.status,
      originalSample: Object.freeze({ startPeriod: REPLICATION_START, endPeriod: REPLICATION_END, sampleN: replicationRows.length }),
      reported,
      ours: famaAssessment.metrics.ours,
      formulaReconciliation: famaAssessment.metrics.formulaReconciliation,
    }),
    datasetAudit: Object.freeze({
      provenance: "KENNETH_R_FRENCH_OFFICIAL_DATA_LIBRARY",
      sourceDatabaseVersion: "202606 Bloomberg database",
      momentumArchiveSha256: MOMENTUM_ARCHIVE_SHA256,
      sixPortfolioArchiveSha256: SIX_PORTFOLIO_ARCHIVE_SHA256,
      sourceRows: momentumRows.length,
      analysisCutoffPeriod: POST_PUBLICATION_OOS_END,
      duplicatePeriods: 0,
      missingMonthlyPeriods: 0,
      missingValueMarkersInUsedSlices: 0,
      timestamps: "YYYYMM_MONTHLY_PERIOD",
      timezone: "NOT_APPLICABLE_MONTHLY_PERIOD",
      corporateActions: "SOURCE_RETURNS_INCLUDE_DIVIDENDS_AND_CAPITAL_GAINS",
      survivorshipBias: "NOT_VERIFIABLE_FROM_AGGREGATED_FACTOR_RETURNS",
      pointInTimeStatus: "NOT_VERIFIABLE_FROM_AGGREGATED_FACTOR_RETURNS",
      sessionMapping: "NOT_APPLICABLE_MONTHLY_PORTFOLIO_RETURNS",
      symbolMapping: "NOT_APPLICABLE_AGGREGATED_PORTFOLIO_RETURNS",
      licenseStatus: "PUBLIC_DOWNLOAD; REDISTRIBUTION_TERMS_NOT_REPORTED; RAW_ARCHIVES_NOT_COMMITTED",
      reservedFinalHoldout: Object.freeze({ startPeriod: RESERVED_HOLDOUT_START, status: "RESERVED_NOT_EVALUATED", evaluatedSampleN: 0, sourceRowsIgnored: ignoredHoldoutRows }),
    }),
    costs: Object.freeze({
      rawPerformance: directMetrics,
      economicReality,
      afterCostStatus: "BLOCKED_DATA",
      afterCostMetrics: null,
      reason: "COMMISSION_SPREAD_SLIPPAGE_TAX_FX_LIQUIDITY_AND_SHORT_BORROW_EVIDENCE_ARE_NOT_ALL AVAILABLE FOR THE AGGREGATED FACTOR",
    }),
    statisticalFirewall,
    oos: Object.freeze({ status: "COMPLETED_POST_PUBLICATION_FIXED_RULE", sampleN: oosRows.length, metrics: oosMetrics, optimizationTrials: 0 }),
    walkForward,
    regime: Object.freeze({ status: "INSUFFICIENT_EVIDENCE", reason: "NO_POINT_IN_TIME_REGIME_LABEL_DATASET_WAS INCLUDED", result: null }),
    tierLedger: ledger,
    tierCounts,
    tournament: Object.freeze({
      status: "STOPPED_AT_COST_AND_DECISION_POLICY_FIREWALL",
      exactReplication: famaAssessment.status,
      developmentOptimization: "NOT_RUN_FIXED_PUBLISHED_RULE",
      purgedOos: "COMPLETED_POST_PUBLICATION_FIXED_RULE",
      walkForward: walkForward.status,
      costGate: economicReality.status,
      regimeGate: "INSUFFICIENT_EVIDENCE",
      finalHoldout: "RESERVED_NOT_EVALUATED",
      frozenCandidate: null,
    }),
    evidenceFactoryMetrics: Object.freeze({
      sourceIngestionAttempts: dedupAudit.ingestionAttempts,
      sourcesAccepted: dedupAudit.acceptedSources,
      duplicateSourcesPrevented: dedupAudit.duplicatePreventedCount,
      sourceArchiveDownloads: 2,
      cacheReuseCount: 0,
      replicationAttempts: replicationAssessments.length,
      partiallyReplicated: replicationAssessments.filter((assessment) => assessment.status === "PARTIALLY_REPLICATED").length,
      blockedData: replicationAssessments.filter((assessment) => assessment.status === "BLOCKED_DATA").length,
      computeTimeMs: completed - started,
      replicationTimeMs: completed - started,
    }),
    aiCommittee: Object.freeze({ status: "AI_RESEARCH_UNAVAILABLE", actualFreeProviderCalls: 0, actualPaidProviderCalls: 0, paidFallback: false }),
    scanner: Object.freeze({ eligibleForScannerResearchConsideration: false, status: "NO_TRADE" }),
    frozenCandidate: null,
    champion: null,
    immutableHandoff: Object.freeze({ shadow: null, paper: null, reason: "NO_FROZEN_CANDIDATE" }),
    safety: Object.freeze({
      profitabilityProven: false,
      promotionAuthority: false,
      scannerAuthority: false,
      championAuthority: false,
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
      executionAuthority: "NONE",
      actualOrders: 0,
      actualCancels: 0,
      actualAmends: 0,
      actualTransfers: 0,
      actualWithdrawals: 0,
    }),
  });
}
