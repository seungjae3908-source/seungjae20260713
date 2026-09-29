import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import { simulateStockPullbackStrategy } from "../src/stock-pullback-optimizer.js";

const DAY = 86_400_000;
const EVAL_START = Date.parse("2026-03-29T00:00:00.000Z");
const EVAL_END = Date.parse("2026-09-29T00:00:00.000Z");
const WARMUP_START = EVAL_START - 420 * DAY;
const SYMBOLS = Object.freeze(["AAPL","MSFT","NVDA","AMZN","GOOGL","META","JPM","XOM"]);
const PARAMS = Object.freeze({
  trendMaPeriod: 200,
  slopeLookback: 5,
  pullbackLookback: 5,
  minPullbackAtr: 0.5,
  maxPullbackAtr: 2.5,
  atrStopMultiplier: 2.5,
  rewardRisk: 2,
  maxHoldBars: 10,
  minRelativeVolume: 1,
  maxGapPercent: 4,
});
const NORMAL_COST = 0.0015;
const STRESS_COST = NORMAL_COST * 1.5;

function aggregate(trades) {
  const ordered = [...trades].sort((a,b) => a.entryTime - b.entryTime || a.symbol.localeCompare(b.symbol));
  const returns = ordered.map((t) => t.netReturn).filter(Number.isFinite);
  const wins = returns.filter((x) => x > 0);
  const losses = returns.filter((x) => x < 0);
  const grossProfit = wins.reduce((a,b) => a+b,0);
  const grossLoss = Math.abs(losses.reduce((a,b) => a+b,0));
  let equity = 1, peak = 1, maxDrawdown = 0;
  for (const r of returns) {
    equity *= Math.max(0.000001, 1 + r);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  return {
    tradeCount: returns.length,
    winRate: returns.length ? wins.length / returns.length : 0,
    expectancy: returns.length ? returns.reduce((a,b)=>a+b,0) / returns.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
    maxDrawdown,
    tradeChainNetReturn: equity - 1,
  };
}

function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
}

function monthly(trades) {
  const groups = new Map();
  for (const t of trades) {
    const k = monthKey(t.exitTime);
    const rows = groups.get(k) ?? [];
    rows.push(t);
    groups.set(k, rows);
  }
  return Object.fromEntries([...groups.entries()].sort().map(([k,rows]) => [k, aggregate(rows)]));
}

function maxConcurrent(trades) {
  const events = [];
  for (const t of trades) {
    events.push([t.entryTime, 1]);
    events.push([t.exitTime + 1, -1]);
  }
  events.sort((a,b) => a[0]-b[0] || a[1]-b[1]);
  let active = 0, max = 0;
  for (const [,delta] of events) { active += delta; max = Math.max(max, active); }
  return max;
}

async function run(costRatePerSide) {
  const perSymbol = {};
  const allTrades = [];
  for (const symbol of SYMBOLS) {
    const history = await collectYahooStockHistory({
      market: "US_STOCK",
      symbol,
      startTime: WARMUP_START,
      endTime: EVAL_END,
    });
    const candles = history.candles;
    const startIndex = candles.findIndex((c) => c.timestamp >= EVAL_START);
    let endIndex = candles.length - 1;
    while (endIndex >= 0 && candles[endIndex].timestamp >= EVAL_END) endIndex -= 1;
    if (startIndex < 0 || endIndex <= startIndex) throw new Error(`SIX_MONTH_WINDOW_MISSING:${symbol}`);
    const simulation = simulateStockPullbackStrategy({
      candles,
      params: PARAMS,
      costRatePerSide,
      startIndex,
      endIndex,
    });
    const trades = simulation.trades.map((t) => ({
      symbol,
      ...t,
      entryTime: candles[t.entryIndex].timestamp,
      exitTime: candles[t.exitIndex].timestamp,
    }));
    perSymbol[symbol] = {
      firstBar: new Date(candles[startIndex].timestamp).toISOString(),
      lastBar: new Date(candles[endIndex].timestamp).toISOString(),
      candleCount: endIndex - startIndex + 1,
      metrics: simulation.metrics,
      tradeCount: trades.length,
    };
    allTrades.push(...trades);
  }
  const equalWeightEightSymbolReturn =
    Object.values(perSymbol).reduce((sum, row) => sum + (1 + row.metrics.netReturn), 0) / SYMBOLS.length - 1;
  return {
    metrics: aggregate(allTrades),
    equalWeightEightSymbolReturn,
    maxConcurrentPositions: maxConcurrent(allTrades),
    monthly: monthly(allTrades),
    perSymbol,
    trades: allTrades.map(({symbol,entryTime,exitTime,netReturn,exitReason}) => ({
      symbol,
      entryTime: new Date(entryTime).toISOString(),
      exitTime: new Date(exitTime).toISOString(),
      netReturn,
      exitReason,
    })),
  };
}

const output = resolve(process.argv[2] ?? "docs/us-pullback-six-month-fixed-v1.json");
const normalCost = await run(NORMAL_COST);
const stressedCost = await run(STRESS_COST);
const report = {
  schemaVersion: 1,
  status: "pass",
  market: "US_STOCK",
  strategyFamily: "trend_pullback",
  evaluation: {
    startInclusive: new Date(EVAL_START).toISOString(),
    endExclusive: new Date(EVAL_END).toISOString(),
    warmupStart: new Date(WARMUP_START).toISOString(),
    fixedParameters: PARAMS,
    symbols: SYMBOLS,
    parameterRetuningPerformed: false,
    selectionPerformedOnEvaluationWindow: false,
    futureDataUsedForSignals: false,
  },
  normalCost: { costRatePerSide: NORMAL_COST, ...normalCost },
  stressedCost: { costRatePerSide: STRESS_COST, ...stressedCost },
  interpretation: {
    tradeChainNetReturnIsActualAccountReturn: false,
    equalWeightEightSymbolReturnDefinition:
      "one-eighth initial capital allocated independently to each symbol strategy; final subaccount equities averaged; no leverage",
  },
  researchOnly: true,
  liveExecutionAllowed: false,
  privateAccountRequestAllowed: false,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify(report, null, 2));
