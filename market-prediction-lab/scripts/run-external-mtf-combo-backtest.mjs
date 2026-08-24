import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectBinanceSelectionDataset } from "../src/binance-scalping-selection-provider.js";
import { runIndependentSignalBacktest } from "../src/independent-strategy-backtest.js";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const INITIAL_CAPITAL = 1_000_000;
const COST_MODEL = Object.freeze({
  entryFeeRate: 0.0006,
  exitFeeRate: 0.0006,
  taxRate: 0,
  slippageRate: 0.0002,
  spreadRate: 0.0002,
  latencyBars: 0,
  latencyDriftRate: 0,
});
const RISK_MODEL = Object.freeze({ riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 });
const DEVELOPMENT_PERIOD = Object.freeze({
  startTime: RESEARCH_BACKTEST_PERIOD.startTime,
  endTime: RESEARCH_BACKTEST_PERIOD.developmentEndTime,
});
const OOS_PERIOD = Object.freeze({
  startTime: RESEARCH_BACKTEST_PERIOD.validationStartTime,
  endTime: RESEARCH_BACKTEST_PERIOD.validationEndTime,
});
const CANDIDATES = Object.freeze([
  Object.freeze({ id: "BASE_BREAKOUT_96", type: "breakout", breakoutBars: 96, trends: Object.freeze([]), volumeGate: false, exit: Object.freeze({ atrPeriod: 14, stopAtrMultiple: 4, targetRiskMultiple: 2 }) }),
  Object.freeze({ id: "H4_BREAKOUT_96", type: "breakout", breakoutBars: 96, trends: Object.freeze(["h4"]), volumeGate: false, exit: Object.freeze({ atrPeriod: 14, stopAtrMultiple: 4, targetRiskMultiple: 2 }) }),
  Object.freeze({ id: "H4_H1_BREAKOUT_96", type: "breakout", breakoutBars: 96, trends: Object.freeze(["h4", "h1"]), volumeGate: false, exit: Object.freeze({ atrPeriod: 14, stopAtrMultiple: 4, targetRiskMultiple: 2 }) }),
  Object.freeze({ id: "D1_H4_H1_BREAKOUT_96", type: "breakout", breakoutBars: 96, trends: Object.freeze(["d1", "h4", "h1"]), volumeGate: false, exit: Object.freeze({ atrPeriod: 14, stopAtrMultiple: 4, targetRiskMultiple: 2 }) }),
  Object.freeze({ id: "D1_H4_H1_BREAKOUT_96_VOLUME", type: "breakout", breakoutBars: 96, trends: Object.freeze(["d1", "h4", "h1"]), volumeGate: true, exit: Object.freeze({ atrPeriod: 14, stopAtrMultiple: 4, targetRiskMultiple: 2 }) }),
  Object.freeze({ id: "D1_H4_H1_PULLBACK_RECLAIM_VOLUME", type: "pullback", breakoutBars: null, trends: Object.freeze(["d1", "h4", "h1"]), volumeGate: true, exit: Object.freeze({ atrPeriod: 14, stopAtrMultiple: 3, targetRiskMultiple: 2 }) }),
]);
const LITERATURE_FULL = "D1_H4_H1_BREAKOUT_96_VOLUME";

function assertResearchSha(value) {
  if (!/^[0-9a-f]{40}$/u.test(value ?? "")) throw new Error("RESEARCH_CODE_SHA must be an exact 40-character SHA");
  return value;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  out[period - 1] = seed / period;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) out[i] = alpha * values[i] + (1 - alpha) * out[i - 1];
  return out;
}

function rollingMeanPrior(values, window) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (i >= window) out[i] = sum / window;
    sum += values[i];
    if (i >= window) sum -= values[i - window];
  }
  return out;
}

function rollingPriorExtrema(candles, window, field, mode) {
  const out = new Array(candles.length).fill(null);
  for (let i = window; i < candles.length; i += 1) {
    let value = mode === "max" ? -Infinity : Infinity;
    for (let j = i - window; j < i; j += 1) {
      value = mode === "max" ? Math.max(value, candles[j][field]) : Math.min(value, candles[j][field]);
    }
    out[i] = value;
  }
  return out;
}

function aggregateClosedBars(candles, intervalMs) {
  const expected = intervalMs / FIFTEEN_MINUTES;
  if (!Number.isInteger(expected) || expected < 1) throw new Error(`invalid aggregate interval ${intervalMs}`);
  const bars = [];
  let bucket = null;
  let rows = [];
  const flush = () => {
    if (bucket == null || rows.length !== expected) return;
    for (let i = 1; i < rows.length; i += 1) {
      if (rows[i].timestamp - rows[i - 1].timestamp !== FIFTEEN_MINUTES) return;
    }
    bars.push(Object.freeze({
      timestamp: bucket,
      endTime: bucket + intervalMs,
      open: rows[0].open,
      high: Math.max(...rows.map((row) => row.high)),
      low: Math.min(...rows.map((row) => row.low)),
      close: rows.at(-1).close,
      volume: rows.reduce((sum, row) => sum + row.volume, 0),
    }));
  };
  for (const candle of candles) {
    const current = Math.floor(candle.timestamp / intervalMs) * intervalMs;
    if (bucket !== current) {
      flush();
      bucket = current;
      rows = [];
    }
    rows.push(candle);
  }
  flush();
  return Object.freeze(bars);
}

function trendStates(bars) {
  const closes = bars.map((row) => row.close);
  const fast = ema(closes, 20);
  const slow = ema(closes, 50);
  return Object.freeze(bars.map((bar, index) => {
    const f = fast[index];
    const s = slow[index];
    let direction = 0;
    if (Number.isFinite(f) && Number.isFinite(s)) {
      if (bar.close > f && f > s) direction = 1;
      else if (bar.close < f && f < s) direction = -1;
    }
    return Object.freeze({ endTime: bar.endTime, direction, close: bar.close, fast: f, slow: s });
  }));
}

function mapLatestClosedState(candles, states) {
  const mapped = new Array(candles.length).fill(0);
  let pointer = -1;
  for (let i = 0; i < candles.length; i += 1) {
    const decisionTime = candles[i].timestamp + FIFTEEN_MINUTES;
    while (pointer + 1 < states.length && states[pointer + 1].endTime <= decisionTime) pointer += 1;
    mapped[i] = pointer >= 0 ? states[pointer].direction : 0;
  }
  return Object.freeze(mapped);
}

function buildFeatureSet(candles) {
  const closes = candles.map((row) => row.close);
  const volumes = candles.map((row) => row.volume);
  const ema20 = ema(closes, 20);
  const volumeMean20 = rollingMeanPrior(volumes, 20);
  const priorHigh96 = rollingPriorExtrema(candles, 96, "high", "max");
  const priorLow96 = rollingPriorExtrema(candles, 96, "low", "min");
  const h1 = trendStates(aggregateClosedBars(candles, 60 * 60 * 1000));
  const h4 = trendStates(aggregateClosedBars(candles, 4 * 60 * 60 * 1000));
  const d1 = trendStates(aggregateClosedBars(candles, 24 * 60 * 60 * 1000));
  return Object.freeze({
    ema20: Object.freeze(ema20),
    volumeMean20: Object.freeze(volumeMean20),
    priorHigh96: Object.freeze(priorHigh96),
    priorLow96: Object.freeze(priorLow96),
    h1: mapLatestClosedState(candles, h1),
    h4: mapLatestClosedState(candles, h4),
    d1: mapLatestClosedState(candles, d1),
    aggregateCounts: Object.freeze({ h1: h1.length, h4: h4.length, d1: d1.length }),
  });
}

function signalEvaluatorFor({ candidate, side, features, candles }) {
  const direction = side === "long" ? 1 : -1;
  return ({ index }) => {
    if (index < 100) return null;
    for (const trend of candidate.trends) if (features[trend][index] !== direction) return null;
    const meanVolume = features.volumeMean20[index];
    if (candidate.volumeGate && (!Number.isFinite(meanVolume) || candles[index].volume < meanVolume)) return null;

    let triggered = false;
    if (candidate.type === "breakout") {
      const currentBoundary = direction === 1 ? features.priorHigh96[index] : features.priorLow96[index];
      const priorBoundary = direction === 1 ? features.priorHigh96[index - 1] : features.priorLow96[index - 1];
      if (!Number.isFinite(currentBoundary) || !Number.isFinite(priorBoundary)) return null;
      triggered = direction === 1
        ? candles[index].close > currentBoundary && candles[index - 1].close <= priorBoundary
        : candles[index].close < currentBoundary && candles[index - 1].close >= priorBoundary;
    } else if (candidate.type === "pullback") {
      const currentEma = features.ema20[index];
      const priorEma = features.ema20[index - 1];
      if (!Number.isFinite(currentEma) || !Number.isFinite(priorEma)) return null;
      triggered = direction === 1
        ? candles[index].close > currentEma && candles[index - 1].close <= priorEma
        : candles[index].close < currentEma && candles[index - 1].close >= priorEma;
    }
    if (!triggered) return null;
    return Object.freeze({
      candidate: candidate.id,
      type: candidate.type,
      h1Direction: features.h1[index],
      h4Direction: features.h4[index],
      d1Direction: features.d1[index],
      volumeRatio: Number.isFinite(meanVolume) && meanVolume > 0 ? candles[index].volume / meanVolume : null,
      trigger: candidate.type === "breakout" ? "CLOSED_15M_24H_DONCHIAN_BREAKOUT" : "CLOSED_15M_EMA20_PULLBACK_RECLAIM",
    });
  };
}

function compact(result) {
  return Object.freeze({
    strategy: result.strategy,
    side: result.side,
    period: result.period,
    totalTrades: result.totalTrades,
    totalReturnPercent: result.totalReturnPercent,
    winRatePercent: result.successRatePercent,
    profitFactor: result.profitFactor,
    maximumDrawdownPercent: result.maximumDrawdownPercent,
    expectancy: result.expectancy,
    finalCapital: result.finalCapital,
    totalNetPnl: result.performance?.overall?.netPnl ?? null,
    safeguards: result.safeguards,
  });
}

function runOne({ candidate, side, period, dataset, features, label }) {
  const result = runIndependentSignalBacktest({
    backtestInput: Object.freeze({
      market: "CRYPTO_FUTURES",
      symbol: "BTCUSDT",
      side,
      timeframe: "15m",
      initialCapital: INITIAL_CAPITAL,
      candles: dataset.candles,
      fundingRates: dataset.fundingRates,
      costModel: COST_MODEL,
      riskModel: RISK_MODEL,
    }),
    strategy: `external_mtf_${candidate.id.toLowerCase()}`,
    strategyVersion: `EXTERNAL_MTF_V2_${label}`,
    parameters: candidate.exit,
    signalEvaluator: signalEvaluatorFor({ candidate, side, features, candles: dataset.candles }),
    period,
  });
  return compact(result);
}

function rankDevelopment(rows) {
  return [...rows].sort((left, right) => {
    const gate = (row) => row.totalTrades >= 50 && Number.isFinite(row.profitFactor) && row.profitFactor > 1
      && Number.isFinite(row.expectancy) && row.expectancy > 0 && row.totalReturnPercent > 0 ? 1 : 0;
    return gate(right) - gate(left)
      || (Number.isFinite(right.profitFactor) ? right.profitFactor : -Infinity) - (Number.isFinite(left.profitFactor) ? left.profitFactor : -Infinity)
      || right.totalReturnPercent - left.totalReturnPercent
      || left.maximumDrawdownPercent - right.maximumDrawdownPercent
      || right.totalTrades - left.totalTrades;
  });
}

function markdown(summary) {
  const f = (value, digits = 3) => Number.isFinite(value) ? value.toFixed(digits) : "N/A";
  const lines = [
    "# External Literature MTF Trend/Breakout — BTCUSDT Futures V2",
    "",
    `- research SHA: \`${summary.researchCodeSha}\``,
    `- selection data: ${summary.dataset.selectionDataStatus}, candles=${summary.dataset.candleCount}`,
    `- Final Holdout read: **${summary.finalHoldoutRead}**`,
    `- cost: entry 0.06% + exit 0.06% + spread 0.02% + slippage 0.02%, funding included`,
    `- risk: 1% per trade, 1x leverage; predeclared ATR14 stops 3x/4x and target 2R`,
    "",
    "## Development 2020-2024",
    "",
    "| Side | Candidate | N | Return % | Win % | PF | MDD % | Expectancy |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const side of ["long", "short"]) {
    for (const row of summary.development[side]) {
      lines.push(`| ${side} | ${row.candidate} | ${row.totalTrades} | ${f(row.totalReturnPercent)} | ${f(row.winRatePercent)} | ${f(row.profitFactor)} | ${f(row.maximumDrawdownPercent)} | ${f(row.expectancy)} |`);
    }
  }
  lines.push("", "## Frozen 2025 OOS", "", "| Side | Role | Candidate | N | Return % | Win % | PF | MDD % | Expectancy |", "|---|---|---|---:|---:|---:|---:|---:|---:|");
  for (const side of ["long", "short"]) {
    for (const row of summary.oos[side]) {
      lines.push(`| ${side} | ${row.role} | ${row.candidate} | ${row.metrics.totalTrades} | ${f(row.metrics.totalReturnPercent)} | ${f(row.metrics.winRatePercent)} | ${f(row.metrics.profitFactor)} | ${f(row.metrics.maximumDrawdownPercent)} | ${f(row.metrics.expectancy)} |`);
    }
  }
  lines.push("", "Selection is based only on 2020-2024 Development. 2025 OOS is not used to tune parameters or select a replacement candidate. 2026 Final Holdout is not read.", "");
  return `${lines.join("\n")}\n`;
}

const researchCodeSha = assertResearchSha(process.env.RESEARCH_CODE_SHA);
const outputJson = resolve(process.argv[2] ?? "artifacts/external-mtf-combo/summary.json");
const outputMd = resolve(process.argv[3] ?? "artifacts/external-mtf-combo/summary.md");

const collected = await collectBinanceSelectionDataset({
  symbol: "BTCUSDT",
  requestedSelectionStart: RESEARCH_BACKTEST_PERIOD.startTime,
  requestedSelectionEnd: RESEARCH_BACKTEST_PERIOD.validationEndTime,
  collectionCodeSHA: researchCodeSha,
});
if (collected.audit.selectionDataStatus !== "DATA_READY") throw new Error(`selection data not ready: ${collected.audit.selectionDataStatus}`);
if (collected.audit.finalHoldoutRead !== false || collected.audit.crossVenueMix !== false) throw new Error("dataset safety boundary failed");
const dataset = Object.freeze({ candles: collected.candles, fundingRates: collected.fundingRates });
const features = buildFeatureSet(dataset.candles);

const development = { long: [], short: [] };
const selected = {};
for (const side of ["long", "short"]) {
  const rows = CANDIDATES.map((candidate) => Object.freeze({
    candidate: candidate.id,
    ...runOne({ candidate, side, period: DEVELOPMENT_PERIOD, dataset, features, label: "DEVELOPMENT" }),
  }));
  development[side] = Object.freeze(rows);
  const ranked = rankDevelopment(rows);
  selected[side] = Object.freeze({
    candidate: ranked[0].candidate,
    developmentGatePassed: ranked[0].totalTrades >= 50 && ranked[0].profitFactor > 1 && ranked[0].expectancy > 0 && ranked[0].totalReturnPercent > 0,
    metrics: ranked[0],
  });
}

const oos = { long: [], short: [] };
for (const side of ["long", "short"]) {
  const roles = [
    Object.freeze({ role: "BASELINE", candidate: "BASE_BREAKOUT_96" }),
    Object.freeze({ role: "LITERATURE_FULL_PREDECLARED", candidate: LITERATURE_FULL }),
    Object.freeze({ role: "DEVELOPMENT_SELECTED", candidate: selected[side].candidate }),
  ];
  const seen = new Set();
  for (const row of roles) {
    const key = `${row.role}:${row.candidate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    oos[side].push(Object.freeze({
      ...row,
      metrics: runOne({ candidate: CANDIDATES.find((candidate) => candidate.id === row.candidate), side, period: OOS_PERIOD, dataset, features, label: "OOS_2025" }),
    }));
  }
  oos[side] = Object.freeze(oos[side]);
}

const summary = Object.freeze({
  schemaVersion: 1,
  mode: "external-literature-mtf-trend-breakout-btcusdt-futures-v2",
  researchCodeSha,
  dataset: Object.freeze({
    venue: "BINANCE_USDM",
    provider: collected.audit.provider,
    providerVersion: collected.audit.providerVersion,
    selectionDataStatus: collected.audit.selectionDataStatus,
    candleCount: collected.candles.length,
    fundingRecordCount: collected.fundingRates.length,
    candleDigest: collected.audit.normalizedCandleDigest,
    fundingDigest: collected.audit.normalizedFundingDigest,
    crossVenueMix: collected.audit.crossVenueMix,
    aggregateCounts: features.aggregateCounts,
  }),
  researchDesign: Object.freeze({
    candidates: CANDIDATES,
    trigger: "closed 15m 24h Donchian breakout or EMA20 pullback reclaim",
    higherTimeframeTrend: "closed-bar EMA20/50 alignment plus close vs EMA20",
    volumeGate: "where enabled, current closed 15m volume >= prior 20-bar mean",
    costModel: COST_MODEL,
    riskModel: RISK_MODEL,
    developmentPeriod: DEVELOPMENT_PERIOD,
    oosPeriod: OOS_PERIOD,
    oosSelectionAllowed: false,
  }),
  development: Object.freeze({ long: development.long, short: development.short }),
  selected: Object.freeze(selected),
  oos: Object.freeze({ long: oos.long, short: oos.short }),
  finalHoldoutRead: false,
  finalHoldoutUsedForSelection: false,
  privateApiUsed: false,
  orderSubmitted: false,
  productionMutation: false,
});

await mkdir(dirname(outputJson), { recursive: true });
await mkdir(dirname(outputMd), { recursive: true });
await writeFile(outputJson, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
await writeFile(outputMd, markdown(summary), "utf8");
console.log(JSON.stringify(summary, null, 2));
