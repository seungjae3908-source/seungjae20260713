import {
  appendGlobalStrategyResearchRecord,
  createGlobalStrategyResearchRegistry,
  createLiteratureStudy,
  createResearchSourceMetadata,
  verifyGlobalStrategyResearchRegistry,
} from "./global-alpha-literature-registry-v1.js";
import {
  buildExternalEvidenceMetaAnalysis,
  createExternalStudyEvidence,
} from "./external-evidence-meta-analysis-v1.js";

export const FIRST_REAL_GLOBAL_RESEARCH_BATCH_SCHEMA_VERSION = 1;
export const FIRST_REAL_GLOBAL_RESEARCH_INGESTED_AT = "2026-08-21T00:46:40.000Z";

const FRENCH_MOMENTUM_ARCHIVE_SHA256 = "2bee31ed74c88f01bc8c8b33327c2a8506901d1f95a3785b3237f84cfcd25109";
const FRENCH_SIX_PORTFOLIO_ARCHIVE_SHA256 = "75f6548f9a5de5ee90d7836fe2ae2deef38525fccb67304724cdfd135575f6ee";

const FAMA_FRENCH_2012 = Object.freeze({
  study: Object.freeze({
    studyId: "FAMA_FRENCH_2012_INTERNATIONAL_SIZE_VALUE_MOMENTUM",
    title: "Size, value, and momentum in international stock returns",
    authors: Object.freeze(["Eugene F. Fama", "Kenneth R. French"]),
    venue: "Journal of Financial Economics 105(3), 457-472",
    publishedYear: 2012,
    doi: "10.1016/j.jfineco.2012.05.011",
    sourceUrl: "https://www.sciencedirect.com/science/article/pii/S0304405X12000931",
    market: "DEVELOPED_EQUITY_23_COUNTRIES",
    strategyFamily: "CROSS_SECTIONAL_MOMENTUM",
    strategySummary: "Monthly value-weighted winner-minus-loser portfolios formed from developed-market stocks sorted on size and prior returns.",
    formulaSummary: "WML = 0.5 * (Small Winner + Big Winner) - 0.5 * (Small Loser + Big Loser).",
    sample: Object.freeze({
      startDate: "1990-11-01",
      endDate: "2011-03-31",
      observationCount: 245,
      marketCount: 23,
    }),
    reportedMetrics: Object.freeze({}),
    validation: Object.freeze({
      outOfSample: false,
      walkForward: false,
      finalHoldout: false,
      transactionCostsIncluded: null,
      slippageIncluded: null,
      fundingIncluded: null,
      independentReplicationCount: 0,
      contradictoryEvidenceCount: 0,
    }),
  }),
  source: Object.freeze({
    publication: "Journal of Financial Economics",
    publicationDate: "2012-09-01",
    canonicalUrl: "https://doi.org/10.1016/j.jfineco.2012.05.011",
    sourceType: "PEER_REVIEWED_JOURNAL",
    assetClass: "STOCK",
    marketsStudied: Object.freeze(["ASIA_PACIFIC_EX_JAPAN", "EUROPE", "JAPAN", "NORTH_AMERICA"]),
    sampleN: 245,
    timeframe: "MONTHLY",
    horizon: "PRIOR_MONTHS_T_MINUS_12_TO_T_MINUS_2; ONE_MONTH_REBALANCE",
    strategyConcept: "DEVELOPED_MARKET_SIZE_VALUE_AND_MOMENTUM",
    transactionCostAssumptions: null,
    statedLimitations: Object.freeze([
      "THE BROAD 23-COUNTRY SAMPLE IS SHORT RELATIVE TO LONG US SAMPLES",
      "THE PAPER'S ORIGINAL FIRM-LEVEL BLOOMBERG/DATASTREAM/WORLDSCOPE INPUTS ARE NOT IN THIS REPOSITORY",
    ]),
    datasetReference: Object.freeze({
      datasetId: "KEN_FRENCH_DEVELOPED_MOMENTUM_202606",
      officialDescriptionUrl: "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/Data_Library/f-f_developed_mom.html",
      officialMomentumArchiveUrl: "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/Developed_Mom_Factor_CSV.zip",
      officialSixPortfolioArchiveUrl: "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/Developed_6_Portfolios_ME_Prior_12_2_CSV.zip",
      momentumArchiveSha256: FRENCH_MOMENTUM_ARCHIVE_SHA256,
      sixPortfolioArchiveSha256: FRENCH_SIX_PORTFOLIO_ARCHIVE_SHA256,
      sourceDatabaseVersion: "202606 Bloomberg database",
      rawFirmLevelDataAvailable: false,
    }),
    licenseStatus: "PUBLIC_DOWNLOAD; REDISTRIBUTION_TERMS_NOT_REPORTED",
    provenanceStatus: "DOCUMENTED_OFFICIAL_AUTHOR_DATA_LIBRARY",
    sourceProvenance: Object.freeze({
      publisherPage: "https://www.sciencedirect.com/science/article/pii/S0304405X12000931",
      authorDataLibrary: "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html",
      authorMethodPage: "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/Data_Library/f-f_developed_mom.html",
    }),
    ingestionTimestamp: FIRST_REAL_GLOBAL_RESEARCH_INGESTED_AT,
    parserVersion: "FIRST_REAL_GLOBAL_RESEARCH_BATCH_V1",
  }),
  genome: Object.freeze({
    universe: Object.freeze({ value: "STOCKS IN 23 DEVELOPED COUNTRIES GROUPED INTO FOUR REGIONS", locator: "Paper Section 2, Data and variables" }),
    market: Object.freeze({ value: "NORTH AMERICA, EUROPE, JAPAN, ASIA PACIFIC EX JAPAN", locator: "Publisher abstract and Paper Section 2" }),
    assetClass: Object.freeze({ value: "STOCK", locator: "Paper title and Section 2" }),
    timeframe: Object.freeze({ value: "MONTHLY", locator: "Author Data Library developed momentum construction" }),
    horizon: Object.freeze({ value: "PRIOR RETURN T-12 TO T-2; MONTHLY REBALANCE", locator: "Author Data Library developed momentum construction" }),
    direction: Object.freeze({ value: "LONG WINNERS; SHORT LOSERS", locator: "Paper momentum definition and Author Data Library WML formula" }),
    dataRequirements: Object.freeze({ value: Object.freeze(["MONTHLY TOTAL RETURNS", "MARKET CAPITALIZATION", "PRIOR RETURN HISTORY"]), locator: "Paper Section 2 and Author Data Library method" }),
    features: Object.freeze({ value: Object.freeze(["SIZE", "PRIOR_RETURN_T_MINUS_12_TO_T_MINUS_2"]), locator: "Author Data Library developed momentum construction" }),
    formula: Object.freeze({ value: "WML = 0.5 * (SW + BW) - 0.5 * (SL + BL)", locator: "Author Data Library developed momentum construction" }),
    signalCondition: Object.freeze({ value: "WINNER TOP 30%; LOSER BOTTOM 30% USING REGIONAL BIG-STOCK MOMENTUM BREAKPOINTS", locator: "Author Data Library developed momentum construction" }),
    entryRule: Object.freeze({ value: "FORM SIX VALUE-WEIGHTED 2x3 SIZE-MOMENTUM PORTFOLIOS AT EACH MONTH END", locator: "Author Data Library developed momentum construction" }),
    exitRule: Object.freeze({ value: "RECONSTITUTE MONTHLY", locator: "Author Data Library developed momentum construction" }),
    sizingRule: Object.freeze({ value: "VALUE_WEIGHT WITHIN PORTFOLIOS; EQUAL_WEIGHT SMALL AND BIG WINNER-LOSER SPREADS", locator: "Author Data Library developed momentum construction" }),
    rebalanceRule: Object.freeze({ value: "MONTHLY", locator: "Author Data Library developed momentum construction" }),
    costAssumptions: Object.freeze({ status: "NOT_REPORTED", locator: null }),
    benchmark: Object.freeze({ value: "ZERO RETURN FOR WML SUMMARY MEAN TEST", locator: "Paper Table 1 summary-statistic definition" }),
    parameterStructure: Object.freeze({ value: Object.freeze({ sizeGroups: 2, momentumGroups: 3, winnerLoserBreakpointsPct: Object.freeze([30, 70]), lookbackMonths: 11, skipMostRecentMonth: true }), locator: "Author Data Library developed momentum construction" }),
    reportedSampleCount: Object.freeze({ value: 245, locator: "Paper tables: November 1990 to March 2011" }),
    reportedReturn: Object.freeze({ value: Object.freeze({ globalWmlMonthlyMeanPct: 0.62, tStatistic: 2.30, smallWmlMonthlyMeanPct: 0.82, smallTStatistic: 3.14, bigWmlMonthlyMeanPct: 0.41, bigTStatistic: 1.38 }), locator: "Paper Table 1 and results text" }),
    statisticalTests: Object.freeze({ value: Object.freeze(["T_STATISTIC", "GRS_TEST", "HOTELLING_T2"]), locator: "Paper Sections 4-6" }),
    knownLimitations: Object.freeze({ value: Object.freeze(["SHORT INTERNATIONAL SAMPLE", "EXTREME MOMENTUM PORTFOLIOS REMAIN DIFFICULT FOR FOUR-FACTOR MODELS"]), locator: "Paper Sections 2 and 8" }),
  }),
  direction: "POSITIVE",
});

const BROCK_LAKONISHOK_LEBARON_1992 = Object.freeze({
  study: Object.freeze({
    studyId: "BROCK_LAKONISHOK_LEBARON_1992_TECHNICAL_RULES",
    title: "Simple Technical Trading Rules and the Stochastic Properties of Stock Returns",
    authors: Object.freeze(["William Brock", "Josef Lakonishok", "Blake LeBaron"]),
    venue: "The Journal of Finance 47(5), 1731-1764",
    publishedYear: 1992,
    doi: "10.1111/j.1540-6261.1992.tb04681.x",
    sourceUrl: "https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1540-6261.1992.tb04681.x",
    market: "US_DJIA_INDEX",
    strategyFamily: "TECHNICAL_TREND_AND_BREAKOUT",
    strategySummary: "Moving-average and trading-range-break rules tested on the Dow Jones Index.",
    formulaSummary: null,
    sample: Object.freeze({ startDate: "1897-01-01", endDate: "1986-12-31", assetCount: 1, marketCount: 1 }),
    reportedMetrics: Object.freeze({}),
    validation: Object.freeze({
      outOfSample: null,
      walkForward: false,
      finalHoldout: false,
      transactionCostsIncluded: null,
      slippageIncluded: null,
      fundingIncluded: null,
      independentReplicationCount: 0,
      contradictoryEvidenceCount: 0,
    }),
  }),
  source: Object.freeze({
    publication: "The Journal of Finance",
    publicationDate: "1992-12-01",
    canonicalUrl: "https://doi.org/10.1111/j.1540-6261.1992.tb04681.x",
    sourceType: "PEER_REVIEWED_JOURNAL",
    assetClass: "EQUITY_INDEX",
    marketsStudied: Object.freeze(["UNITED_STATES"]),
    timeframe: "DAILY",
    strategyConcept: "MOVING_AVERAGE_AND_TRADING_RANGE_BREAK",
    statedLimitations: Object.freeze(["SINGLE DOW JONES INDEX SAMPLE"]),
    datasetReference: Object.freeze({
      datasetId: "BLL1992_DJIA_1897_1986",
      describedDataset: "Dow Jones Index, 1897-1986",
      exactAdjustedSeriesAccess: "NOT_FOUND_IN_REPOSITORY_OR_AN_OFFICIAL_OPEN_REPLICATION_PACKAGE",
    }),
    licenseStatus: "EXACT_REPLICATION_DATA_LICENSE_NOT_ESTABLISHED",
    provenanceStatus: "PAPER_DOCUMENTED; EXACT_DATA_UNAVAILABLE",
    sourceProvenance: Object.freeze({
      publisherPage: "https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1540-6261.1992.tb04681.x",
      evidenceLocator: "Publisher abstract",
    }),
    ingestionTimestamp: FIRST_REAL_GLOBAL_RESEARCH_INGESTED_AT,
    parserVersion: "FIRST_REAL_GLOBAL_RESEARCH_BATCH_V1",
  }),
  genome: Object.freeze({
    universe: Object.freeze({ value: "DOW JONES INDEX", locator: "Publisher abstract" }),
    market: Object.freeze({ value: "UNITED STATES EQUITY INDEX", locator: "Publisher abstract" }),
    assetClass: Object.freeze({ value: "EQUITY_INDEX", locator: "Publisher abstract" }),
    timeframe: Object.freeze({ value: "DAILY", locator: "Paper study design" }),
    direction: Object.freeze({ value: "BUY AND SELL SIGNALS", locator: "Publisher abstract" }),
    features: Object.freeze({ value: Object.freeze(["MOVING_AVERAGE", "TRADING_RANGE_BREAK"]), locator: "Publisher abstract" }),
    signalCondition: Object.freeze({ value: "MOVING-AVERAGE OR TRADING-RANGE-BREAK SIGNAL", locator: "Publisher abstract", confidence: "MEDIUM", extractionStatus: "AMBIGUOUS" }),
    reportedReturn: Object.freeze({ value: Object.freeze({ qualitative: "BUY SIGNALS CONSISTENTLY GENERATE HIGHER RETURNS THAN SELL SIGNALS" }), locator: "Publisher abstract" }),
    statisticalTests: Object.freeze({ value: Object.freeze(["STANDARD_STATISTICAL_ANALYSIS", "BOOTSTRAP_AGAINST_FOUR NULL MODELS"]), locator: "Publisher abstract" }),
    knownLimitations: Object.freeze({ value: Object.freeze(["ONLY THE DOW JONES INDEX IS IDENTIFIED IN THE ABSTRACT"]), locator: "Publisher abstract" }),
  }),
  direction: "POSITIVE",
});

const GATEV_GOETZMANN_ROUWENHORST_2006 = Object.freeze({
  study: Object.freeze({
    studyId: "GATEV_GOETZMANN_ROUWENHORST_2006_PAIRS",
    title: "Pairs Trading: Performance of a Relative-Value Arbitrage Rule",
    authors: Object.freeze(["Evan Gatev", "William N. Goetzmann", "K. Geert Rouwenhorst"]),
    venue: "The Review of Financial Studies 19(3), 797-827",
    publishedYear: 2006,
    doi: "10.1093/rfs/hhj020",
    sourceUrl: "https://academic.oup.com/rfs/article-abstract/19/3/797/1646694",
    market: "US_COMMON_STOCKS",
    strategyFamily: "PAIRS_MEAN_REVERSION",
    strategySummary: "Pairs are selected by minimum distance between normalized historical prices and traded as relative-value mean reversion.",
    formulaSummary: null,
    sample: Object.freeze({ startDate: "1962-01-01", endDate: "2002-12-31", marketCount: 1 }),
    reportedMetrics: Object.freeze({ annualReturnPct: 11 }),
    validation: Object.freeze({
      outOfSample: null,
      walkForward: null,
      finalHoldout: false,
      transactionCostsIncluded: true,
      slippageIncluded: null,
      fundingIncluded: null,
      independentReplicationCount: 0,
      contradictoryEvidenceCount: 0,
    }),
  }),
  source: Object.freeze({
    publication: "The Review of Financial Studies",
    publicationDate: "2006-02-13",
    canonicalUrl: "https://doi.org/10.1093/rfs/hhj020",
    sourceType: "PEER_REVIEWED_JOURNAL",
    assetClass: "STOCK",
    marketsStudied: Object.freeze(["UNITED_STATES"]),
    timeframe: "DAILY",
    strategyConcept: "RELATIVE_VALUE_PAIRS_MEAN_REVERSION",
    transactionCostAssumptions: Object.freeze({ status: "QUALITATIVE_ONLY", description: "The abstract says profits typically exceed conservative transaction-cost estimates; exact dimensions are not reported there." }),
    statedLimitations: Object.freeze([]),
    datasetReference: Object.freeze({
      datasetId: "GGR2006_CRSP_DAILY_1962_2002",
      describedDataset: "CRSP daily US common-stock data, 1962-2002",
      exactDataAccess: "CRSP_LICENSE_REQUIRED",
    }),
    licenseStatus: "PROPRIETARY_CRSP_LICENSE_REQUIRED",
    provenanceStatus: "PAPER_DOCUMENTED; EXACT_DATA_UNAVAILABLE",
    sourceProvenance: Object.freeze({
      publisherPage: "https://academic.oup.com/rfs/article-abstract/19/3/797/1646694",
      evidenceLocator: "Publisher abstract",
    }),
    ingestionTimestamp: FIRST_REAL_GLOBAL_RESEARCH_INGESTED_AT,
    parserVersion: "FIRST_REAL_GLOBAL_RESEARCH_BATCH_V1",
  }),
  genome: Object.freeze({
    universe: Object.freeze({ value: "US COMMON STOCKS", locator: "Publisher abstract and paper data description" }),
    market: Object.freeze({ value: "UNITED STATES EQUITIES", locator: "Publisher abstract" }),
    assetClass: Object.freeze({ value: "STOCK", locator: "Publisher abstract" }),
    timeframe: Object.freeze({ value: "DAILY", locator: "Publisher abstract" }),
    direction: Object.freeze({ value: "MARKET-NEUTRAL LONG-SHORT PAIRS", locator: "Paper strategy description", confidence: "MEDIUM" }),
    dataRequirements: Object.freeze({ value: Object.freeze(["DAILY STOCK PRICES", "HISTORICAL NORMALIZED PRICE PATHS", "CRSP SECURITY HISTORY"]), locator: "Publisher abstract and paper data description" }),
    features: Object.freeze({ value: Object.freeze(["MINIMUM_DISTANCE_BETWEEN_NORMALIZED_HISTORICAL_PRICES"]), locator: "Publisher abstract" }),
    formula: Object.freeze({ value: "MATCH STOCKS INTO PAIRS BY MINIMUM DISTANCE BETWEEN NORMALIZED HISTORICAL PRICES", locator: "Publisher abstract" }),
    signalCondition: Object.freeze({ value: "TEMPORARY RELATIVE-PRICE DIVERGENCE OF A PRESELECTED PAIR", locator: "Publisher abstract", confidence: "MEDIUM", extractionStatus: "AMBIGUOUS" }),
    costAssumptions: Object.freeze({ value: Object.freeze({ status: "QUALITATIVE_ONLY", description: "CONSERVATIVE TRANSACTION-COST ESTIMATES" }), locator: "Publisher abstract" }),
    reportedReturn: Object.freeze({ value: Object.freeze({ annualizedExcessReturnPctUpTo: 11 }), locator: "Publisher abstract" }),
    statisticalTests: Object.freeze({ value: Object.freeze(["BOOTSTRAP"]), locator: "Publisher abstract" }),
  }),
  direction: "POSITIVE",
});

const STUDY_SPECS = Object.freeze([
  FAMA_FRENCH_2012,
  BROCK_LAKONISHOK_LEBARON_1992,
  GATEV_GOETZMANN_ROUWENHORST_2006,
]);

function genomeField(raw, researchSourceId) {
  if (raw?.status === "NOT_REPORTED") return Object.freeze({ extractionStatus: "NOT_REPORTED" });
  const extractionStatus = raw.extractionStatus ?? "SUPPORTED";
  return Object.freeze({
    value: raw.value,
    sourceProvenance: Object.freeze({ researchSourceId, locator: raw.locator }),
    confidence: raw.confidence ?? "HIGH",
    extractionStatus,
  });
}

function buildRecordInput(spec, ingestionTimestamp) {
  const study = createLiteratureStudy(spec.study);
  const source = Object.freeze({ ...spec.source, ingestionTimestamp });
  const preview = createResearchSourceMetadata({ study, source });
  const paperGenome = Object.freeze(Object.fromEntries(Object.entries(spec.genome).map(([name, raw]) => [
    name,
    genomeField(raw, preview.researchSourceId),
  ])));
  return Object.freeze({ study: spec.study, source, paperGenome });
}

export function firstRealGlobalResearchSourceSpecs() {
  return STUDY_SPECS;
}

export function auditFirstRealGlobalResearchDedup({ ingestionTimestamp = FIRST_REAL_GLOBAL_RESEARCH_INGESTED_AT } = {}) {
  const batch = buildFirstRealGlobalResearchBatch({ ingestionTimestamp });
  let duplicateRejected = false;
  let rejectionReason = null;
  try {
    appendGlobalStrategyResearchRecord(batch.registry, buildRecordInput(STUDY_SPECS[0], ingestionTimestamp));
  } catch (error) {
    duplicateRejected = /^DUPLICATE_RESEARCH_SOURCE:/.test(error?.message ?? "");
    rejectionReason = error?.message ?? "UNKNOWN_REJECTION";
  }
  if (!duplicateRejected) throw new Error("FIRST_REAL_GLOBAL_RESEARCH_DEDUP_AUDIT_FAILED");
  return Object.freeze({
    ingestionAttempts: STUDY_SPECS.length + 1,
    acceptedSources: STUDY_SPECS.length,
    duplicatePreventedCount: 1,
    duplicateRejected,
    rejectionReason,
  });
}

export function buildFirstRealGlobalResearchBatch({ ingestionTimestamp = FIRST_REAL_GLOBAL_RESEARCH_INGESTED_AT } = {}) {
  let registry = createGlobalStrategyResearchRegistry({ registryId: "FIRST_REAL_GLOBAL_RESEARCH_BATCH_V1" });
  for (const spec of STUDY_SPECS) {
    registry = appendGlobalStrategyResearchRecord(registry, buildRecordInput(spec, ingestionTimestamp));
  }
  if (!verifyGlobalStrategyResearchRegistry(registry)) throw new Error("FIRST_REAL_GLOBAL_RESEARCH_REGISTRY_INVALID");

  const externalStudyEvidence = Object.freeze(registry.records.map((researchRecord, index) => createExternalStudyEvidence({
    researchRecord,
    effectEvidence: Object.freeze({
      status: "DIRECTION_ONLY",
      metric: null,
      effectDefinition: null,
      effectScale: null,
      direction: STUDY_SPECS[index].direction,
    }),
    independenceEvidence: Object.freeze({ status: "NOT_ESTABLISHED" }),
  })));
  const metaAnalysis = buildExternalEvidenceMetaAnalysis(externalStudyEvidence);

  return Object.freeze({
    schemaVersion: FIRST_REAL_GLOBAL_RESEARCH_BATCH_SCHEMA_VERSION,
    batchId: "FIRST_REAL_GLOBAL_RESEARCH_BATCH_V1",
    ingestionTimestamp,
    registry,
    externalStudyEvidence,
    metaAnalysis,
    counts: Object.freeze({
      realExternalSourcesIngested: registry.records.length,
      paperGenomeRealRecords: registry.records.length,
      strategyDnaRealRecords: registry.records.length,
      rawStudyCount: metaAnalysis.studyCount,
      effectiveStudyCount: metaAnalysis.effectiveStudyCount,
      externalPaperN: registry.records.reduce((sum, record) => sum + (record.sourceMetadata.sampleN ?? 0), 0),
      e2ReplicationN: 0,
      e3NaturalShadowN: 0,
      e4NaturalPaperN: 0,
    }),
    evidenceSeparation: Object.freeze({
      e1EvidenceSeparated: true,
      externalMetricsCanBecomeOurMetrics: false,
      externalSampleCanBecomeOurSample: false,
      e1Records: registry.records.length,
      e2Records: 0,
      e3Records: 0,
      e4Records: 0,
    }),
    sourceArchives: Object.freeze({
      frenchMomentumArchiveSha256: FRENCH_MOMENTUM_ARCHIVE_SHA256,
      frenchSixPortfolioArchiveSha256: FRENCH_SIX_PORTFOLIO_ARCHIVE_SHA256,
      rawArchivesCommitted: false,
    }),
    safety: Object.freeze({
      eligibleForScannerResearchConsideration: false,
      profitabilityProven: false,
      frozenCandidate: null,
      champion: null,
      shadowHandoff: null,
      paperHandoff: null,
      executionAuthority: "NONE",
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
      actualOrders: 0,
      actualCancels: 0,
      actualAmends: 0,
      actualTransfers: 0,
      actualWithdrawals: 0,
    }),
  });
}
