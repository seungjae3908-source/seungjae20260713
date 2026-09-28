import {
  ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
} from '../../../market-prediction-lab/src/adaptive-multi-evidence-point-in-time-v2.js';
import {
  buildAdaptiveMultiEvidenceMarketFeaturesV2,
} from '../../../market-prediction-lab/src/adaptive-multi-evidence-market-features-v2.js';
import { RUNNER_RESEARCH_PRESETS, simulateRunner } from './engine.mjs';

export const ONE_YEAR_BENCHMARK_START_MS = Date.parse('2025-09-28T00:00:00.000Z');
export const ONE_YEAR_BENCHMARK_END_MS = Date.parse('2026-09-27T23:59:59.999Z');

const CASH_MARKETS = new Set(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT']);
const SUPPORTED_MARKETS = new Set(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']);
const DEFAULT_COSTS = Object.freeze({
  KR_STOCK: Object.freeze({ feeBps: 3, slippageBps: 5, spreadBps: 8 }),
  US_STOCK: Object.freeze({ feeBps: 2, slippageBps: 5, spreadBps: 6 }),
  CRYPTO_SPOT: Object.freeze({ feeBps: 5, slippageBps: 5, spreadBps: 10 }),
  CRYPTO_FUTURES: Object.freeze({ feeBps: 5, slippageBps: 5, spreadBps: 6 }),
});

export const ABLATION_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'FULL', disabledFamilies: Object.freeze([]) }),
  Object.freeze({ id: 'NO_TREND', disabledFamilies: Object.freeze(['TREND']) }),
  Object.freeze({ id: 'NO_MOMENTUM', disabledFamilies: Object.freeze(['MOMENTUM']) }),
  Object.freeze({ id: 'NO_STRUCTURE', disabledFamilies: Object.freeze(['STRUCTURE']) }),
  Object.freeze({ id: 'NO_VOLUME', disabledFamilies: Object.freeze(['VOLUME']) }),
  Object.freeze({ id: 'NO_VOLATILITY', disabledFamilies: Object.freeze(['VOLATILITY']) }),
]);

const FACTOR_FAMILIES = Object.freeze({
  TREND: Object.freeze(['ema', 'adx']),
  MOMENTUM: Object.freeze(['roc', 'macd', 'rsi']),
  STRUCTURE: Object.freeze(['structure']),
  VOLUME: Object.freeze(['volume']),
  VOLATILITY: Object.freeze(['volatility']),
});
const COMPONENT_TO_FAMILY = Object.freeze(Object.fromEntries(
  Object.entries(FACTOR_FAMILIES).flatMap(([family, components]) =>
    components.map((component) => [component, family])),
));

function normalizeDisabledFamilies(values = []) {
  if (!Array.isArray(values)) throw new TypeError('disabledFamilies must be an array');
  const normalized = [...new Set(values.map((value) => String(value).trim().toUpperCase()))];
  for (const family of normalized) {
    if (!Object.hasOwn(FACTOR_FAMILIES, family)) throw new RangeError('unknown factor family: ' + family);
  }
  return normalized;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(label + ' must be finite');
  return number;
}
function direction(value) {
  const normalized = String(value ?? 'LONG').trim().toUpperCase();
  if (normalized === 'LONG' || normalized === 'BUY') return 'LONG';
  if (normalized === 'SHORT' || normalized === 'SELL') return 'SHORT';
  throw new TypeError('direction must be LONG/BUY or SHORT/SELL');
}
function normalizeRows(rawRows) {
  if (!Array.isArray(rawRows)) throw new TypeError('candles must be an array');
  const rows = rawRows.map((row, index) => {
    const ts = finite(row.ts ?? row.timestamp, 'candles[' + index + '].timestamp');
    const open = finite(row.open, 'candles[' + index + '].open');
    const high = finite(row.high, 'candles[' + index + '].high');
    const low = finite(row.low, 'candles[' + index + '].low');
    const close = finite(row.close, 'candles[' + index + '].close');
    const volume = finite(row.volume ?? 0, 'candles[' + index + '].volume');
    if (!(ts > 0 && open > 0 && high > 0 && low > 0 && close > 0 && volume >= 0)) {
      throw new RangeError('invalid candle at index ' + index);
    }
    if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
      throw new RangeError('inconsistent OHLC at index ' + index);
    }
    return { ts, open, high, low, close, volume };
  }).sort((left, right) => left.ts - right.ts);
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].ts <= rows[index - 1].ts) throw new RangeError('candles must be strictly ordered');
  }
  return rows;
}
function sourceDocumentId(dataset) {
  return [
    'one-year-public-benchmark',
    dataset.market,
    dataset.symbol,
    dataset.timeframe,
    dataset.source ?? 'public',
  ].join(':');
}
function canonicalCandlesThrough(rows, index) {
  const decisionTime = rows[index + 1].ts;
  return rows.slice(0, index + 1).map((row, rowIndex) => {
    const availableAt = rows[rowIndex + 1]?.ts ?? decisionTime;
    const observedAt = Math.min(availableAt, decisionTime);
    return {
      eventTime: new Date(row.ts).toISOString(),
      publishedAt: new Date(observedAt).toISOString(),
      availableAt: new Date(observedAt).toISOString(),
      observedAt: new Date(observedAt).toISOString(),
      isClosed: true,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    };
  });
}

function buildFeatureSnapshotFromRows(dataset, rows, index, side = 'LONG') {
  if (!dataset || typeof dataset !== 'object') throw new TypeError('dataset is required');
  if (!SUPPORTED_MARKETS.has(dataset.market)) throw new RangeError('unsupported market');
  if (!Number.isInteger(index) || index < 80 || index + 1 >= rows.length) {
    throw new RangeError('feature index requires >=80 history bars and one next bar');
  }
  const tradeSide = direction(side);
  const decisionTime = rows[index + 1].ts;
  return buildAdaptiveMultiEvidenceMarketFeaturesV2({
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    market: dataset.market,
    symbol: String(dataset.symbol).toUpperCase(),
    timeframe: dataset.timeframe,
    side: tradeSide,
    decisionTime: new Date(decisionTime).toISOString(),
    candles: canonicalCandlesThrough(rows, index),
    higherTimeframeEvidence: [],
    benchmark: null,
    source: {
      sourceId: dataset.source ?? 'public-market-data',
      originalSourceId: dataset.source ?? 'public-market-data',
      sourceType: 'PUBLIC_MARKET_DATA',
      documentId: sourceDocumentId(dataset),
    },
  });
}

export function buildFeatureSnapshotAt(dataset, index, side = 'LONG') {
  return buildFeatureSnapshotFromRows(dataset, normalizeRows(dataset?.candles), index, side);
}

function emaSeries(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;
  const multiplier = 2 / (period + 1);
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = current;
  for (let index = period; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
    result[index] = current;
  }
  return result;
}
function buildCheapSignalSeries(rows) {
  const closes = rows.map((row) => row.close);
  const fast = emaSeries(closes, 20);
  const slow = emaSeries(closes, 50);
  const roc12 = closes.map((close, index) => index >= 12 && closes[index - 12] > 0
    ? close / closes[index - 12] - 1
    : null);
  return { fast, slow, roc12 };
}
function baselineSignal(rows, index, side, cheap) {
  const fast = cheap.fast[index];
  const slow = cheap.slow[index];
  const previousFast = cheap.fast[index - 1];
  if (![fast, slow, previousFast].every(Number.isFinite)) return false;
  const previousClose = rows[index - 1].close;
  const latestClose = rows[index].close;
  if (side === 'LONG') {
    return fast > slow && previousClose <= previousFast * 1.005 && latestClose > fast;
  }
  return fast < slow && previousClose >= previousFast * 0.995 && latestClose < fast;
}
function improvedRequiredPrefilter(index, side, cheap, disabledFamilies = []) {
  const disabled = new Set(normalizeDisabledFamilies(disabledFamilies));
  const fast = cheap.fast[index];
  const slow = cheap.slow[index];
  const roc = cheap.roc12[index];
  if (!disabled.has('TREND') && ![fast, slow].every(Number.isFinite)) return false;
  if (!disabled.has('MOMENTUM') && !Number.isFinite(roc)) return false;
  const trendPass = disabled.has('TREND') || (side === 'LONG' ? fast > slow : fast < slow);
  const momentumPass = disabled.has('MOMENTUM') || (side === 'LONG' ? roc > 0 : roc < 0);
  return trendPass && momentumPass;
}

export function improvedSignalDecision(snapshot, side = 'LONG', { disabledFamilies = [] } = {}) {
  const tradeSide = direction(side);
  if (!snapshot || !['READY_FOR_SPECIALIST_RESEARCH_ONLY', 'PARTIAL_FOR_SPECIALIST_RESEARCH_ONLY'].includes(snapshot.status)) {
    return freeze({ matched: false, score: 0, reason: 'FEATURE_SNAPSHOT_NOT_READY' });
  }
  const { trend, momentum, volume, volatility, priceAction } = snapshot.features;
  const expected = tradeSide === 'LONG' ? 'UP' : 'DOWN';
  const oppositeStructure = tradeSide === 'LONG' ? 'BEARISH' : 'BULLISH';
  const directionalRoc = tradeSide === 'LONG' ? momentum.roc : -momentum.roc;
  const directionalMacd = tradeSide === 'LONG' ? momentum.macdHistogramPct : -momentum.macdHistogramPct;
  const rsiPass = tradeSide === 'LONG'
    ? momentum.rsi >= 45 && momentum.rsi < 78
    : momentum.rsi > 22 && momentum.rsi <= 55;
  const transition = String(priceAction.structureTransition ?? '');
  const transitionPass = tradeSide === 'LONG'
    ? /(?:BOS|CHOCH|BREAK)_UP/.test(transition)
    : /(?:BOS|CHOCH|BREAK)_DOWN/.test(transition);
  const swingPass = priceAction.latestSwingLegDirection === expected;
  const structurePass = priceAction.structureTrend === (tradeSide === 'LONG' ? 'BULLISH' : 'BEARISH')
    || transitionPass || swingPass;
  const volumePass = (volume.relativeVolume ?? 0) >= 0.8 && volume.priceVolumeDisagreement !== true;
  const volatilityPass = volatility.abnormalVolatility !== true;
  const components = {
    ema: trend.emaDirection === expected,
    adx: (trend.adx ?? 0) >= 18 && trend.adxDirection === expected,
    roc: (directionalRoc ?? -Infinity) > 0,
    macd: (directionalMacd ?? -Infinity) > 0,
    rsi: rsiPass,
    structure: structurePass,
    volume: volumePass,
    volatility: volatilityPass,
  };
  const disabled = new Set(normalizeDisabledFamilies(disabledFamilies));
  const enabledComponents = Object.entries(components)
    .filter(([component]) => !disabled.has(COMPONENT_TO_FAMILY[component]));
  const score = enabledComponents.filter(([, passed]) => passed).length;
  const maximumScore = enabledComponents.length;
  const threshold = Math.max(1, Math.ceil(maximumScore * 0.75));
  const hardDirection =
    (disabled.has('TREND') || components.ema)
    && (disabled.has('MOMENTUM') || components.roc)
    && (disabled.has('STRUCTURE') || priceAction.structureTrend !== oppositeStructure);
  return freeze({
    matched: hardDirection && score >= threshold,
    score,
    maximumScore,
    threshold,
    disabledFamilies: freeze([...disabled].sort()),
    components: freeze(components),
    structureTransition: priceAction.structureTransition ?? 'NONE',
    wave: freeze({
      latestSwingLegDirection: priceAction.latestSwingLegDirection ?? null,
      latestSwingLegAtr: priceAction.latestSwingLegAtr ?? null,
      swingRetracementRatio: priceAction.swingRetracementRatio ?? null,
      swingSequence: freeze([...(priceAction.swingSequence ?? [])]),
    }),
  });
}

function fundingImpact(dataset, trial, side) {
  if (dataset.market !== 'CRYPTO_FUTURES' || !Array.isArray(dataset.fundingRates)) return 0;
  const total = dataset.fundingRates
    .filter((row) => Number(row.timestamp) > trial.entryTs && Number(row.timestamp) <= trial.exitTs)
    .reduce((sum, row) => sum + Number(row.rate ?? 0), 0);
  return side === 'LONG' ? -total : total;
}
function summarizeTrades(trades, initialCapital) {
  let equity = initialCapital;
  let peak = equity;
  let maximumDrawdown = 0;
  let grossGain = 0;
  let grossLoss = 0;
  for (const trade of trades) {
    const before = equity;
    equity = Math.max(0, equity * (1 + trade.accountReturn));
    const pnl = equity - before;
    if (pnl > 0) grossGain += pnl;
    if (pnl < 0) grossLoss += -pnl;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak > 0 ? 1 - equity / peak : 0);
  }
  const wins = trades.filter((trade) => trade.accountReturn > 0).length;
  return freeze({
    initialCapital,
    finalCapital: equity,
    totalReturn: initialCapital > 0 ? equity / initialCapital - 1 : 0,
    tradeCount: trades.length,
    winRate: trades.length ? wins / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossGain / grossLoss : grossGain > 0 ? null : 0,
    maximumDrawdown,
    averageAccountReturn: trades.length ? trades.reduce((sum, row) => sum + row.accountReturn, 0) / trades.length : 0,
  });
}

export function runOneYearDatasetBenchmark(dataset, {
  variant = 'IMPROVED_TECH_STRUCTURE_V2',
  side = 'LONG',
  startTime = ONE_YEAR_BENCHMARK_START_MS,
  endTime = ONE_YEAR_BENCHMARK_END_MS,
  initialCapital = 1_000_000,
  riskFraction = 0.005,
  futuresMaximumExposure = 3,
  costs = null,
  disabledFamilies = [],
} = {}) {
  if (!SUPPORTED_MARKETS.has(dataset?.market)) throw new RangeError('unsupported market');
  const tradeSide = direction(side);
  const normalizedDisabledFamilies = normalizeDisabledFamilies(disabledFamilies);
  if (CASH_MARKETS.has(dataset.market) && tradeSide === 'SHORT') throw new RangeError('cash markets are long-only');
  const rows = normalizeRows(dataset.candles).filter((row) => row.ts <= endTime);
  if (rows.length < 90) throw new RangeError('at least 90 candles are required');
  const runnerCandles = rows.map((row) => ({ ...row }));
  const cheap = buildCheapSignalSeries(rows);
  const preset = RUNNER_RESEARCH_PRESETS.LONG_RUNNER_3ATR;
  const laneCosts = costs ?? DEFAULT_COSTS[dataset.market];
  const trades = [];
  let lastExit = -Infinity;

  for (let index = 80; index + 1 < rows.length; index += 1) {
    const signalTime = rows[index].ts;
    const entryTime = rows[index + 1].ts;
    if (signalTime < startTime || entryTime > endTime || signalTime <= lastExit) continue;
    let matched = false;
    let decision = null;
    if (variant === 'BASELINE_EMA_PULLBACK_V1') {
      matched = baselineSignal(rows, index, tradeSide, cheap);
    } else if (variant === 'IMPROVED_TECH_STRUCTURE_V2' || variant.startsWith('ABLATION_')) {
      // Keep the candidate universe fixed across decision-layer ablations.
      if (!improvedRequiredPrefilter(index, tradeSide, cheap, [])) continue;
      const snapshot = buildFeatureSnapshotFromRows(dataset, rows, index, tradeSide);
      decision = improvedSignalDecision(snapshot, tradeSide, { disabledFamilies: normalizedDisabledFamilies });
      matched = decision.matched;
    } else {
      throw new RangeError('unknown benchmark variant');
    }
    if (!matched) continue;

    const trial = simulateRunner({
      candles: runnerCandles,
      signalAtMs: signalTime,
      direction: tradeSide,
      ...preset,
      costs: laneCosts,
    });
    if (trial.entryTs > endTime) continue;
    const funding = fundingImpact(dataset, trial, tradeSide);
    const netReturn = trial.netReturn + funding;
    const maximumExposure = dataset.market === 'CRYPTO_FUTURES' ? futuresMaximumExposure : 1;
    const positionFraction = Math.min(maximumExposure, riskFraction / Math.max(trial.initialRiskPct, 1e-9));
    const accountReturn = netReturn * positionFraction;
    trades.push(freeze({
      market: dataset.market,
      symbol: dataset.symbol,
      timeframe: dataset.timeframe,
      variant,
      side: tradeSide,
      signalTime,
      entryTs: trial.entryTs,
      exitTs: trial.exitTs,
      initialRiskPct: trial.initialRiskPct,
      positionFraction,
      rawNetReturn: trial.netReturn,
      fundingImpact: funding,
      accountReturn,
      exitReason: trial.exitReason,
      decisionScore: decision?.score ?? null,
      decisionMaximumScore: decision?.maximumScore ?? null,
      decisionThreshold: decision?.threshold ?? null,
      disabledFamilies: freeze([...normalizedDisabledFamilies]),
      structureTransition: decision?.structureTransition ?? null,
    }));
    lastExit = trial.exitTs;
  }

  return freeze({
    market: dataset.market,
    symbol: dataset.symbol,
    timeframe: dataset.timeframe,
    side: tradeSide,
    variant,
    source: dataset.source ?? null,
    costs: freeze({ ...laneCosts }),
    disabledFamilies: freeze([...normalizedDisabledFamilies]),
    performance: summarizeTrades(trades, initialCapital),
    trades: freeze(trades),
  });
}

function aggregateResults(rows, initialCapital = 1_000_000) {
  if (!rows.length) return freeze({ sampleCount: 0, totalReturn: null, tradeCount: 0, winRate: null, profitFactor: null, maximumDrawdown: null });
  const sleeveCapital = initialCapital / rows.length;
  const scaled = rows.map((row) => {
    const multiple = row.performance.finalCapital / row.performance.initialCapital;
    return { ...row, sleeveFinal: sleeveCapital * multiple };
  });
  const finalCapital = scaled.reduce((sum, row) => sum + row.sleeveFinal, 0);
  const trades = scaled.flatMap((row) => row.trades);
  const wins = trades.filter((row) => row.accountReturn > 0).length;
  const gains = trades.filter((row) => row.accountReturn > 0).reduce((sum, row) => sum + row.accountReturn, 0);
  const losses = -trades.filter((row) => row.accountReturn < 0).reduce((sum, row) => sum + row.accountReturn, 0);
  return freeze({
    sampleCount: rows.length,
    initialCapital,
    finalCapital,
    totalReturn: finalCapital / initialCapital - 1,
    tradeCount: trades.length,
    winRate: trades.length ? wins / trades.length : 0,
    profitFactor: losses > 0 ? gains / losses : gains > 0 ? null : 0,
    maximumDrawdown: Math.max(...rows.map((row) => row.performance.maximumDrawdown)),
  });
}

export function runFourMarketOneYearBenchmark({
  datasets = [],
  startTime = ONE_YEAR_BENCHMARK_START_MS,
  endTime = ONE_YEAR_BENCHMARK_END_MS,
} = {}) {
  if (!Array.isArray(datasets)) throw new TypeError('datasets must be an array');
  const rows = [];
  for (const dataset of datasets) {
    const sides = dataset.market === 'CRYPTO_FUTURES' ? ['LONG', 'SHORT'] : ['LONG'];
    for (const side of sides) {
      for (const variant of ['BASELINE_EMA_PULLBACK_V1', 'IMPROVED_TECH_STRUCTURE_V2']) {
        rows.push(runOneYearDatasetBenchmark(dataset, { variant, side, startTime, endTime }));
      }
    }
  }
  const markets = {};
  for (const market of SUPPORTED_MARKETS) {
    const marketRows = rows.filter((row) => row.market === market);
    markets[market] = freeze({
      market,
      baseline: aggregateResults(marketRows.filter((row) => row.variant === 'BASELINE_EMA_PULLBACK_V1')),
      improved: aggregateResults(marketRows.filter((row) => row.variant === 'IMPROVED_TECH_STRUCTURE_V2')),
      datasets: freeze(marketRows),
    });
  }
  return freeze({
    schemaVersion: 'move-hunter-one-year-public-benchmark/v1',
    startTime,
    endTime,
    status: Object.values(markets).every((market) => market.improved.sampleCount > 0)
      ? 'BOUNDED_FOUR_MARKET_RESULT'
      : 'PARTIAL_MARKET_RESULT',
    markets: freeze(markets),
    evidenceBoundary: freeze({
      historicalReplayOnly: true,
      pointInTimeFullUniverseProven: false,
      canonicalFullCostProven: false,
      newsDisclosurePIT: 'NOT_AVAILABLE_NO_CANONICAL_ONE_YEAR_EVENT_ARCHIVE',
      aiHistoricalDecisionPIT: 'NOT_RUN_NO_CANONICAL_EVENT_PACKET',
      oosCredit: 0,
      economicSampleCredit: 0,
      profitabilityClaimAllowed: false,
      executionAuthority: 'NONE',
      liveTrading: false,
      realOrder: false,
      privateApi: false,
    }),
  });
}


function runOneYearDatasetAblationRows(dataset, {
  side = 'LONG',
  startTime = ONE_YEAR_BENCHMARK_START_MS,
  endTime = ONE_YEAR_BENCHMARK_END_MS,
  initialCapital = 1_000_000,
  riskFraction = 0.005,
  futuresMaximumExposure = 3,
  costs = null,
} = {}) {
  if (!SUPPORTED_MARKETS.has(dataset?.market)) throw new RangeError('unsupported market');
  const tradeSide = direction(side);
  if (CASH_MARKETS.has(dataset.market) && tradeSide === 'SHORT') throw new RangeError('cash markets are long-only');
  const rows = normalizeRows(dataset.candles).filter((row) => row.ts <= endTime);
  if (rows.length < 90) throw new RangeError('at least 90 candles are required');
  const runnerCandles = rows.map((row) => ({ ...row }));
  const cheap = buildCheapSignalSeries(rows);
  const preset = RUNNER_RESEARCH_PRESETS.LONG_RUNNER_3ATR;
  const laneCosts = costs ?? DEFAULT_COSTS[dataset.market];
  const states = new Map(ABLATION_DEFINITIONS.map((definition) => [
    definition.id,
    { trades: [], lastExit: -Infinity },
  ]));
  const trialCache = new Map();

  for (let index = 80; index + 1 < rows.length; index += 1) {
    const signalTime = rows[index].ts;
    const entryTime = rows[index + 1].ts;
    if (signalTime < startTime || entryTime > endTime) continue;

    // Ablation changes only the final decision layer; every variant sees the
    // exact same trend+momentum-prefiltered candidate universe.
    if (!improvedRequiredPrefilter(index, tradeSide, cheap, [])) continue;
    const eligible = ABLATION_DEFINITIONS.filter((definition) => {
      const state = states.get(definition.id);
      return signalTime > state.lastExit;
    });
    if (eligible.length === 0) continue;

    const snapshot = buildFeatureSnapshotFromRows(dataset, rows, index, tradeSide);
    for (const definition of eligible) {
      const decision = improvedSignalDecision(snapshot, tradeSide, {
        disabledFamilies: definition.disabledFamilies,
      });
      if (!decision.matched) continue;

      let trial = trialCache.get(signalTime);
      if (!trial) {
        trial = simulateRunner({
          candles: runnerCandles,
          signalAtMs: signalTime,
          direction: tradeSide,
          ...preset,
          costs: laneCosts,
        });
        trialCache.set(signalTime, trial);
      }
      if (trial.entryTs > endTime) continue;

      const funding = fundingImpact(dataset, trial, tradeSide);
      const netReturn = trial.netReturn + funding;
      const maximumExposure = dataset.market === 'CRYPTO_FUTURES' ? futuresMaximumExposure : 1;
      const positionFraction = Math.min(maximumExposure, riskFraction / Math.max(trial.initialRiskPct, 1e-9));
      const accountReturn = netReturn * positionFraction;
      const state = states.get(definition.id);
      state.trades.push(freeze({
        market: dataset.market,
        symbol: dataset.symbol,
        timeframe: dataset.timeframe,
        variant: definition.id === 'FULL' ? 'IMPROVED_TECH_STRUCTURE_V2' : 'ABLATION_' + definition.id,
        side: tradeSide,
        signalTime,
        entryTs: trial.entryTs,
        exitTs: trial.exitTs,
        initialRiskPct: trial.initialRiskPct,
        positionFraction,
        rawNetReturn: trial.netReturn,
        fundingImpact: funding,
        accountReturn,
        exitReason: trial.exitReason,
        decisionScore: decision.score,
        decisionMaximumScore: decision.maximumScore,
        decisionThreshold: decision.threshold,
        disabledFamilies: freeze([...definition.disabledFamilies]),
        structureTransition: decision.structureTransition ?? null,
      }));
      state.lastExit = trial.exitTs;
    }
  }

  return ABLATION_DEFINITIONS.map((definition) => {
    const state = states.get(definition.id);
    return freeze({
      market: dataset.market,
      symbol: dataset.symbol,
      timeframe: dataset.timeframe,
      side: tradeSide,
      variant: definition.id === 'FULL' ? 'IMPROVED_TECH_STRUCTURE_V2' : 'ABLATION_' + definition.id,
      source: dataset.source ?? null,
      costs: freeze({ ...laneCosts }),
      disabledFamilies: freeze([...definition.disabledFamilies]),
      performance: summarizeTrades(state.trades, initialCapital),
      trades: freeze(state.trades),
    });
  });
}

export function runFourMarketOneYearAblation({
  datasets = [],
  startTime = ONE_YEAR_BENCHMARK_START_MS,
  endTime = ONE_YEAR_BENCHMARK_END_MS,
} = {}) {
  if (!Array.isArray(datasets)) throw new TypeError('datasets must be an array');
  const rows = [];
  for (const dataset of datasets) {
    const sides = dataset.market === 'CRYPTO_FUTURES' ? ['LONG', 'SHORT'] : ['LONG'];
    for (const side of sides) {
      rows.push(runOneYearDatasetBenchmark(dataset, {
        variant: 'BASELINE_EMA_PULLBACK_V1',
        side,
        startTime,
        endTime,
      }));
      rows.push(...runOneYearDatasetAblationRows(dataset, {
        side,
        startTime,
        endTime,
      }));
    }
  }

  const markets = {};
  for (const market of SUPPORTED_MARKETS) {
    const marketRows = rows.filter((row) => row.market === market);
    const variants = {
      BASELINE: aggregateResults(marketRows.filter((row) => row.variant === 'BASELINE_EMA_PULLBACK_V1')),
    };
    for (const definition of ABLATION_DEFINITIONS) {
      const variant = definition.id === 'FULL'
        ? 'IMPROVED_TECH_STRUCTURE_V2'
        : 'ABLATION_' + definition.id;
      variants[definition.id] = aggregateResults(marketRows.filter((row) => row.variant === variant));
    }
    const full = variants.FULL;
    const deltas = Object.fromEntries(
      ABLATION_DEFINITIONS.filter((definition) => definition.id !== 'FULL').map((definition) => {
        const row = variants[definition.id];
        return [definition.id, freeze({
          returnDeltaVsFull: row.totalReturn == null || full.totalReturn == null ? null : row.totalReturn - full.totalReturn,
          maximumDrawdownDeltaVsFull: row.maximumDrawdown == null || full.maximumDrawdown == null
            ? null : row.maximumDrawdown - full.maximumDrawdown,
          profitFactorDeltaVsFull: Number.isFinite(row.profitFactor) && Number.isFinite(full.profitFactor)
            ? row.profitFactor - full.profitFactor
            : null,
          tradeCountDeltaVsFull: row.tradeCount - full.tradeCount,
        })];
      }),
    );
    const sourceTimeframes = [...new Set(marketRows.map((row) => String(row.timeframe).toUpperCase()))].sort();
    markets[market] = freeze({
      market,
      sourceTimeframes: freeze(sourceTimeframes),
      sourceTimeframeIdentityExact: sourceTimeframes.length === 1,
      variants: freeze(variants),
      deltas: freeze(deltas),
    });
  }

  return freeze({
    schemaVersion: 'move-hunter-one-year-factor-ablation/v1',
    startTime,
    endTime,
    markets: freeze(markets),
    interpretation: freeze({
      observedHistoryOnly: true,
      candidatePrefilterFrozenAcrossVariants: true,
      ablationScope: 'FINAL_DECISION_LAYER_ONLY',
      selectionFromThisWindowMayNotCountAsOos: true,
      automaticMarketSpecificAdoptionAllowed: false,
      economicSampleCredit: 0,
      profitabilityClaimAllowed: false,
      executionAuthority: 'NONE',
    }),
  });
}
