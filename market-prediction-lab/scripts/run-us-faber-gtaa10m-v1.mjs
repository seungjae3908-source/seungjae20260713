import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";

const START = Date.parse("2006-01-01T00:00:00.000Z");
const END = Date.parse("2026-09-01T00:00:00.000Z");
const SPLIT = Date.parse("2017-01-01T00:00:00.000Z");
const COST_PER_SIDE = 0.0015;
const STRESS_COST_PER_SIDE = COST_PER_SIDE * 1.5;
const ASSETS = Object.freeze([
  Object.freeze({ symbol: "SPY", assetClass: "US_STOCKS" }),
  Object.freeze({ symbol: "EFA", assetClass: "FOREIGN_STOCKS" }),
  Object.freeze({ symbol: "IEF", assetClass: "BONDS" }),
  Object.freeze({ symbol: "VNQ", assetClass: "REAL_ESTATE" }),
  Object.freeze({ symbol: "DBC", assetClass: "COMMODITIES" }),
]);
const RULE = Object.freeze({
  id: "FABER_GTAA_10M_SMA_V1",
  movingAverageMonths: 10,
  updateFrequency: "MONTHLY",
  longRule: "MONTH_END_CLOSE_GT_10M_SMA",
  cashRule: "MONTH_END_CLOSE_LE_10M_SMA",
  equalWeightPerSleeve: 0.20,
});
const WINDOWS = Object.freeze({
  PRIOR: Object.freeze({ start: "2007-01", endExclusive: "2013-01" }),
  MID: Object.freeze({ start: "2013-01", endExclusive: "2019-01" }),
  RECENT: Object.freeze({ start: "2019-01", endExclusive: "2026-09" }),
});
const SOURCE_SSRN = "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=962461";
const SOURCE_RULES = "https://mebfaber.com/2017/12/13/episode-86-quantitative-approach-tactical-asset-allocation/";

function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function maxDrawdown(equity) {
  let peak = equity[0] ?? 1;
  let max = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    max = Math.max(max, peak > 0 ? (peak - value) / peak : 1);
  }
  return max;
}
function annualizedReturn(start, end, months) {
  if (!(start > 0 && end > 0 && months > 0)) return null;
  return Math.pow(end / start, 12 / months) - 1;
}
function monthKey(ms) { return new Date(ms).toISOString().slice(0, 7); }

async function collectLong(symbol) {
  const parts = [];
  for (const [startTime, endTime] of [[START, SPLIT], [SPLIT - 10 * 86_400_000, END]]) {
    parts.push(await collectYahooStockHistory({
      market: "US_STOCK",
      symbol,
      startTime,
      endTime,
      timeoutMs: 20_000,
    }));
  }
  const byTimestamp = new Map();
  for (const part of parts) for (const candle of part.candles) byTimestamp.set(candle.timestamp, candle);
  const candles = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  if (candles.length < 3_500) throw new Error(`${symbol}_INSUFFICIENT_HISTORY_${candles.length}`);
  return {
    symbol,
    candles,
    report: {
      symbol,
      source: "yahoo-public-chart",
      candleCount: candles.length,
      firstDate: new Date(candles[0].timestamp).toISOString().slice(0, 10),
      lastDate: new Date(candles.at(-1).timestamp).toISOString().slice(0, 10),
    },
  };
}
function monthlyBars(candles) {
  const map = new Map();
  for (const candle of candles) {
    const key = monthKey(candle.timestamp);
    const rows = map.get(key) ?? [];
    rows.push(candle);
    map.set(key, rows);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, rows]) => {
    rows.sort((a, b) => a.timestamp - b.timestamp);
    return {
      month,
      firstOpen: rows[0].open,
      lastClose: rows.at(-1).close,
      lastTimestamp: rows.at(-1).timestamp,
      dailyCount: rows.length,
    };
  });
}
function smaMonths(monthly, endIndex, period) {
  if (endIndex - period + 1 < 0) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i += 1) sum += monthly[i].lastClose;
  return sum / period;
}
function signalAt(monthly, index) {
  const ma = smaMonths(monthly, index, RULE.movingAverageMonths);
  if (!(ma > 0)) return null;
  return monthly[index].lastClose > ma;
}
function inWindow(month, window) { return month >= window.start && month < window.endExclusive; }

function simulateSleeve(monthly, window, costPerSide) {
  const months = monthly.filter((row) => inWindow(row.month, window));
  if (months.length < 12) return null;

  let cash = 1;
  let units = 0;
  let desiredLong = false;
  let priorSignal = null;
  let transactionCount = 0;
  let turnoverCost = 0;
  const equityCurve = [];

  for (const month of monthly) {
    const originalIndex = monthly.findIndex((row) => row.month === month.month);
    if (originalIndex <= 0) continue;

    if (inWindow(month.month, window)) {
      if (priorSignal === true && units === 0) {
        const fill = month.firstOpen * (1 + costPerSide);
        units = cash / fill;
        turnoverCost += cash - units * month.firstOpen;
        cash = 0;
        transactionCount += 1;
      } else if (priorSignal === false && units > 0) {
        const gross = units * month.firstOpen;
        const proceeds = gross * (1 - costPerSide);
        turnoverCost += gross - proceeds;
        cash = proceeds;
        units = 0;
        transactionCount += 1;
      }
      const equity = cash + units * month.lastClose;
      equityCurve.push({ month: month.month, equity, invested: units > 0 });
    }

    desiredLong = signalAt(monthly, originalIndex);
    priorSignal = desiredLong;
  }

  if (units > 0 && equityCurve.length) {
    const lastMonth = months.at(-1);
    const gross = units * lastMonth.lastClose;
    const proceeds = gross * (1 - costPerSide);
    turnoverCost += gross - proceeds;
    cash = proceeds;
    units = 0;
    transactionCount += 1;
    equityCurve[equityCurve.length - 1] = { ...equityCurve.at(-1), equity: cash };
  }

  const equities = equityCurve.map((row) => row.equity);
  return {
    months: equityCurve.length,
    finalEquity: equities.at(-1) ?? 1,
    totalReturn: (equities.at(-1) ?? 1) - 1,
    annualizedReturn: annualizedReturn(1, equities.at(-1) ?? 1, equityCurve.length),
    maxDrawdown: maxDrawdown(equities),
    investedMonthRate: equityCurve.length ? equityCurve.filter((row) => row.invested).length / equityCurve.length : null,
    transactionCount,
    turnoverCost,
    curve: equityCurve,
  };
}
function buyHoldSleeve(monthly, window, costPerSide) {
  const months = monthly.filter((row) => inWindow(row.month, window));
  if (months.length < 2) return null;
  const entry = months[0].firstOpen * (1 + costPerSide);
  const exit = months.at(-1).lastClose * (1 - costPerSide);
  const totalReturn = exit / entry - 1;
  return {
    months: months.length,
    totalReturn,
    annualizedReturn: annualizedReturn(1, 1 + totalReturn, months.length),
  };
}
function combinePortfolio(perAsset) {
  const monthSet = new Set();
  for (const result of Object.values(perAsset)) for (const row of result.curve) monthSet.add(row.month);
  const months = [...monthSet].sort();
  const curve = months.map((month) => {
    const values = Object.values(perAsset).map((result) => result.curve.find((row) => row.month === month)?.equity ?? null);
    if (values.some((value) => !Number.isFinite(value))) return null;
    return { month, equity: mean(values), investedSleeves: Object.values(perAsset).filter((result) => result.curve.find((row) => row.month === month)?.invested).length };
  }).filter(Boolean);
  const equities = curve.map((row) => row.equity);
  return {
    months: curve.length,
    finalEquity: equities.at(-1) ?? 1,
    totalReturn: (equities.at(-1) ?? 1) - 1,
    annualizedReturn: annualizedReturn(1, equities.at(-1) ?? 1, curve.length),
    maxDrawdown: maxDrawdown(equities),
    meanInvestedSleeves: curve.length ? mean(curve.map((row) => row.investedSleeves)) : null,
    curve,
  };
}
function combineBuyHold(perAsset) {
  const rows = Object.values(perAsset);
  return {
    totalReturn: mean(rows.map((row) => row.totalReturn)),
    annualizedReturn: mean(rows.map((row) => row.annualizedReturn)),
  };
}
function selfTest() {
  const rows = [];
  let price = 100;
  for (let i = 0; i < 18; i += 1) {
    price *= i < 12 ? 1.02 : 0.95;
    rows.push({ month: `2024-${String(i + 1).padStart(2, "0")}`, firstOpen: price, lastClose: price, lastTimestamp: i, dailyCount: 20 });
  }
  if (!(smaMonths(rows, 10, 10) > 0)) throw new Error("SELFTEST_SMA");
  if (signalAt(rows, 10) !== true) throw new Error("SELFTEST_SIGNAL");
  console.log("FABER_GTAA_SELF_TEST_OK");
}
async function main() {
  if (process.argv.includes("--self-test")) { selfTest(); return; }

  const datasets = [];
  for (const asset of ASSETS) {
    const data = await collectLong(asset.symbol);
    datasets.push({ ...asset, ...data, monthly: monthlyBars(data.candles) });
  }

  const results = {};
  for (const [windowName, window] of Object.entries(WINDOWS)) {
    const normal = {};
    const stress = {};
    const buyHold = {};
    for (const dataset of datasets) {
      normal[dataset.symbol] = simulateSleeve(dataset.monthly, window, COST_PER_SIDE);
      stress[dataset.symbol] = simulateSleeve(dataset.monthly, window, STRESS_COST_PER_SIDE);
      buyHold[dataset.symbol] = buyHoldSleeve(dataset.monthly, window, COST_PER_SIDE);
    }
    results[windowName] = {
      normal: { portfolio: combinePortfolio(normal), perAsset: normal },
      stress15x: { portfolio: combinePortfolio(stress), perAsset: stress },
      priceOnlyBuyHold: { portfolio: combineBuyHold(buyHold), perAsset: buyHold },
    };
  }

  const crossWindowStressPositive = Object.values(results).every((row) => row.stress15x.portfolio.totalReturn > 0);
  const report = {
    schemaVersion: 1,
    status: "pass",
    recipeId: RULE.id,
    purpose: "source-first Faber 10-month SMA tactical allocation baseline on five ETF asset-class proxies",
    source: {
      ssrn: SOURCE_SSRN,
      ruleReference: SOURCE_RULES,
      originalAssetClasses: ["US stocks", "foreign stocks", "bonds", "real estate", "commodities"],
      originalRule: "monthly price above 10-month SMA = long; below = cash; equal-weight five sleeves; update once monthly",
      originalUsesTotalReturnData: true,
      originalCashProxy: "90-day Treasury bills",
      originalIgnoresTradingCosts: true,
    },
    implementation: {
      parameterSearch: false,
      ruleRetuning: false,
      assets: ASSETS,
      signal: "month-end price > 10-month SMA",
      execution: "next calendar month's first trading-day open after completed month-end signal",
      cashReturnAssumption: 0,
      priceReturnOnly: true,
      dividendsIncluded: false,
      treasuryBillCashReturnIncluded: false,
      costPerSide: COST_PER_SIDE,
      stressCostPerSide: STRESS_COST_PER_SIDE,
    },
    data: {
      provider: "Yahoo public daily price chart",
      requestedStart: new Date(START).toISOString(),
      requestedEndExclusive: new Date(END).toISOString(),
      datasets: datasets.map((row) => ({ ...row.report, assetClass: row.assetClass, monthlyBars: row.monthly.length })),
    },
    windows: WINDOWS,
    results,
    promotionAssessment: {
      status: crossWindowStressPositive ? "REFERENCE_CANDIDATE_REQUIRES_FUTURE_OOS" : "RESEARCH_HOLD_CROSS_WINDOW_GENERALIZATION_FAILED",
      crossWindowStressPositive,
      automaticPromotionAllowed: false,
      economicSampleCredit: 0,
      profitabilityClaimAllowed: false,
      movingAverageRetuningAllowedAfterObservation: false,
      assetReplacementAllowedAfterObservation: false,
    },
    safeguards: {
      researchOnly: true,
      publicDataOnly: true,
      actualOrders: 0,
      orderRouteCalled: false,
      privateAccountRequestAllowed: false,
      executionAuthority: "NONE",
      liveExecutionAllowed: false,
    },
    limitations: [
      "This ETF implementation is not an exact replication of the paper because Yahoo price OHLC excludes total-return distributions and cash earns 0% instead of 90-day T-bill returns.",
      "Execution is shifted to the next month's first open for causality; the original paper describes signal-day close execution.",
      "DBC/VNQ/EFA/IEF/SPY are ETF proxies for the five original asset classes, not the original index series.",
      "No 6/8/12-month alternative is tested because that would be parameter search after observing the result.",
      "Historical replay cannot change PROFITABILITY_PROVEN or create Forward/OOS economic credit.",
    ],
  };

  const out = resolve(process.argv[2] ?? "docs/us-faber-gtaa10m-v1.json");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({
    status: report.status,
    promotionStatus: report.promotionAssessment.status,
    prior: report.results.PRIOR.normal.portfolio,
    mid: report.results.MID.normal.portfolio,
    recent: report.results.RECENT.normal.portfolio,
    priorStress: report.results.PRIOR.stress15x.portfolio.totalReturn,
    midStress: report.results.MID.stress15x.portfolio.totalReturn,
    recentStress: report.results.RECENT.stress15x.portfolio.totalReturn,
  }));
}
await main();
