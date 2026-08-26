import { createSafeStrategyDslV1 } from "./autonomous-strategy-formula-generator-v1.js";

export const EVIDENCE_BACKED_FORMULA_SEED_CATALOG_VERSION = 1;
export const EVIDENCE_BACKED_FORMULA_FAMILIES = Object.freeze([
  "TREND_ADX",
  "MOMENTUM_RVOL",
  "BREAKOUT_RVOL",
  "MEAN_REVERSION_RECOVERY",
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
    timeframe: "60m",
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
  if (family === "TREND_ADX") {
    return {
      strategyFamily: "TREND_ADX",
      parameters: [
        period("emaFast", config.emaFast),
        period("emaSlow", config.emaSlow),
        period("adxPeriod", config.adxPeriod),
        number("adxMin", "NON_NEGATIVE_VALUE", config.adxMin),
      ],
      entryDsl: {
        action: "LONG",
        rules: [
          op("CROSSOVER", [
            indicator("EMA", "close", { period: "emaFast" }),
            indicator("EMA", "close", { period: "emaSlow" }),
          ]),
          op("GT", [indicator("ADX", "ohlc", { period: "adxPeriod" }), paramNode("adxMin")]),
        ],
      },
    };
  }
  if (family === "MOMENTUM_RVOL") {
    return {
      strategyFamily: "MOMENTUM_RVOL",
      parameters: [
        period("rocPeriod", config.rocPeriod),
        number("rocMin", "NON_NEGATIVE_VALUE", config.rocMin),
        period("rvolPeriod", config.rvolPeriod),
        number("rvolMin", "NON_NEGATIVE_VALUE", config.rvolMin),
      ],
      entryDsl: {
        action: "LONG",
        rules: [
          op("GT", [indicator("ROC", "close", { period: "rocPeriod" }), paramNode("rocMin")]),
          op("GT", [indicator("RVOL", "volume", { period: "rvolPeriod" }), paramNode("rvolMin")]),
        ],
      },
    };
  }
  if (family === "BREAKOUT_RVOL") {
    return {
      strategyFamily: "BREAKOUT_RVOL",
      parameters: [
        period("breakoutPeriod", config.breakoutPeriod),
        number("breakoutThreshold", "NON_NEGATIVE_VALUE", config.breakoutThreshold),
        period("rvolPeriod", config.rvolPeriod),
        number("rvolMin", "NON_NEGATIVE_VALUE", config.rvolMin),
      ],
      entryDsl: {
        action: "LONG",
        rules: [
          op("GT", [indicator("BREAKOUT", "close", { period: "breakoutPeriod" }), paramNode("breakoutThreshold")]),
          op("GT", [indicator("RVOL", "volume", { period: "rvolPeriod" }), paramNode("rvolMin")]),
        ],
      },
    };
  }
  if (family === "MEAN_REVERSION_RECOVERY") {
    return {
      strategyFamily: "MEAN_REVERSION_RECOVERY",
      parameters: [
        period("rsiPeriod", config.rsiPeriod),
        number("rsiRecover", "RSI_LEVEL", config.rsiRecover),
        number("rsiCeiling", "RSI_LEVEL", config.rsiCeiling),
      ],
      entryDsl: {
        action: "LONG",
        rules: [
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
