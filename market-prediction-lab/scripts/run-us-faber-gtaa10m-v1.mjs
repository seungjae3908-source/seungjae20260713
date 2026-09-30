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
const FRED_TB3MS_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=TB3MS";

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

async function fetchJson(url, label) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${label}_TIMEOUT`)), 20_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          accept: "application/json,text/plain,*/*",
          "accept-language": "en-US,en;q=0.9",
          "user-agent": "Mozilla/5.0 faber-gtaa-research/2.0",
        },
      });
      if (!response.ok) throw new Error(`${label}_HTTP_${response.status}`);
      return await response.json();
    } catch (error) {
      last = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw last ?? new Error(`${label}_FAILED`);
}
async function fetchText(url, label) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${label}_TIMEOUT`)), 20_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: { accept: "text/csv,text/plain,*/*", "user-agent": "faber-gtaa-research/2.0" },
      });
      if (!response.ok) throw new Error(`${label}_HTTP_${response.status}`);
      return await response.text();
    } catch (error) {
      last = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw last ?? new Error(`${label}_FAILED`);
}
async function collectYahooAdjusted(symbol) {
  const byTimestamp = new Map();
  for (const [startTime, endTime] of [[START, SPLIT], [SPLIT - 10 * 86_400_000, END]]) {
    const query = `period1=${Math.floor(startTime / 1000)}&period2=${Math.ceil(endTime / 1000)}&interval=1d&events=history&includeAdjustedClose=true`;
    let payload = null;
    let error = null;
    for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
      try {
        payload = await fetchJson(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`, "YAHOO_ADJUSTED");
        if (payload?.chart?.result?.[0]) break;
      } catch (caught) {
        error = caught;
      }
    }
    const result = payload?.chart?.result?.[0];
    if (!result) throw error ?? new Error(`YAHOO_ADJUSTED_EMPTY_${symbol}`);
    const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
    const quote = result?.indicators?.quote?.[0] ?? {};
    const adj = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
    for (let i = 0; i < timestamps.length; i += 1) {
      const timestamp = Number(timestamps[i]) * 1000;
      const open = Number(quote.open?.[i]);
      const close = Number(quote.close?.[i]);
      const adjustedClose = Number(adj?.[i]);
      if (![timestamp, open, close, adjustedClose].every(Number.isFinite)) continue;
      if (!(timestamp > 0 && open > 0 && close > 0 && adjustedClose > 0)) continue;
      const factor = adjustedClose / close;
      byTimestamp.set(timestamp, {
        timestamp,
        adjustedOpen: open * factor,
        adjustedClose,
      });
    }
  }
  const rows = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  if (rows.length < 3_500) throw new Error(`${symbol}_ADJUSTED_HISTORY_INSUFFICIENT_${rows.length}`);
  return rows;
}
async function collectTb3ms() {
  const text = await fetchText(FRED_TB3MS_URL, "FRED_TB3MS");
  const rows = text.trim().split(/\r?\n/u);
  const header = rows.shift()?.split(",") ?? [];
  const dateIndex = header.findIndex((value) => /DATE|observation_date/iu.test(value));
  const valueIndex = header.findIndex((value) => value.trim().toUpperCase() === "TB3MS");
  if (dateIndex < 0 || valueIndex < 0) throw new Error("FRED_TB3MS_SCHEMA");
  const monthly = new Map();
  for (const line of rows) {
    const cells = line.split(",");
    const date = String(cells[dateIndex] ?? "").trim();
    const annualPercent = Number(cells[valueIndex]);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(annualPercent)) continue;
    monthly.set(date.slice(0, 7), annualPercent / 1200);
  }
  if (monthly.size < 200) throw new Error(`FRED_TB3MS_INSUFFICIENT_${monthly.size}`);
  return { monthly, source: "FRED:TB3MS", approximation: "monthly simple cash return = annual discount-basis percent / 1200" };
}
function monthlyAdjustedBars(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = monthKey(row.timestamp);
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, list]) => {
    list.sort((a, b) => a.timestamp - b.timestamp);
    return {
      month,
      firstOpen: list[0].adjustedOpen,
      lastClose: list.at(-1).adjustedClose,
      dailyCount: list.length,
    };
  });
}
function cashReturnFor(month, tbills) {
  const value = tbills.get(month);
  return Number.isFinite(value) ? value : 0;
}
function sourceCloseSleeve(monthly, window, tbills) {
  const indexByMonth = new Map(monthly.map((row, index) => [row.month, index]));
  let equity = 1;
  const curve = [];
  for (const month of monthly) {
    if (!inWindow(month.month, window)) continue;
    const index = indexByMonth.get(month.month);
    if (!(index > 0)) continue;
    const priorSignal = signalAt(monthly, index - 1);
    if (priorSignal == null) continue;
    const priorClose = monthly[index - 1].lastClose;
    const monthlyReturn = priorSignal
      ? month.lastClose / priorClose - 1
      : cashReturnFor(month.month, tbills);
    equity *= 1 + monthlyReturn;
    curve.push({ month: month.month, equity, invested: priorSignal === true, monthlyReturn });
  }
  const equities = curve.map((row) => row.equity);
  return {
    months: curve.length,
    totalReturn: (equities.at(-1) ?? 1) - 1,
    annualizedReturn: annualizedReturn(1, equities.at(-1) ?? 1, curve.length),
    maxDrawdown: maxDrawdown(equities),
    investedMonthRate: curve.length ? curve.filter((row) => row.invested).length / curve.length : null,
    curve,
  };
}
function causalAdjustedSleeve(monthly, window, costPerSide, tbills) {
  const indexByMonth = new Map(monthly.map((row, index) => [row.month, index]));
  let cash = 1;
  let units = 0;
  let transactionCount = 0;
  const curve = [];

  for (const month of monthly) {
    if (!inWindow(month.month, window)) continue;
    const index = indexByMonth.get(month.month);
    if (!(index > 0)) continue;
    const desiredLong = signalAt(monthly, index - 1);
    if (desiredLong == null) continue;

    if (desiredLong && units === 0) {
      const fill = month.firstOpen * (1 + costPerSide);
      units = cash / fill;
      cash = 0;
      transactionCount += 1;
    } else if (!desiredLong && units > 0) {
      cash = units * month.firstOpen * (1 - costPerSide);
      units = 0;
      transactionCount += 1;
    }

    if (units === 0) cash *= 1 + cashReturnFor(month.month, tbills);
    const equity = cash + units * month.lastClose;
    curve.push({ month: month.month, equity, invested: units > 0 });
  }

  if (units > 0 && curve.length) {
    const lastMonth = monthly.find((row) => row.month === curve.at(-1).month);
    cash = units * lastMonth.lastClose * (1 - costPerSide);
    units = 0;
    transactionCount += 1;
    curve[curve.length - 1] = { ...curve.at(-1), equity: cash };
  }
  const equities = curve.map((row) => row.equity);
  return {
    months: curve.length,
    totalReturn: (equities.at(-1) ?? 1) - 1,
    annualizedReturn: annualizedReturn(1, equities.at(-1) ?? 1, curve.length),
    maxDrawdown: maxDrawdown(equities),
    investedMonthRate: curve.length ? curve.filter((row) => row.invested).length / curve.length : null,
    transactionCount,
    curve,
  };
}

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
  const entryFill = months[0].firstOpen * (1 + costPerSide);
  const units = 1 / entryFill;
  const curve = months.map((row, index) => {
    const gross = units * row.lastClose;
    const equity = index === months.length - 1 ? gross * (1 - costPerSide) : gross;
    return { month: row.month, equity };
  });
  const equities = curve.map((row) => row.equity);
  const totalReturn = (equities.at(-1) ?? 1) - 1;
  return {
    months: months.length,
    totalReturn,
    annualizedReturn: annualizedReturn(1, 1 + totalReturn, months.length),
    maxDrawdown: maxDrawdown(equities),
    curve,
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
  const monthSet = new Set();
  for (const result of rows) for (const row of result.curve) monthSet.add(row.month);
  const months = [...monthSet].sort();
  const curve = months.map((month) => {
    const values = rows.map((result) => result.curve.find((row) => row.month === month)?.equity ?? null);
    if (values.some((value) => !Number.isFinite(value))) return null;
    return { month, equity: mean(values) };
  }).filter(Boolean);
  const equities = curve.map((row) => row.equity);
  const totalReturn = (equities.at(-1) ?? 1) - 1;
  return {
    months: curve.length,
    totalReturn,
    annualizedReturn: annualizedReturn(1, 1 + totalReturn, curve.length),
    maxDrawdown: maxDrawdown(equities),
    curve,
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

  const tb3ms = await collectTb3ms();
  const datasets = [];
  for (const asset of ASSETS) {
    const [data, adjustedRows] = await Promise.all([
      collectLong(asset.symbol),
      collectYahooAdjusted(asset.symbol),
    ]);
    datasets.push({
      ...asset,
      ...data,
      monthly: monthlyBars(data.candles),
      adjustedMonthly: monthlyAdjustedBars(adjustedRows),
      adjustedDailyCount: adjustedRows.length,
    });
  }

  const results = {};
  const highFidelityApprox = {};
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

    const paperLike = {};
    const causal = {};
    const causalStress = {};
    for (const dataset of datasets) {
      paperLike[dataset.symbol] = sourceCloseSleeve(dataset.adjustedMonthly, window, tb3ms.monthly);
      causal[dataset.symbol] = causalAdjustedSleeve(dataset.adjustedMonthly, window, COST_PER_SIDE, tb3ms.monthly);
      causalStress[dataset.symbol] = causalAdjustedSleeve(dataset.adjustedMonthly, window, STRESS_COST_PER_SIDE, tb3ms.monthly);
    }
    highFidelityApprox[windowName] = {
      paperLikeTotalReturnCloseTbill: { portfolio: combinePortfolio(paperLike), perAsset: paperLike },
      causalTotalReturnNextOpenTbill: { portfolio: combinePortfolio(causal), perAsset: causal },
      causalStress15x: { portfolio: combinePortfolio(causalStress), perAsset: causalStress },
    };
  }

  const crossWindowStressPositive = Object.values(results).every((row) => row.stress15x.portfolio.totalReturn > 0);
  const highFidelityCrossWindowPositive = Object.values(highFidelityApprox).every((row) => row.causalStress15x.portfolio.totalReturn > 0);
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
      highFidelityApproximation: {
        adjustedCloseTotalReturnProxy: "Yahoo adjusted close; adjusted open derived with same-day adjustment factor",
        cashSeries: tb3ms.source,
        cashReturnApproximation: tb3ms.approximation,
        paperLikeExecution: "month-end adjusted close, no costs",
        causalExecution: "next-month adjusted open after completed month-end signal, explicit costs",
      },
      costPerSide: COST_PER_SIDE,
      stressCostPerSide: STRESS_COST_PER_SIDE,
    },
    data: {
      provider: "Yahoo public daily price chart",
      requestedStart: new Date(START).toISOString(),
      requestedEndExclusive: new Date(END).toISOString(),
      datasets: datasets.map((row) => ({
        ...row.report,
        assetClass: row.assetClass,
        monthlyBars: row.monthly.length,
        adjustedDailyCount: row.adjustedDailyCount,
        adjustedMonthlyBars: row.adjustedMonthly.length,
      })),
      tb3ms: {
        source: tb3ms.source,
        observations: tb3ms.monthly.size,
        approximation: tb3ms.approximation,
      },
    },
    windows: WINDOWS,
    results,
    highFidelityApprox,
    promotionAssessment: {
      status: highFidelityCrossWindowPositive
        ? "REFERENCE_CANDIDATE_REQUIRES_FUTURE_OOS"
        : "RESEARCH_HOLD_HIGH_FIDELITY_CROSS_WINDOW_FAILED",
      crossWindowStressPositive,
      highFidelityCrossWindowPositive,
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
      "The primary V1 lane remains price-only with zero cash for continuity. A second high-fidelity approximation uses Yahoo adjusted close plus FRED TB3MS cash, but TB3MS/12 is still an approximation to 90-day T-bill holding-period returns.",
      "The high-fidelity paper-like lane uses month-end adjusted close with no costs; the causal lane executes the same frozen signal at the next month's adjusted open with explicit costs.",
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
    hfPrior: report.highFidelityApprox.PRIOR.causalTotalReturnNextOpenTbill.portfolio.totalReturn,
    hfMid: report.highFidelityApprox.MID.causalTotalReturnNextOpenTbill.portfolio.totalReturn,
    hfRecent: report.highFidelityApprox.RECENT.causalTotalReturnNextOpenTbill.portfolio.totalReturn,
    hfPriorStress: report.highFidelityApprox.PRIOR.causalStress15x.portfolio.totalReturn,
    hfMidStress: report.highFidelityApprox.MID.causalStress15x.portfolio.totalReturn,
    hfRecentStress: report.highFidelityApprox.RECENT.causalStress15x.portfolio.totalReturn,
  }));
}
await main();
