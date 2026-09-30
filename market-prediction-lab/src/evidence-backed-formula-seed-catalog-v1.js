import { createSafeStrategyDslV1 } from "./autonomous-strategy-formula-generator-v1.js";

export const EVIDENCE_BACKED_FORMULA_SEED_CATALOG_VERSION = 1;
export const EVIDENCE_BACKED_REFERENCE_RECIPES_VERSION = 1;
export const EVIDENCE_BACKED_FORMULA_FAMILIES = Object.freeze([
  "TREND_BREAKOUT",
  "TIME_SERIES_MOMENTUM",
  "TREND_PULLBACK",
]);

const MARKETS = Object.freeze(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const HORIZONS = Object.freeze(["SHORT", "SWING", "POSITION"]);
const CASH_MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT"]);
const OHLCV_FIELDS = Object.freeze(["close", "high", "low", "open", "volume"]);

export const FUTURES_DERIVATIVES_EVIDENCE_REQUIREMENTS = Object.freeze([
  "MARK_PRICE",
  "INDEX_PRICE",
  "FUNDING",
  "OPEN_INTEREST",
  "BASIS",
  "LIQUIDATION_RISK",
]);

const HORIZON_CONFIG = Object.freeze({
  SHORT: Object.freeze({
    timeframe: "15m",
    emaFast: [5, 15, 5],
    emaSlow: [20, 60, 20],
    adxPeriod: [7, 21, 7],
    adxMin: [15, 25, 5],
    rocPeriod: [3, 12, 3],
    rocMin: [0, 0.02, 0.01],
    rvolPeriod: [5, 20, 5],
    rvolMin: [1, 2, 0.5],
    breakoutPeriod: [10, 40, 10],
    breakoutThreshold: [0, 1, 0.5],
    rsiPeriod: [7, 21, 7],
    rsiRecover: [25, 35, 5],
    rsiCeiling: [40, 55, 5],
    atrPeriod: [7, 21, 7],
    atrStop: [1, 2.5, 0.5],
    targetDistance: [0.005, 0.03, 0.005],
    timeBars: [4, 24, 4],
  }),
  SWING: Object.freeze({
    timeframe: "1h",
    emaFast: [10, 30, 10],
    emaSlow: [40, 100, 20],
    adxPeriod: [14, 28, 7],
    adxMin: [18, 30, 6],
    rocPeriod: [10, 30, 10],
    rocMin: [0, 0.06, 0.02],
    rvolPeriod: [10, 30, 10],
    rvolMin: [1, 2, 0.5],
    breakoutPeriod: [20, 80, 20],
    breakoutThreshold: [0, 1, 0.5],
    rsiPeriod: [7, 21, 7],
    rsiRecover: [25, 40, 5],
    rsiCeiling: [45, 60, 5],
    atrPeriod: [14, 28, 7],
    atrStop: [1.5, 3, 0.5],
    targetDistance: [0.02, 0.1, 0.02],
    timeBars: [8, 60, 4],
  }),
  POSITION: Object.freeze({
    timeframe: "1d",
    emaFast: [20, 60, 20],
    emaSlow: [80, 240, 40],
    adxPeriod: [14, 42, 14],
    adxMin: [18, 30, 6],
    rocPeriod: [20, 120, 20],
    rocMin: [0, 0.2, 0.05],
    rvolPeriod: [20, 60, 20],
    rvolMin: [1, 2, 0.5],
    breakoutPeriod: [50, 250, 50],
    breakoutThreshold: [0, 1, 0.5],
    rsiPeriod: [14, 42, 14],
    rsiRecover: [25, 40, 5],
    rsiCeiling: [50, 65, 5],
    atrPeriod: [14, 42, 14],
    atrStop: [2, 4, 0.5],
    targetDistance: [0.05, 0.3, 0.05],
    timeBars: [20, 250, 10],
  }),
});

export const EVIDENCE_BACKED_REFERENCE_RECIPES = deepFreeze([
  {
    recipeId: "QULLAMAGGIE_EP_V1",
    name: "Qullamaggie Episodic Pivot",
    origin: "PRACTITIONER_PUBLIC_METHOD",
    researchRole: "REFERENCE_RECIPE",
    markets: ["US_STOCK"],
    candidatePreparation: [
      "CATALYST_EARNINGS_GUIDANCE_OR_OTHER_REVALUATION_NEWS",
      "PREFER_3_TO_6_MONTH_SIDEWAYS_BASE",
      "PREMARKET_OR_AFTER_HOURS_GAP_SCAN",
    ],
    confirmation: {
      gapUpMinFraction: 0.10,
      massiveOpenVolumeRequired: true,
      preferredAverageDailyVolumeTradedWithinMinutes: [15, 30],
      openingRangeHighMinutes: [1, 5, 60],
    },
    riskFramework: {
      initialStopReference: "LOW_OF_DAY",
      maxInitialRiskAdrAtrMultiple: 1.5,
      trailingReferences: ["SMA_10D", "SMA_20D"],
    },
    sourceEvidence: [{
      kind: "PRACTITIONER_PRIMARY",
      title: "How to master a setup: Episodic Pivots",
      url: "https://qullamaggie.com/how-to-master-a-setup-episodic-pivots/",
      evidenceScope: "SETUP_DEFINITION_AND_PRACTITIONER_PROCESS",
      independentlyAuditedPerformance: false,
    }],
    localReplicationRequired: true,
    automaticActivationAllowed: false,
  },
  {
    recipeId: "QULLAMAGGIE_COMMON_BREAKOUT_V1",
    name: "Qullamaggie Common Breakout",
    origin: "PRACTITIONER_PUBLIC_METHOD",
    researchRole: "REFERENCE_RECIPE",
    markets: ["US_STOCK"],
    candidatePreparation: [
      "RANK_TOP_1_TO_2_PERCENT_BY_1M_3M_6M_PERFORMANCE",
      "PRIOR_LARGE_ADVANCE",
      "ORDERLY_PULLBACK_OR_CONSOLIDATION",
      "HIGHER_LOWS_AND_TIGHTENING_RANGE",
    ],
    confirmation: {
      preferredPriorMoveFractionRange: [0.30, 1.00],
      typicalConsolidationWeeksRange: [2, 8],
      risingMovingAverageContextDays: [10, 20, 50],
      openingRangeHighMinutes: [1, 5, 60],
    },
    sourceEvidence: [{
      kind: "PRACTITIONER_PRIMARY",
      title: "3 TIMELESS setups that have made me TENS OF MILLIONS!",
      url: "https://qullamaggie.com/my-3-timeless-setups-that-have-made-me-tens-of-millions/",
      evidenceScope: "SETUP_DEFINITION_AND_PRACTITIONER_PROCESS",
      independentlyAuditedPerformance: false,
    }],
    localReplicationRequired: true,
    automaticActivationAllowed: false,
  },
  {
    recipeId: "CROSS_SECTIONAL_PRICE_MOMENTUM_V1",
    name: "Cross-sectional price momentum",
    origin: "ACADEMIC_PEER_REVIEWED",
    researchRole: "REFERENCE_RECIPE",
    markets: ["US_STOCK", "KR_STOCK"],
    candidatePreparation: [
      "RANK_RECENT_WINNERS_AND_LOSERS",
      "PRESERVE_FORMATION_AND_HOLDING_WINDOW_IDENTITY",
    ],
    confirmation: {
      publishedFormationHoldingHorizonMonths: [3, 12],
      localWindowSearchRequired: true,
    },
    sourceEvidence: [{
      kind: "ACADEMIC_PEER_REVIEWED",
      title: "Returns to Buying Winners and Selling Losers: Implications for Stock Market Efficiency",
      doi: "10.1111/j.1540-6261.1993.tb04702.x",
      url: "https://onlinelibrary.wiley.com/doi/10.1111/j.1540-6261.1993.tb04702.x",
      evidenceScope: "MOMENTUM_PHENOMENON",
    }],
    localReplicationRequired: true,
    automaticActivationAllowed: false,
  },
  {
    recipeId: "PEAD_EARNINGS_SURPRISE_V1",
    name: "Post-Earnings Announcement Drift / Earnings Surprise",
    origin: "ACADEMIC_PEER_REVIEWED",
    researchRole: "REFERENCE_RECIPE",
    markets: ["US_STOCK", "KR_STOCK"],
    candidatePreparation: [
      "TIMESTAMP_EARNINGS_ANNOUNCEMENT",
      "MEASURE_EARNINGS_SURPRISE_WITH_POINT_IN_TIME_EXPECTATIONS",
      "SEPARATE_EVENT_RETURN_FROM_POST_EVENT_DRIFT",
    ],
    confirmation: {
      positiveAndNegativeSurpriseDirectionsMustRemainSeparate: true,
      localHoldingWindowCalibrationRequired: true,
    },
    sourceEvidence: [{
      kind: "ACADEMIC_PEER_REVIEWED",
      title: "Earnings expectations, investor trade size, and anomalous returns around earnings announcements",
      doi: "10.1016/j.jfineco.2004.08.002",
      url: "https://www.sciencedirect.com/science/article/pii/S0304405X05000541",
      evidenceScope: "PEAD_AND_EARNINGS_EXPECTATION_UNDERREACTION",
    }],
    localReplicationRequired: true,
    automaticActivationAllowed: false,
  },
  {
    recipeId: "FIFTY_TWO_WEEK_HIGH_MOMENTUM_V1",
    name: "52-week-high momentum",
    origin: "ACADEMIC_PEER_REVIEWED",
    researchRole: "REFERENCE_RECIPE",
    markets: ["US_STOCK", "KR_STOCK"],
    candidatePreparation: [
      "COMPUTE_POINT_IN_TIME_52_WEEK_HIGH",
      "RANK_NEARNESS_TO_52_WEEK_HIGH",
      "KEEP_PRICE_MOMENTUM_AND_52_WEEK_HIGH_SIGNALS_SEPARATE_FOR_ATTRIBUTION",
    ],
    confirmation: {
      publishedSignal: "CURRENT_PRICE_NEARNESS_TO_52_WEEK_HIGH",
      localHoldingWindowCalibrationRequired: true,
    },
    sourceEvidence: [{
      kind: "ACADEMIC_PEER_REVIEWED",
      title: "The 52-Week High and Momentum Investing",
      doi: "10.1111/j.1540-6261.2004.00695.x",
      url: "https://onlinelibrary.wiley.com/doi/10.1111/j.1540-6261.2004.00695.x",
      evidenceScope: "52_WEEK_HIGH_MOMENTUM_PHENOMENON",
    }],
    localReplicationRequired: true,
    automaticActivationAllowed: false,
  },
  {
    recipeId: "TIME_SERIES_MOMENTUM_V1",
    name: "Time-series momentum / trend following",
    origin: "ACADEMIC_PEER_REVIEWED",
    researchRole: "REFERENCE_RECIPE",
    markets: ["CRYPTO_FUTURES", "CRYPTO_SPOT", "US_STOCK", "KR_STOCK"],
    candidatePreparation: [
      "MEASURE_OWN_ASSET_PAST_RETURN_DIRECTION",
      "KEEP_LOOKBACK_AND_HOLDING_WINDOW_PRE_REGISTERED",
      "APPLY_MARKET_SPECIFIC_COST_AND_EXECUTION_MODEL",
    ],
    confirmation: {
      publishedPersistenceHorizonMonths: [1, 12],
      longShortAllowedOnlyWhereInstrumentAndPolicySupportIt: true,
    },
    sourceEvidence: [{
      kind: "ACADEMIC_PEER_REVIEWED",
      title: "Time series momentum",
      doi: "10.1016/j.jfineco.2011.11.003",
      url: "https://www.sciencedirect.com/science/article/pii/S0304405X11002613",
      evidenceScope: "TIME_SERIES_MOMENTUM_PHENOMENON",
    }],
    localReplicationRequired: true,
    automaticActivationAllowed: false,
  },
  {
    recipeId: "LIU_TSYVINSKI_WU_CRYPTO_CROSS_SECTIONAL_MOMENTUM_V1",
    name: "Crypto cross-sectional momentum quintiles",
    origin: "ACADEMIC_PEER_REVIEWED",
    researchRole: "REFERENCE_RECIPE",
    markets: ["CRYPTO_SPOT"],
    candidatePreparation: [
      "FREEZE_POINT_IN_TIME_WEEKLY_CRYPTO_UNIVERSE",
      "COMPUTE_1_2_3_4_WEEK_PAST_RETURNS",
      "SORT_WEEKLY_INTO_FIVE_CROSS_SECTIONAL_QUINTILES",
      "VALUE_WEIGHT_QUINTILE_RETURNS_WITH_POINT_IN_TIME_MARKET_CAP",
      "MEASURE_NEXT_WEEK_EXCESS_RETURN",
    ],
    confirmation: {
      publishedMomentumLookbackWeeks: [1, 2, 3, 4],
      rebalanceFrequency: "WEEKLY",
      portfolioCount: 5,
      portfolioWeighting: "VALUE_WEIGHTED",
      longPortfolio: 5,
      shortPortfolio: 1,
      publishedLongShortMeanWeeklyReturnApprox: [0.027, 0.033, 0.041, 0.025],
    },
    requiredDataEvidence: {
      pointInTimeUniverseRequired: true,
      listingDelistingHistoryRequired: true,
      weeklyMarketCapRequired: true,
      weeklyReturnHistoryRequired: true,
      currentMembershipBackfillForbidden: true,
      presentUniverseMayNotSubstituteHistoricalUniverse: true,
    },
    localReadiness: {
      status: "BLOCKED_DATA",
      blockers: [
        "CRYPTO_PIT_LISTING_DELISTING_HISTORY_NOT_MATERIALIZED",
        "CRYPTO_WEEKLY_MARKET_CAP_HISTORY_NOT_MATERIALIZED",
      ],
      currentUpbitBitgetUniverseMayCount: false,
      threeCoinProxyMayCountAsReplication: false,
    },
    sourceEvidence: [{
      kind: "ACADEMIC_PEER_REVIEWED",
      title: "Common Risk Factors in Cryptocurrency",
      doi: "10.1111/jofi.13119",
      url: "https://onlinelibrary.wiley.com/doi/10.1111/jofi.13119",
      evidenceScope: "CRYPTO_CROSS_SECTIONAL_SIZE_AND_MOMENTUM_FACTORS",
    }],
    localReplicationRequired: true,
    automaticActivationAllowed: false,
  },
  {
    recipeId: "TURTLE_SYSTEM_2_DONCHIAN_V1",
    name: "Original Turtle System 2 / Donchian trend following",
    origin: "PRACTITIONER_PUBLIC_METHOD",
    researchRole: "REFERENCE_RECIPE",
    markets: ["CRYPTO_FUTURES"],
    candidatePreparation: [
      "USE_DAILY_BARS",
      "MEASURE_20_DAY_N_VOLATILITY",
      "TAKE_EVERY_SYSTEM_2_BREAKOUT_SIGNAL",
    ],
    confirmation: {
      entryBreakoutDays: 55,
      exitBreakoutDays: 20,
      initialStopNMultiple: 2,
      addUnitEveryNMultiple: 0.5,
      maxUnits: 4,
      bothLongAndShort: true,
      priorWinnerFilterApplied: false,
    },
    riskFramework: {
      nPeriodDays: 20,
      nDefinition: "ORIGINAL_TURTLE_EXPONENTIAL_TRUE_RANGE",
      initialStopReference: "ENTRY_PLUS_OR_MINUS_2N",
      pyramidingReference: "ADD_EVERY_0_5N_IN_FAVOR",
      fixedProfitTarget: false,
    },
    sourceEvidence: [{
      kind: "PRACTITIONER_PRIMARY_PUBLIC_RULES",
      title: "The Original Turtle Trading Rules — Taught by Richard Dennis in 1983",
      url: "https://www.turtletrader.com/rules/",
      evidenceScope: "SYSTEM_2_ENTRY_EXIT_POSITION_SIZING_AND_RISK_RULES",
      independentlyAuditedPerformance: false,
    }],
    localReplicationEvidence: {
      prNumber: 1501,
      status: "RESEARCH_HOLD_CROSS_SYMBOL_GENERALIZATION_FAILED",
      exactRuleRetuningAllowed: false,
      observedWinnerSymbolSelectionAllowed: false,
    },
    localReplicationRequired: true,
    automaticActivationAllowed: false,
  },
  {
    recipeId: "CONNORS_RSI2_CLASSIC_V1",
    name: "Connors RSI(2) classic mean reversion",
    origin: "PRACTITIONER_BOOK_METHOD",
    researchRole: "REFERENCE_RECIPE",
    markets: ["US_STOCK"],
    candidatePreparation: [
      "DAILY_CLOSE_ABOVE_200_DAY_SMA",
      "RSI_2_BELOW_5",
      "LONG_ONLY",
    ],
    confirmation: {
      rsiPeriod: 2,
      rsiEntryBelow: 5,
      trendSmaDays: 200,
      exitSmaDays: 5,
      sourceEntry: "SIGNAL_DAY_CLOSE",
      sourceExit: "CLOSE_ABOVE_5_DAY_SMA",
      fixedStopInClassicBaseline: false,
    },
    sourceEvidence: [{
      kind: "PRACTITIONER_BOOK",
      title: "Short Term Trading Strategies That Work",
      authors: ["Larry Connors", "Cesar Alvarez"],
      publishedYear: 2008,
      evidenceScope: "RSI2_CLASSIC_RULE_DEFINITION",
      independentlyAuditedPerformance: false,
    }],
    localReplicationEvidence: {
      prNumber: 1503,
      status: "RESEARCH_HOLD_CROSS_SYMBOL_OR_WINDOW_GENERALIZATION_FAILED",
      causalNextOpenRequiredForExecutionClaim: true,
      sourceCloseMayCountAsExecutableFill: false,
      ruleRetuningAllowed: false,
    },
    localReplicationRequired: true,
    automaticActivationAllowed: false,
  },
  {
    recipeId: "LARRY_WILLIAMS_VOLATILITY_BREAKOUT_K05_V1",
    name: "Larry Williams volatility breakout K=0.5",
    origin: "PRACTITIONER_BOOK_METHOD",
    researchRole: "REFERENCE_RECIPE",
    markets: ["CRYPTO_SPOT"],
    candidatePreparation: [
      "DEFINE_FIXED_SESSION_BOUNDARY",
      "COMPUTE_PRIOR_SESSION_HIGH_LOW_RANGE",
      "COMPUTE_TRIGGER_AT_SESSION_OPEN",
    ],
    confirmation: {
      k: 0.5,
      trigger: "SESSION_OPEN_PLUS_K_TIMES_PRIOR_RANGE",
      direction: "LONG_ONLY",
      exit: "SAME_SESSION_CLOSE",
      stopAddedToBaseline: false,
      trendFilterAddedToBaseline: false,
    },
    sourceEvidence: [{
      kind: "PRACTITIONER_BOOK_METHOD",
      title: "Long-Term Secrets to Short-Term Trading",
      author: "Larry Williams",
      evidenceScope: "VOLATILITY_BREAKOUT_FAMILY",
      independentlyAuditedPerformance: false,
    }],
    localReplicationEvidence: {
      prNumber: 1504,
      status: "RESEARCH_HOLD_CROSS_SYMBOL_OR_WINDOW_GENERALIZATION_FAILED",
      kOptimizationAllowed: false,
      symbolSelectionAllowedAfterObservation: false,
    },
    localReplicationRequired: true,
    automaticActivationAllowed: false,
  },
  {
    recipeId: "FABER_GTAA_10M_SMA_V1",
    name: "Faber 10-month SMA tactical asset allocation",
    origin: "ACADEMIC_PEER_REVIEWED",
    researchRole: "REFERENCE_RECIPE",
    markets: ["US_STOCK"],
    candidatePreparation: [
      "EVALUATE_MONTH_END_ONLY",
      "COMPARE_MONTHLY_PRICE_TO_10_MONTH_SMA",
      "USE_SAME_RULE_ACROSS_ASSET_CLASS_SLEEVES",
    ],
    confirmation: {
      movingAverageMonths: 10,
      longRule: "MONTH_END_PRICE_GT_10M_SMA",
      cashRule: "MONTH_END_PRICE_LE_10M_SMA",
      rebalanceFrequency: "MONTHLY",
      parameterSearchAllowed: false,
    },
    sourceEvidence: [{
      kind: "ACADEMIC_PEER_REVIEWED",
      title: "A Quantitative Approach to Tactical Asset Allocation",
      author: "Meb Faber",
      ssrnAbstractId: "962461",
      url: "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=962461",
      evidenceScope: "TEN_MONTH_SMA_TACTICAL_ASSET_ALLOCATION",
    }],
    localReplicationEvidence: {
      prNumber: 1506,
      status: "REFERENCE_CANDIDATE_REQUIRES_FUTURE_OOS",
      causalNextOpenUsed: true,
      adjustedPriceApproximationUsed: true,
      treasuryBillCashApproximationUsed: true,
      crossWindowStressPositive: true,
      leaveOneAssetOutStressPositive: true,
      ruleRetuningAllowed: false,
    },
    localReplicationRequired: true,
    automaticActivationAllowed: false,
  },
  {
    recipeId: "ORB_STANDALONE_COST_CONTROL_V1",
    name: "Standalone opening-range breakout cost control",
    origin: "PRE_REGISTERED_WORKING_PAPER",
    researchRole: "NEGATIVE_CONTROL",
    markets: ["US_FUTURES"],
    candidatePreparation: [
      "DO_NOT_TREAT_SESSION_OPEN_BREAKOUT_AS_SUFFICIENT_EDGE",
      "USE_AS_COST_AND_FALSE_DISCOVERY_CONTROL",
    ],
    confirmation: {
      preRegisteredCells: 225,
      marketsStudied: 9,
      simpleCellsPassingPositiveBarAfterCosts: 0,
    },
    sourceEvidence: [{
      kind: "PRE_REGISTERED_WORKING_PAPER",
      title: "Opening-Range Breakout Does Not Survive Trading Costs: A Pre-Registered 225-Cell Study on Sixteen Years of Futures Data",
      ssrnAbstractId: "7428398",
      url: "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=7428398",
      evidenceScope: "COST_SENSITIVITY_AND_NEGATIVE_CONTROL",
    }],
    localReplicationRequired: true,
    automaticActivationAllowed: false,
  },
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function profileId(market, horizon) {
  return `${market}:${horizon}`;
}

function parameter(name, domain, valueType, range) {
  const [min, max, step] = range;
  return { name, domain, valueType, min, max, step };
}

function period(name, range) {
  return parameter(name, "PERIOD", "INTEGER", range);
}

function number(name, domain, range) {
  return parameter(name, domain, "NUMBER", range);
}

function bars(name, range) {
  return parameter(name, "BAR_COUNT", "INTEGER", range);
}

const paramNode = (name) => ({ kind: "PARAMETER", name });
const indicator = (name, input, parameters = {}) => ({ kind: "INDICATOR", name, input, parameters });
const op = (operator, operands) => ({ kind: "OPERATOR", operator, operands });

function commonExit(config) {
  return {
    parameters: [
      period("atrPeriod", config.atrPeriod),
      number("atrStop", "POSITIVE_MULTIPLIER", config.atrStop),
      number("targetDistance", "PRICE_FRACTION", config.targetDistance),
      bars("timeBars", config.timeBars),
    ],
    exitDsl: {
      rules: [
        {
          type: "ATR_STOP",
          atrIndicator: indicator("ATR", "ohlc", { period: "atrPeriod" }),
          multiplierParameter: "atrStop",
        },
        { type: "TARGET", distanceParameter: "targetDistance" },
        { type: "TIME_EXIT", barsParameter: "timeBars" },
      ],
    },
  };
}

function familyCore(family, config) {
  if (family === "TREND_BREAKOUT") {
    return {
      strategyFamily: "TREND_BREAKOUT",
      parameters: [
        period("emaFast", config.emaFast),
        period("emaSlow", config.emaSlow),
        period("adxPeriod", config.adxPeriod),
        number("adxMin", "NON_NEGATIVE_VALUE", config.adxMin),
        period("breakoutPeriod", config.breakoutPeriod),
        number("breakoutThreshold", "NON_NEGATIVE_VALUE", config.breakoutThreshold),
        period("rvolPeriod", config.rvolPeriod),
        number("rvolMin", "NON_NEGATIVE_VALUE", config.rvolMin),
      ],
      entryDsl: {
        action: "LONG",
        rules: [
          op("GT", [
            indicator("EMA", "close", { period: "emaFast" }),
            indicator("EMA", "close", { period: "emaSlow" }),
          ]),
          op("GT", [indicator("ADX", "ohlc", { period: "adxPeriod" }), paramNode("adxMin")]),
          op("GT", [indicator("BREAKOUT", "close", { period: "breakoutPeriod" }), paramNode("breakoutThreshold")]),
          op("GT", [indicator("RVOL", "volume", { period: "rvolPeriod" }), paramNode("rvolMin")]),
        ],
      },
    };
  }
  if (family === "TIME_SERIES_MOMENTUM") {
    return {
      strategyFamily: "TIME_SERIES_MOMENTUM",
      parameters: [
        period("emaFast", config.emaFast),
        period("emaSlow", config.emaSlow),
        period("rocPeriod", config.rocPeriod),
        number("rocMin", "NON_NEGATIVE_VALUE", config.rocMin),
        period("adxPeriod", config.adxPeriod),
        number("adxMin", "NON_NEGATIVE_VALUE", config.adxMin),
      ],
      entryDsl: {
        action: "LONG",
        rules: [
          op("GT", [
            indicator("EMA", "close", { period: "emaFast" }),
            indicator("EMA", "close", { period: "emaSlow" }),
          ]),
          op("GT", [indicator("ROC", "close", { period: "rocPeriod" }), paramNode("rocMin")]),
          op("GT", [indicator("ADX", "ohlc", { period: "adxPeriod" }), paramNode("adxMin")]),
        ],
      },
    };
  }
  if (family === "TREND_PULLBACK") {
    return {
      strategyFamily: "TREND_PULLBACK",
      parameters: [
        period("emaFast", config.emaFast),
        period("emaSlow", config.emaSlow),
        period("adxPeriod", config.adxPeriod),
        number("adxMin", "NON_NEGATIVE_VALUE", config.adxMin),
        period("rsiPeriod", config.rsiPeriod),
        number("rsiRecover", "RSI_LEVEL", config.rsiRecover),
        number("rsiCeiling", "RSI_LEVEL", config.rsiCeiling),
      ],
      entryDsl: {
        action: "LONG",
        rules: [
          op("GT", [
            indicator("EMA", "close", { period: "emaFast" }),
            indicator("EMA", "close", { period: "emaSlow" }),
          ]),
          op("GT", [indicator("ADX", "ohlc", { period: "adxPeriod" }), paramNode("adxMin")]),
          op("CROSSOVER", [indicator("RSI", "close", { period: "rsiPeriod" }), paramNode("rsiRecover")]),
          op("LT", [indicator("RSI", "close", { period: "rsiPeriod" }), paramNode("rsiCeiling")]),
        ],
      },
    };
  }
  throw new RangeError(`UNKNOWN_FORMULA_FAMILY:${family}`);
}

function buildRawDsl(profile, family) {
  const config = HORIZON_CONFIG[profile.horizon];
  const familyDefinition = familyCore(family, config);
  const exit = commonExit(config);
  const raw = {
    market: profile.market,
    timeframe: profile.timeframe,
    direction: "LONG",
    availableDataFields: OHLCV_FIELDS,
    entryDsl: familyDefinition.entryDsl,
    exitDsl: exit.exitDsl,
    parameterSpace: [...familyDefinition.parameters, ...exit.parameters],
    limits: {
      maxAstDepth: 6,
      maxIndicatorCount: 8,
      maxRuleCount: 8,
      maxAstNodes: 64,
    },
  };
  createSafeStrategyDslV1(raw);
  return { raw, strategyFamily: familyDefinition.strategyFamily };
}

function makeProfile(market, horizon) {
  const config = HORIZON_CONFIG[horizon];
  const futures = market === "CRYPTO_FUTURES";
  return deepFreeze({
    profileId: profileId(market, horizon),
    market,
    horizon,
    timeframe: config.timeframe,
    directions: futures ? ["LONG", "SHORT"] : ["LONG"],
    status: futures ? "BLOCKED_DERIVATIVES_EVIDENCE" : "READY",
    formulaFamilies: futures ? [] : [...EVIDENCE_BACKED_FORMULA_FAMILIES],
    requiredDerivativesEvidence: futures ? [...FUTURES_DERIVATIVES_EVIDENCE_REQUIREMENTS] : [],
    blockers: futures ? ["DERIVATIVES_FORMULA_EVIDENCE_CONTRACT_REQUIRED"] : [],
  });
}

const PROFILES = deepFreeze(MARKETS.flatMap((market) => HORIZONS.map((horizon) => makeProfile(market, horizon))));

function catalogSafety() {
  return deepFreeze({
    researchCandidateOnly: true,
    tournamentValidationRequired: true,
    profitabilityClaimAllowed: false,
    formulaPassed: false,
    scannerRuntimeMutationAllowed: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  });
}

export function buildEvidenceBackedFormulaSeedCatalogV1() {
  return deepFreeze({
    schemaVersion: EVIDENCE_BACKED_FORMULA_SEED_CATALOG_VERSION,
    contract: "evidence-backed-formula-seed-catalog/v1",
    profileCount: PROFILES.length,
    readyProfileCount: PROFILES.filter((profile) => profile.status === "READY").length,
    blockedProfileCount: PROFILES.filter((profile) => profile.status !== "READY").length,
    profiles: PROFILES,
    families: EVIDENCE_BACKED_FORMULA_FAMILIES,
    futuresEvidenceRequirements: FUTURES_DERIVATIVES_EVIDENCE_REQUIREMENTS,
    referenceRecipeVersion: EVIDENCE_BACKED_REFERENCE_RECIPES_VERSION,
    referenceRecipeCount: EVIDENCE_BACKED_REFERENCE_RECIPES.length,
    referenceRecipes: EVIDENCE_BACKED_REFERENCE_RECIPES,
    safety: catalogSafety(),
  });
}

function normalizeBinding(raw) {
  const binding = {
    hypothesisId: requiredText(raw?.hypothesisId, "hypothesisBinding.hypothesisId"),
    hypothesisConfigHash: requiredText(raw?.hypothesisConfigHash, "hypothesisBinding.hypothesisConfigHash"),
    decisionId: requiredText(raw?.decisionId, "hypothesisBinding.decisionId"),
    decisionHash: requiredText(raw?.decisionHash, "hypothesisBinding.decisionHash"),
  };
  return deepFreeze(binding);
}

export function createEvidenceBackedFormulaTemplatesV1({ profileId: requestedProfileId, hypothesisBinding } = {}) {
  const id = requiredText(requestedProfileId, "profileId").toUpperCase();
  const profile = PROFILES.find((candidate) => candidate.profileId === id);
  if (!profile) throw new RangeError(`UNKNOWN_FORMULA_SEED_PROFILE:${id}`);
  const binding = normalizeBinding(hypothesisBinding);
  if (profile.status !== "READY") {
    return deepFreeze({
      status: profile.status,
      profile,
      templates: [],
      blockers: [...profile.blockers],
      safety: catalogSafety(),
    });
  }
  if (!CASH_MARKETS.has(profile.market)) throw new Error("NON_CASH_PROFILE_REQUIRES_DERIVATIVES_CONTRACT");
  const templates = EVIDENCE_BACKED_FORMULA_FAMILIES.map((family) => {
    const { raw, strategyFamily } = buildRawDsl(profile, family);
    return deepFreeze({
      templateId: `evidence-seed-${profile.market.toLowerCase()}-${profile.horizon.toLowerCase()}-${family.toLowerCase().replaceAll("_", "-")}-v1`,
      hypothesisBinding: binding,
      strategyFamily,
      market: profile.market,
      timeframe: profile.timeframe,
      direction: "LONG",
      entryDsl: raw.entryDsl,
      exitDsl: raw.exitDsl,
      parameterSpace: raw.parameterSpace,
      limits: raw.limits,
    });
  });
  return deepFreeze({
    status: "READY",
    profile,
    templates,
    blockers: [],
    safety: catalogSafety(),
  });
}
