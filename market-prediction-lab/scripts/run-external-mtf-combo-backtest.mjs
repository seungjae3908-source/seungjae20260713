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
  Object.freeze({ id: "H4_BREAKOUT_20", type: "breakout", window: 20, requireD1: false, requireH4Trend: true, volumeGate: false, exit: Object.freeze({ atrPeriod: 14, stopAtrMultiple: 8, targetRiskMultiple: 2 }) }),
  Object.freeze({ id: "D1_H4_BREAKOUT_20", type: "breakout", window: 20, requireD1: true, requireH4Trend: true, volumeGate: false, exit: Object.freeze({ atrPeriod: 14, stopAtrMultiple: 8, targetRiskMultiple: 2 }) }),
  Object.freeze({ id: "D1_H4_BREAKOUT_50", type: "breakout", window: 50, requireD1: true, requireH4Trend: true, volumeGate: false, exit: Object.freeze({ atrPeriod: 14, stopAtrMultiple: 10, targetRiskMultiple: 2 }) }),
  Object.freeze({ id: "D1_H4_BREAKOUT_100", type: "breakout", window: 100, requireD1: true, requireH4Trend: true, volumeGate: false, exit: Object.freeze({ atrPeriod: 14, stopAtrMultiple: 12, targetRiskMultiple: 2 }) }),
  Object.freeze({ id: "D1_H4_BREAKOUT_50_VOLUME", type: "breakout", window: 50, requireD1: true, requireH4Trend: true, volumeGate: true, exit: Object.freeze({ atrPeriod: 14, stopAtrMultiple: 10, targetRiskMultiple: 2 }) }),
  Object.freeze({ id: "D1_H4_EMA20_50_CROSS", type: "ema_cross", window: null, requireD1: true, requireH4Trend: false, volumeGate: false, exit: Object.freeze({ atrPeriod: 14, stopAtrMultiple: 10, targetRiskMultiple: 2 }) }),
]);
const LITERATURE_FULL = "D1_H4_BREAKOUT_50_VOLUME";

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

function mapClosedBarIndex(candles, bars) {
  const indexes = new Array(candles.length).fill(-1);
  const justClosed = new Array(candles.length).fill(false);
  let pointer = -1;
  for (let i = 0; i < candles.length; i += 1) {
    const decisionTime = candles[i].timestamp + FIFTEEN_MINUTES;
    while (pointer + 1 < bars.length && bars[pointer + 1].endTime <= decisionTime) pointer += 1;
    indexes[i] = pointer;
    justClosed[i] = pointer >= 0 && bars[pointer].endTime === decisionTime;
  }
  return Object.freeze({ indexes: Object.freeze(indexes), justClosed: Object.freeze(justClosed) });
}

function emaPairStates(bars) {
  const closes = bars.map((row) => row.close);
  const fast = ema(closes, 20);
  const slow = ema(closes, 50);
  return Object.freeze({ fast: Object.freeze(fast), slow: Object.freeze(slow) });
}

function buildFeatureSet(candles) {
  const h4Bars = aggregateClosedBars(candles, 4 * 60 * 60 * 1000);
  const d1Bars = aggregateClosedBars(candles, 24 * 60 * 60 * 1000);
  const h4Trend = trendStates(h4Bars);
  const d1Trend = trendStates(d1Bars);
  const h4Map = mapClosedBarIndex(candles, h4Bars);
  const h4Ema = emaPairStates(h4Bars);
  const h4Volumes = h4Bars.map((row) => row.volume);
  const h4VolumeMean20 = rollingMeanPrior(h4Volumes, 20);
  const extrema = {};
  for (const window of [20, 50, 100]) {
    extrema[window] = Object.freeze({
      high: Object.freeze(rollingPriorExtrema(h4Bars, window, "high", "max")),
      low: Object.freeze(rollingPriorExtrema(h4Bars, window, "low", "min")),
    });
  }
  return Object.freeze({
    h4Bars,
    h4Trend: Object.freeze(h4Trend.map((row) => row.direction)),
    h4Fast: h4Ema.fast,
    h4Slow: h4Ema.slow,
    h4Indexes: h4Map.indexes,
    h4JustClosed: h4Map.justClosed,
    h4VolumeMean20: Object.freeze(h4VolumeMean20),
    d1: mapLatestClosedState(candles, d1Trend),
    extrema: Object.freeze(extrema),
    aggregateCounts: Object.freeze({ h4: h4Bars.length, d1: d1Bars.length }),
  });
}

function signalEvaluatorFor({ candidate, side, features }) {
  const direction = side === "long" ? 1 : -1;
  return ({ index }) => {
    if (!features.h4JustClosed[index]) return null;
    const h4Index = features.h4Indexes[index];
    if (h4Index < 101) return null;
    if (candidate.requireD1 && features.d1[index] !== direction) return null;
    if (candidate.requireH4Trend && features.h4Trend[h4Index] !== direction) return null;
    const bar = features.h4Bars[h4Index];
    const priorBar = features.h4Bars[h4Index - 1];
    const meanVolume = features.h4VolumeMean20[h4Index];
    if (candidate.volumeGate && (!Number.isFinite(meanVolume) || bar.volume < meanVolume)) return null;

    let triggered = false;
    if (candidate.type === "breakout") {
      const ext = features.extrema[candidate.window];
      const currentBoundary = direction === 1 ? ext.high[h4Index] : ext.low[h4Index];
      const priorBoundary = direction === 1 ? ext.high[h4Index - 1] : ext.low[h4Index - 1];
      if (!Number.isFinite(currentBoundary) || !Number.isFinite(priorBoundary)) return null;
      triggered = direction === 1
        ? bar.close > currentBoundary && priorBar.close <= priorBoundary
        : bar.close < currentBoundary && priorBar.close >= priorBoundary;
    } else if (candidate.type === "ema_cross") {
      const fast = features.h4Fast[h4Index];
      const slow = features.h4Slow[h4Index];
      const prevFast = features.h4Fast[h4Index - 1];
      const prevSlow = features.h4Slow[h4Index - 1];
      if (![fast, slow, prevFast, prevSlow].every(Number.isFinite)) return null;
      triggered = direction === 1 ? fast > slow && prevFast <= prevSlow : fast < slow && prevFast >= prevSlow;
    }
    if (!triggered) return null;
    return Object.freeze({
      candidate: candidate.id,
      type: candidate.type,
      signalTimeframe: "4h",
      d1Direction: features.d1[index],
      h4Direction: features.h4Trend[h4Index],
      h4VolumeRatio: Number.isFinite(meanVolume) && meanVolume > 0 ? bar.volume / meanVolume : null,
      trigger: candidate.type === "breakout" ? `CLOSED_4H_DONCHIAN_${candidate.window}_BREAKOUT` : "CLOSED_4H_EMA20_50_CROSS",
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
    strategyVersion: `EXTERNAL_MTF_V3_${label}`,
    parameters: candidate.exit,
    signalEvaluator: signalEvaluatorFor({ candidate, side, features }),
    period,
  });
  return compact(result);
}

function rankDevelopment(rows) {
  return [...rows].sort((left, right) => {
    const gate = (row) => row.totalTrades >= 30 && Number.isFinite(row.profitFactor) && row.profitFactor > 1
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
    "# External Literature 4H/D1 Trend — BTCUSDT Futures V3",
    "",
    `- research SHA: \`${summary.researchCodeSha}\``,
    `- selection data: ${summary.dataset.selectionDataStatus}, candles=${summary.dataset.candleCount}`,
    `- Final Holdout read: **${summary.finalHoldoutRead}**`,
    `- cost: entry 0.06% + exit 0.06% + spread 0.02% + slippage 0.02%, funding included`,
    `- risk: 1% per trade, 1x leverage; predeclared ATR14(15m) stops 8x/10x/12x and target 2R`,
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
    developmentGatePassed: ranked[0].totalTrades >= 30 && ranked[0].profitFactor > 1 && ranked[0].expectancy > 0 && ranked[0].totalReturnPercent > 0,
    metrics: ranked[0],
  });
}

const oos = { long: [], short: [] };
for (const side of ["long", "short"]) {
  const roles = [
    Object.freeze({ role: "BASELINE", candidate: "H4_BREAKOUT_20" }),
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
  mode: "external-literature-h4-d1-trend-btcusdt-futures-v3",
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
    trigger: "closed 4h Donchian 20/50/100 breakout or 4h EMA20/50 cross; 15m only supplies next-open execution",
    higherTimeframeTrend: "closed 4h EMA20/50 alignment and optional closed daily EMA20/50 alignment",
    volumeGate: "where enabled, current closed 4h volume >= prior 20 closed 4h mean",
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
