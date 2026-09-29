import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  collectVisionFuturesDailyKlines,
  collectVisionFuturesFunding,
} from "../src/binance-vision-futures-archive.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse("2020-01-01T00:00:00.000Z");
const END = Date.parse("2025-12-31T23:59:59.999Z");
const SYMBOLS = Object.freeze(["BTCUSDT", "ETHUSDT"]);
const MOP_DOI = "10.1016/j.jfineco.2011.11.003";
const VOL_SCALING_CRITIQUE_DOI = "10.1016/j.finmar.2016.05.003";
const TSMOM_CRITIQUE_DOI = "10.1016/j.jfineco.2019.08.004";
const VOL_TARGET = 0.40;
const VOL_ANNUALIZATION = 261;
const EWMA_LAMBDA = 60 / 61;
const NORMAL_COST_PER_SIDE = 0.0010;
const STRESS_COST_PER_SIDE = NORMAL_COST_PER_SIDE * 1.5;
const WINDOWS = Object.freeze([
  Object.freeze({ id: "PRIOR_2021_2023", start: "2021-01", end: "2023-12" }),
  Object.freeze({ id: "RECENT_2024_2025", start: "2024-01", end: "2025-12" }),
]);

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function median(values) {
  if (!values.length) return null;
  const copy = [...values].sort((a, b) => a - b);
  const mid = Math.floor(copy.length / 2);
  return copy.length % 2 ? copy[mid] : (copy[mid - 1] + copy[mid]) / 2;
}
function std(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}
function monthKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 7);
}
function addMonths(month, offset) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1 + offset, 1)).toISOString().slice(0, 7);
}
function inWindow(month, window) {
  return month >= window.start && month <= window.end;
}
function sign(value) {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}
function compound(values) {
  return values.reduce((equity, value) => equity * (1 + value), 1) - 1;
}
function maxDrawdown(values) {
  let equity = 1;
  let peak = 1;
  let mdd = 0;
  for (const value of values) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    mdd = Math.max(mdd, (peak - equity) / peak);
  }
  return mdd;
}
function metrics(values) {
  const xs = values.filter(Number.isFinite);
  if (!xs.length) {
    return {
      months: 0,
      meanMonthlyReturn: null,
      medianMonthlyReturn: null,
      positiveMonthRate: null,
      compoundedReturn: null,
      annualizedVolatility: null,
      annualizedSharpeZeroRf: null,
      maxDrawdown: null,
      bestMonth: null,
      worstMonth: null,
    };
  }
  const volatility = std(xs);
  return {
    months: xs.length,
    meanMonthlyReturn: mean(xs),
    medianMonthlyReturn: median(xs),
    positiveMonthRate: xs.filter((value) => value > 0).length / xs.length,
    compoundedReturn: compound(xs),
    annualizedVolatility: volatility == null ? null : volatility * Math.sqrt(12),
    annualizedSharpeZeroRf: volatility && volatility > 0 ? (mean(xs) / volatility) * Math.sqrt(12) : null,
    maxDrawdown: maxDrawdown(xs),
    bestMonth: Math.max(...xs),
    worstMonth: Math.min(...xs),
  };
}
function assertDailyContinuity(candles, label) {
  for (let index = 1; index < candles.length; index += 1) {
    const delta = candles[index].timestamp - candles[index - 1].timestamp;
    if (delta !== DAY_MS) throw new Error(`${label}_DAILY_GAP_${new Date(candles[index - 1].timestamp).toISOString()}_${delta}`);
  }
}
function ewmaAnnualizedVol(candles, formationIndex) {
  if (formationIndex < 120) return null;
  const returns = [];
  for (let index = 1; index <= formationIndex; index += 1) {
    returns.push(candles[index].close / candles[index - 1].close - 1);
  }
  const newestFirst = returns.reverse();
  let weightSum = 0;
  let weightedMean = 0;
  for (let index = 0; index < newestFirst.length; index += 1) {
    const weight = (1 - EWMA_LAMBDA) * (EWMA_LAMBDA ** index);
    weightSum += weight;
    weightedMean += weight * newestFirst[index];
  }
  if (!(weightSum > 0)) return null;
  weightedMean /= weightSum;
  let variance = 0;
  for (let index = 0; index < newestFirst.length; index += 1) {
    const weight = (1 - EWMA_LAMBDA) * (EWMA_LAMBDA ** index);
    variance += weight * ((newestFirst[index] - weightedMean) ** 2);
  }
  variance /= weightSum;
  const sigma = Math.sqrt(VOL_ANNUALIZATION * variance);
  return Number.isFinite(sigma) && sigma > 0 ? sigma : null;
}
function groupMonthlyCandles(candles) {
  const map = new Map();
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const key = monthKey(candle.timestamp);
    const row = map.get(key) ?? { month: key, firstIndex: index, lastIndex: index, first: candle, last: candle };
    row.lastIndex = index;
    row.last = candle;
    map.set(key, row);
  }
  return map;
}
function fundingByMonth(records) {
  const map = new Map();
  for (const row of records) {
    const key = monthKey(row.timestamp);
    map.set(key, (map.get(key) ?? 0) + row.rate);
  }
  return map;
}
function applyPosition({ signal, priceReturn, fundingSum, positionMultiplier, costPerSide }) {
  if (signal === 0) return 0;
  const unitGross = signal * priceReturn - signal * fundingSum;
  const gross = positionMultiplier * unitGross;
  const cost = 2 * costPerSide * Math.abs(positionMultiplier);
  return gross - cost;
}
function buildAssetRows({ symbol, candles, fundingRecords }) {
  assertDailyContinuity(candles, symbol);
  const months = groupMonthlyCandles(candles);
  const funding = fundingByMonth(fundingRecords);
  const keys = [...months.keys()].sort();
  const rows = [];
  for (const formationMonth of keys) {
    const priorMonth = addMonths(formationMonth, -12);
    const holdingMonth = addMonths(formationMonth, 1);
    const formation = months.get(formationMonth);
    const prior = months.get(priorMonth);
    const holding = months.get(holdingMonth);
    if (!formation || !prior || !holding) continue;
    const past12Return = formation.last.close / prior.last.close - 1;
    const direction = sign(past12Return);
    if (direction === 0) continue;
    const sigma = ewmaAnnualizedVol(candles, formation.lastIndex);
    if (!(sigma > 0)) continue;
    const sourceScale = VOL_TARGET / sigma;
    const priceReturn = holding.last.close / holding.first.open - 1;
    const fundingSum = funding.get(holdingMonth) ?? 0;
    const sourceNormal = applyPosition({
      signal: direction,
      priceReturn,
      fundingSum,
      positionMultiplier: sourceScale,
      costPerSide: NORMAL_COST_PER_SIDE,
    });
    const sourceStress = applyPosition({
      signal: direction,
      priceReturn,
      fundingSum,
      positionMultiplier: sourceScale,
      costPerSide: STRESS_COST_PER_SIDE,
    });
    const unscaledNormal = applyPosition({
      signal: direction,
      priceReturn,
      fundingSum,
      positionMultiplier: 1,
      costPerSide: NORMAL_COST_PER_SIDE,
    });
    const unscaledStress = applyPosition({
      signal: direction,
      priceReturn,
      fundingSum,
      positionMultiplier: 1,
      costPerSide: STRESS_COST_PER_SIDE,
    });
    const buyHoldScaledNormal = applyPosition({
      signal: 1,
      priceReturn,
      fundingSum,
      positionMultiplier: sourceScale,
      costPerSide: NORMAL_COST_PER_SIDE,
    });
    const buyHoldScaledStress = applyPosition({
      signal: 1,
      priceReturn,
      fundingSum,
      positionMultiplier: sourceScale,
      costPerSide: STRESS_COST_PER_SIDE,
    });
    const buyHoldUnscaledNormal = applyPosition({
      signal: 1,
      priceReturn,
      fundingSum,
      positionMultiplier: 1,
      costPerSide: NORMAL_COST_PER_SIDE,
    });
    const buyHoldUnscaledStress = applyPosition({
      signal: 1,
      priceReturn,
      fundingSum,
      positionMultiplier: 1,
      costPerSide: STRESS_COST_PER_SIDE,
    });
    rows.push({
      symbol,
      formationMonth,
      holdingMonth,
      past12Return,
      signal: direction,
      sigma,
      sourceScale,
      priceReturn,
      fundingSum,
      sourceScaled: { normal: sourceNormal, stress: sourceStress },
      unscaled: { normal: unscaledNormal, stress: unscaledStress },
      buyHoldScaled: { normal: buyHoldScaledNormal, stress: buyHoldScaledStress },
      buyHoldUnscaled: { normal: buyHoldUnscaledNormal, stress: buyHoldUnscaledStress },
    });
  }
  return rows;
}
function portfolioRows(assetRowsBySymbol) {
  const months = [...new Set(Object.values(assetRowsBySymbol).flatMap((rows) => rows.map((row) => row.holdingMonth)))].sort();
  return months.map((month) => {
    const members = Object.entries(assetRowsBySymbol)
      .map(([symbol, rows]) => rows.find((row) => row.holdingMonth === month) ? { symbol, row: rows.find((row) => row.holdingMonth === month) } : null)
      .filter(Boolean);
    const avg = (path) => {
      const values = members.map(({ row }) => path(row)).filter(Number.isFinite);
      return values.length === members.length && values.length ? mean(values) : null;
    };
    return {
      month,
      assets: members.map(({ symbol }) => symbol),
      sourceScaledNormal: avg((row) => row.sourceScaled.normal),
      sourceScaledStress: avg((row) => row.sourceScaled.stress),
      unscaledNormal: avg((row) => row.unscaled.normal),
      unscaledStress: avg((row) => row.unscaled.stress),
      buyHoldScaledNormal: avg((row) => row.buyHoldScaled.normal),
      buyHoldScaledStress: avg((row) => row.buyHoldScaled.stress),
      buyHoldUnscaledNormal: avg((row) => row.buyHoldUnscaled.normal),
      buyHoldUnscaledStress: avg((row) => row.buyHoldUnscaled.stress),
      meanAbsoluteSourceScale: avg((row) => Math.abs(row.sourceScale)),
      maxAbsoluteSourceScale: members.length ? Math.max(...members.map(({ row }) => Math.abs(row.sourceScale))) : null,
    };
  }).filter((row) => row.assets.length === SYMBOLS.length);
}
function summarizePortfolio(rows) {
  const series = (key, filter = () => true) => rows.filter(filter).map((row) => row[key]).filter(Number.isFinite);
  const all = {};
  for (const key of [
    "sourceScaledNormal",
    "sourceScaledStress",
    "unscaledNormal",
    "unscaledStress",
    "buyHoldScaledNormal",
    "buyHoldScaledStress",
    "buyHoldUnscaledNormal",
    "buyHoldUnscaledStress",
  ]) {
    all[key] = metrics(series(key));
  }
  const windows = Object.fromEntries(WINDOWS.map((window) => [
    window.id,
    Object.fromEntries(Object.keys(all).map((key) => [key, metrics(series(key, (row) => inWindow(row.month, window)))])),
  ]));
  const diff = (left, right, filter = () => true) => {
    const values = rows.filter(filter).map((row) => {
      const l = row[left];
      const r = row[right];
      return Number.isFinite(l) && Number.isFinite(r) ? l - r : null;
    }).filter(Number.isFinite);
    return metrics(values);
  };
  return {
    all,
    windows,
    comparisons: {
      scaledTsmomMinusScaledBuyHold: diff("sourceScaledNormal", "buyHoldScaledNormal"),
      unscaledTsmomMinusUnscaledBuyHold: diff("unscaledNormal", "buyHoldUnscaledNormal"),
      sourceScaledMinusUnscaledTsmom: diff("sourceScaledNormal", "unscaledNormal"),
      scaledTsmomMinusScaledBuyHoldByWindow: Object.fromEntries(WINDOWS.map((window) => [
        window.id,
        diff("sourceScaledNormal", "buyHoldScaledNormal", (row) => inWindow(row.month, window)),
      ])),
      unscaledTsmomMinusUnscaledBuyHoldByWindow: Object.fromEntries(WINDOWS.map((window) => [
        window.id,
        diff("unscaledNormal", "buyHoldUnscaledNormal", (row) => inWindow(row.month, window)),
      ])),
    },
    exposure: {
      meanAbsoluteSourceScale: mean(rows.map((row) => row.meanAbsoluteSourceScale).filter(Number.isFinite)),
      maxAbsoluteSourceScale: rows.length ? Math.max(...rows.map((row) => row.maxAbsoluteSourceScale).filter(Number.isFinite)) : null,
      monthsAbove3xAnyAsset: rows.filter((row) => row.maxAbsoluteSourceScale > 3).length,
    },
  };
}
function selfTest() {
  const sigma = 0.20;
  const long = applyPosition({ signal: 1, priceReturn: 0.10, fundingSum: 0.01, positionMultiplier: VOL_TARGET / sigma, costPerSide: 0.001 });
  if (Math.abs(long - 0.176) > 1e-12) throw new Error(`SELFTEST_LONG_${long}`);
  const short = applyPosition({ signal: -1, priceReturn: -0.10, fundingSum: 0.01, positionMultiplier: VOL_TARGET / sigma, costPerSide: 0.001 });
  if (Math.abs(short - 0.216) > 1e-12) throw new Error(`SELFTEST_SHORT_${short}`);
  if (addMonths("2025-12", 1) !== "2026-01" || addMonths("2025-01", -12) !== "2024-01") throw new Error("SELFTEST_MONTH");
  const synthetic = [];
  let price = 100;
  for (let index = 0; index < 500; index += 1) {
    price *= 1 + (index % 2 === 0 ? 0.01 : -0.004);
    synthetic.push({ timestamp: Date.UTC(2020, 0, 1) + index * DAY_MS, close: price });
  }
  const vol = ewmaAnnualizedVol(synthetic, synthetic.length - 1);
  if (!(vol > 0)) throw new Error("SELFTEST_VOL");
  console.log("CRYPTO_TSMOM_REFERENCE_V1_SELF_TEST_OK");
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const datasets = {};
for (const symbol of SYMBOLS) {
  const [price, funding] = await Promise.all([
    collectVisionFuturesDailyKlines({
      symbol,
      startTime: START,
      endTime: END,
      concurrency: 8,
      onMonth: ({ month, rowCount }) => console.log(JSON.stringify({ symbol, stage: "klines", month, rowCount })),
    }),
    collectVisionFuturesFunding({
      symbol,
      startTime: START,
      endTime: END,
      concurrency: 8,
      onMonth: ({ month, rowCount }) => console.log(JSON.stringify({ symbol, stage: "funding", month, rowCount })),
    }),
  ]);
  assertDailyContinuity(price.candles, symbol);
  if (!price.checksumVerified || !funding.checksumVerified) throw new Error(`${symbol}_CHECKSUM_UNVERIFIED`);
  if (price.candles.length < 2_000) throw new Error(`${symbol}_PRICE_COVERAGE_${price.candles.length}`);
  if (funding.records.length < 1_000) throw new Error(`${symbol}_FUNDING_COVERAGE_${funding.records.length}`);
  datasets[symbol] = {
    candles: price.candles,
    fundingRecords: funding.records,
    priceManifests: price.manifests,
    fundingManifests: funding.manifests,
    priceCount: price.candles.length,
    fundingCount: funding.records.length,
    priceStart: price.candles[0].timestamp,
    priceEnd: price.candles.at(-1).timestamp,
    fundingStart: funding.records[0].timestamp,
    fundingEnd: funding.records.at(-1).timestamp,
  };
}

const assetRows = Object.fromEntries(SYMBOLS.map((symbol) => [
  symbol,
  buildAssetRows({
    symbol,
    candles: datasets[symbol].candles,
    fundingRecords: datasets[symbol].fundingRecords,
  }),
]));
const portfolio = portfolioRows(assetRows);
if (portfolio.length < 48) throw new Error(`PORTFOLIO_MONTHS_INSUFFICIENT_${portfolio.length}`);
const summary = summarizePortfolio(portfolio);
const report = {
  schemaVersion: 1,
  status: "pass",
  market: "CRYPTO_FUTURES",
  purpose: "source-faithful MOP 12-month time-series-momentum application baseline on crypto perpetual futures",
  sourceContract: {
    recipeId: "TIME_SERIES_MOMENTUM_V1",
    sourceDoi: MOP_DOI,
    sourceRule: "sign of own past 12-month return -> next one-month long/short return",
    sourceVolatilityTargetAnnualized: VOL_TARGET,
    sourceVolatilityEstimator: {
      annualization: VOL_ANNUALIZATION,
      ewmaLambda: EWMA_LAMBDA,
      centerOfMassDays: 60,
    },
    parameterSearch: false,
    signalStrengthSizing: false,
    sourceScaledPositionCap: null,
  },
  controls: {
    volatilityScalingCritiqueDoi: VOL_SCALING_CRITIQUE_DOI,
    timeSeriesPredictabilityCritiqueDoi: TSMOM_CRITIQUE_DOI,
    unscaledEqualWeightTsmom: true,
    scaledBuyAndHoldControl: true,
    unscaledBuyAndHoldControl: true,
  },
  transferBoundary: {
    canonicalMopReplication: false,
    reason: "crypto perpetual application using BTCUSDT/ETHUSDT only, not the paper's diversified 58 futures/forwards",
    cryptoTradesSevenDaysPerWeekButSourceAnnualization261Preserved: true,
    excessReturnIdentityExactToPaper: false,
    perpetualFundingIncluded: true,
    targetExecutionCostVenue: "Bitget research assumption",
    priceAndFundingHistoryProvider: "Binance Vision USD-M monthly public archive",
    crossVenueProxy: true,
  },
  period: {
    startInclusive: new Date(START).toISOString(),
    endInclusive: new Date(END).toISOString(),
    warmupUses2020: true,
    outcomeSelectionUsesNoGrid: true,
    reserved2026ForLaterIndependentCheck: true,
  },
  universe: {
    symbols: SYMBOLS,
    fixedBeforeOutcomeRead: true,
    currentSurvivorUniverseBiasPossible: true,
    automaticUniverseExpansionAllowed: false,
  },
  costs: {
    normalPerSide: NORMAL_COST_PER_SIDE,
    stressPerSide: STRESS_COST_PER_SIDE,
    normalRoundTripAt1x: 2 * NORMAL_COST_PER_SIDE,
    components: "fee + spread + slippage research assumption",
  },
  datasets: Object.fromEntries(SYMBOLS.map((symbol) => [symbol, {
    priceCount: datasets[symbol].priceCount,
    fundingCount: datasets[symbol].fundingCount,
    priceStart: new Date(datasets[symbol].priceStart).toISOString(),
    priceEnd: new Date(datasets[symbol].priceEnd).toISOString(),
    fundingStart: new Date(datasets[symbol].fundingStart).toISOString(),
    fundingEnd: new Date(datasets[symbol].fundingEnd).toISOString(),
    checksumVerified: true,
  }])),
  assetRows,
  portfolio,
  summary,
  decisionBoundary: {
    winnerSelectionFromObservedWindows: false,
    automaticPromotionAllowed: false,
    observedHistoryMayCountAsForward: false,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    nextRequiredEvidence: "inspect fixed source baseline versus controls, then if warranted run the already-reserved 2026 period without retuning",
  },
  safety: {
    researchOnly: true,
    publicDataOnly: true,
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
    orderRouteCalled: false,
    executionAuthority: "NONE",
    actualOrders: 0,
  },
  limitations: [
    "The original paper studies a diversified set of 58 liquid futures/forwards; this is a two-asset crypto-perpetual application test.",
    "The source 261-day annualization and 40% per-asset volatility target are preserved even though crypto trades seven days per week.",
    "Perpetual futures funding is included because crypto perpetuals differ from dated futures.",
    "Binance Vision history is used with a Bitget-oriented execution-cost assumption, so the run is a cross-venue proxy.",
    "Volatility scaling can materially drive time-series-momentum performance; scaled buy-and-hold and unscaled controls are reported explicitly.",
    "Historical replay cannot establish PROFITABILITY_PROVEN or genuine prospective Forward performance.",
  ],
};

const out = resolve(process.argv[2] ?? "docs/crypto-tsmom-reference-v1.json");
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  status: report.status,
  months: report.summary.all.sourceScaledNormal.months,
  scaledMean: report.summary.all.sourceScaledNormal.meanMonthlyReturn,
  scaledCompounded: report.summary.all.sourceScaledNormal.compoundedReturn,
  unscaledMean: report.summary.all.unscaledNormal.meanMonthlyReturn,
  scaledBuyHoldMean: report.summary.all.buyHoldScaledNormal.meanMonthlyReturn,
  unscaledBuyHoldMean: report.summary.all.buyHoldUnscaledNormal.meanMonthlyReturn,
  scaledMinusScaledBuyHold: report.summary.comparisons.scaledTsmomMinusScaledBuyHold.meanMonthlyReturn,
  unscaledMinusUnscaledBuyHold: report.summary.comparisons.unscaledTsmomMinusUnscaledBuyHold.meanMonthlyReturn,
  maxScale: report.summary.exposure.maxAbsoluteSourceScale,
}));
