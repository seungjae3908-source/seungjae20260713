#!/usr/bin/env node
import { writeFile, mkdir } from 'node:fs/promises';
import { collectYahooStockHistory } from '../src/yahoo-stock-history.js';
import { collectUpbitSpotHistory } from '../src/upbit-spot-history.js';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-03-25T00:00:00Z');
const END = Date.parse('2026-09-25T00:00:00Z'); // exclusive
const STOCK_WARMUP = START - 280 * DAY;
const CRYPTO_WARMUP = START - 180 * DAY;

const FROZEN_RULES = Object.freeze({
  schemaVersion: 1,
  strategy: 'SELECTIVE_OPPORTUNITY_6M_V1',
  frozenBeforeDataInspection: true,
  evaluationWindow: { start: '2026-03-25', endInclusive: '2026-09-24' },
  entry: 'next_bar_open',
  sameBarPolicy: 'stop_first_conservative',
  noTradeAllowed: true,
  theme: {
    marketRegime: 'benchmark close > slow SMA and fast SMA > slow SMA',
    breadthMinimum: 0.60,
    themeAlphaMinimumStock: 0.02,
    themeAlphaMinimumCrypto: 0.03,
    leaderCount: 2,
    pullbackStock: [0.02, 0.10],
    pullbackCrypto: [0.03, 0.15],
    relativeVolume: [0.80, 3.00],
    stockStopAtr: 2.5,
    cryptoStopAtr: 2.7,
    firstTargetR: 2,
    secondTargetR: 4,
    maxHoldStockBars: 40,
    maxHoldCryptoBars: 90,
  },
  usExplosionDailyProxy: {
    gapRange: [0.08, 0.50],
    minRelativeVolume: 2.5,
    minDollarVolumeUsd: 20_000_000,
    minCloseLocation: 0.65,
    setupLookaheadBars: 5,
    pullbackRange: [0.05, 0.20],
    stopAtr: 2.0,
    firstTargetR: 1.5,
    secondTargetR: 3,
    maxHoldBars: 10,
    note: 'daily liquid-high-beta proxy; not the microcap premarket/VWAP model',
  },
  costsPerSide: {
    krStock: 0.0025,
    usStock: 0.0015,
    cryptoSpot: 0.0015,
    usExplosionProxy: 0.0050,
    stressMultiplier: 1.5,
  },
  portfolioProxy: {
    riskPerTrade: 0.005,
    notionalCap: 0.20,
    maxConcurrent: 5,
    usExplosionRiskPerTrade: 0.0025,
    usExplosionNotionalCap: 0.10,
  },
  evidenceBoundary: {
    canonicalEvidenceEligible: false,
    profitabilityPromotionAllowed: false,
    executionAuthority: 'NONE',
    actualOrders: 0,
    privateApiAllowed: false,
    themeMembershipPointInTime: false,
    historicalNewsPointInTime: false,
    historicalFloatDilutionPointInTime: false,
    reason: 'static preregistered proxy universes are used; unavailable point-in-time evidence is not fabricated',
  },
});

const KR_THEMES = Object.freeze([
  { key: 'kr_semiconductor_ai', label: '반도체·AI', symbols: ['005930','000660','042700','000990','058470'] },
  { key: 'kr_defense', label: '방산·우주', symbols: ['012450','047810','064350','272210'] },
  { key: 'kr_nuclear_power', label: '원전·전력', symbols: ['034020','052690','051600','015760','001440'] },
  { key: 'kr_battery_ev', label: '2차전지·전기차', symbols: ['373220','006400','051910','003670','247540'] },
  { key: 'kr_bio', label: '바이오·제약', symbols: ['207940','068270','000100','128940','326030'] },
  { key: 'kr_robot', label: '로봇', symbols: ['277810','454910','090360','108490'] },
]);

const US_THEMES = Object.freeze([
  { key: 'us_ai_semis', label: 'AI·반도체', symbols: ['NVDA','AMD','AVGO','TSM','ARM','MU'] },
  { key: 'us_quantum', label: '양자컴퓨팅', symbols: ['IONQ','RGTI','QBTS','QUBT'] },
  { key: 'us_nuclear_power', label: '원전·전력', symbols: ['CEG','VST','OKLO','SMR','CCJ'] },
  { key: 'us_defense_drones', label: '방산·드론', symbols: ['PLTR','AVAV','KTOS','LMT','RTX'] },
  { key: 'us_space', label: '우주', symbols: ['RKLB','LUNR','ASTS','RDW'] },
  { key: 'us_ai_software', label: 'AI·소프트웨어', symbols: ['PLTR','SOUN','BBAI','AI','SNOW'] },
]);

const CRYPTO_THEMES = Object.freeze([
  { key: 'crypto_l1', label: 'L1·메이저', symbols: ['BTC','ETH','SOL','ADA','AVAX','SUI','APT','NEAR'] },
  { key: 'crypto_ai', label: 'AI·데이터', symbols: ['FET','RENDER','ARKM','WLD','GRT'] },
  { key: 'crypto_defi', label: 'DeFi', symbols: ['UNI','AAVE','LINK','LDO','PENDLE'] },
  { key: 'crypto_meme', label: '밈', symbols: ['DOGE','SHIB','PEPE','BONK'] },
  { key: 'crypto_payments', label: '결제·송금', symbols: ['XRP','XLM','HBAR'] },
]);

const US_EXPLOSION_SYMBOLS = Object.freeze([
  ...new Set([
    ...US_THEMES.flatMap((theme) => theme.symbols),
    'ACHR','JOBY','RCAT','CRDO','TEM','HIMS','SOFI','MARA','RIOT','CLSK','COIN',
  ]),
]);

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function sum(values) { return values.reduce((a, b) => a + b, 0); }
function clamp(value, min = 0, max = 1) { return Math.min(max, Math.max(min, value)); }
function sma(candles, index, period) {
  if (index - period + 1 < 0) return null;
  let total = 0;
  for (let i = index - period + 1; i <= index; i += 1) total += candles[i].close;
  return total / period;
}
function averageVolumeBefore(candles, index, period) {
  if (index - period < 0) return null;
  let total = 0;
  for (let i = index - period; i < index; i += 1) total += candles[i].volume;
  return total / period;
}
function atr(candles, index, period = 14) {
  if (index < period) return null;
  let total = 0;
  for (let i = index - period + 1; i <= index; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];
    total += Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    );
  }
  return total / period;
}
function highestHigh(candles, index, period) {
  if (index - period + 1 < 0) return null;
  let value = -Infinity;
  for (let i = index - period + 1; i <= index; i += 1) value = Math.max(value, candles[i].high);
  return Number.isFinite(value) ? value : null;
}
function returnBars(candles, index, bars) {
  if (index - bars < 0) return null;
  const base = candles[index - bars].close;
  return base > 0 ? candles[index].close / base - 1 : null;
}
function closeLocation(candle) {
  const range = candle.high - candle.low;
  return range > 0 ? (candle.close - candle.low) / range : 0.5;
}
function candleMap(candles) {
  return new Map(candles.map((row, index) => [row.timestamp, { row, index }]));
}
function round(value, digits = 6) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function iso(timestamp) { return new Date(timestamp).toISOString(); }

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

async function collectStocks(market, symbols) {
  const unique = [...new Set(symbols)];
  const failures = [];
  const rows = await mapLimit(unique, 4, async (symbol) => {
    try {
      const history = await collectYahooStockHistory({
        market,
        symbol,
        startTime: STOCK_WARMUP,
        endTime: END,
        timeoutMs: 20_000,
      });
      return [symbol, history.candles];
    } catch (error) {
      failures.push({ symbol, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  });
  return {
    data: new Map(rows.filter(Boolean)),
    failures,
  };
}

async function collectCrypto(symbols) {
  const unique = [...new Set(symbols)];
  const data = new Map();
  const failures = [];
  for (const symbol of unique) {
    try {
      const history = await collectUpbitSpotHistory({
        symbol,
        startTime: CRYPTO_WARMUP,
        endTime: END,
        minIntervalMs: 120,
        maxPages: 24,
      });
      data.set(symbol, history.candles);
    } catch (error) {
      failures.push({ symbol, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { data, failures };
}

function applyCost(rawTrade, costPerSide) {
  const effectiveEntry = rawTrade.entryPrice * (1 + costPerSide);
  const effectiveExit = rawTrade.weightedExitPrice * (1 - costPerSide);
  return {
    ...rawTrade,
    costPerSide,
    netReturn: effectiveExit / effectiveEntry - 1,
  };
}

function simulateRunnerTrade(candles, signalIndex, options) {
  const entryIndex = signalIndex + 1;
  if (entryIndex >= candles.length) return null;
  const signalAtr = atr(candles, signalIndex, 14);
  if (!(signalAtr > 0)) return null;
  const entry = candles[entryIndex];
  const initialStop = entry.open - signalAtr * options.stopAtr;
  if (!(initialStop > 0 && initialStop < entry.open)) return null;
  const risk = entry.open - initialStop;
  const target1 = entry.open + risk * options.target1R;
  const target2 = entry.open + risk * options.target2R;

  let remaining = 1;
  let weightedExit = 0;
  let stop = initialStop;
  let highestClose = entry.open;
  let target1Done = false;
  let target2Done = false;
  let exitIndex = entryIndex;
  let exitReason = 'time';

  const firstWeight = 1 / 3;
  const secondWeight = 1 / 3;

  for (let i = entryIndex; i <= Math.min(candles.length - 1, entryIndex + options.maxHoldBars - 1); i += 1) {
    const candle = candles[i];
    exitIndex = i;

    // Conservative: if stop and target are both inside one OHLC bar, stop wins.
    const stopTouched = candle.open <= stop || candle.low <= stop;
    if (stopTouched) {
      const rawExit = candle.open <= stop ? candle.open : stop;
      weightedExit += remaining * rawExit;
      remaining = 0;
      exitReason = candle.open <= stop ? 'stop_gap' : 'stop';
      break;
    }

    if (!target1Done && candle.high >= target1) {
      weightedExit += firstWeight * target1;
      remaining -= firstWeight;
      target1Done = true;
      exitReason = 'partial_target';
    }
    if (!target2Done && candle.high >= target2) {
      weightedExit += secondWeight * target2;
      remaining -= secondWeight;
      target2Done = true;
      exitReason = 'partial_target';
    }

    highestClose = Math.max(highestClose, candle.close);
    if (target1Done && remaining > 0) {
      const currentAtr = atr(candles, i, 14) ?? signalAtr;
      const trailCandidate = highestClose - currentAtr * options.trailAtr;
      stop = Math.max(stop, entry.open, trailCandidate);
    }

    const terminal = i === Math.min(candles.length - 1, entryIndex + options.maxHoldBars - 1);
    if (terminal && remaining > 0) {
      weightedExit += remaining * candle.close;
      remaining = 0;
      exitReason = 'time';
      break;
    }
  }

  if (remaining > 0) {
    const candle = candles[exitIndex];
    weightedExit += remaining * candle.close;
    remaining = 0;
  }

  const weightedExitPrice = weightedExit;
  const rawReturn = weightedExitPrice / entry.open - 1;
  return {
    signalTimestamp: candles[signalIndex].timestamp,
    entryTimestamp: entry.timestamp,
    exitTimestamp: candles[exitIndex].timestamp,
    signalIndex,
    entryIndex,
    exitIndex,
    entryPrice: entry.open,
    initialStop,
    stopPercent: (entry.open - initialStop) / entry.open,
    target1,
    target2,
    target1Done,
    target2Done,
    weightedExitPrice,
    rawReturn,
    holdBars: exitIndex - entryIndex + 1,
    exitReason,
  };
}

function benchmarkReturn(candles) {
  const inside = candles.filter((row) => row.timestamp >= START && row.timestamp < END);
  if (inside.length < 2) return null;
  return inside.at(-1).close / inside[0].close - 1;
}

function summarizeTrades(trades) {
  const returns = trades.map((trade) => trade.netReturn).filter(Number.isFinite);
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value < 0);
  const grossProfit = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  return {
    trades: returns.length,
    wins: wins.length,
    losses: losses.length,
    winRate: returns.length ? wins.length / returns.length : null,
    expectancy: mean(returns),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    averageWinner: mean(wins),
    averageLoser: mean(losses),
    medianHoldBars: (() => {
      if (!trades.length) return null;
      const values = trades.map((row) => row.holdBars).sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    })(),
    target1HitRate: trades.length ? trades.filter((row) => row.target1Done).length / trades.length : null,
    target2HitRate: trades.length ? trades.filter((row) => row.target2Done).length / trades.length : null,
  };
}

function portfolioProxy(trades, options = {}) {
  const riskPerTrade = options.riskPerTrade ?? FROZEN_RULES.portfolioProxy.riskPerTrade;
  const notionalCap = options.notionalCap ?? FROZEN_RULES.portfolioProxy.notionalCap;
  const maxConcurrent = options.maxConcurrent ?? FROZEN_RULES.portfolioProxy.maxConcurrent;
  const ordered = [...trades].sort((a, b) => a.entryTimestamp - b.entryTimestamp || a.symbol.localeCompare(b.symbol));
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  const active = [];
  const equityCurve = [{ timestamp: START, equity }];
  let accepted = 0;
  let rejectedCapacity = 0;

  const realizeUntil = (timestamp) => {
    active.sort((a, b) => a.exitTimestamp - b.exitTimestamp);
    while (active.length && active[0].exitTimestamp <= timestamp) {
      const position = active.shift();
      equity += position.notional * position.netReturn;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
      equityCurve.push({ timestamp: position.exitTimestamp, equity });
    }
  };

  for (const trade of ordered) {
    realizeUntil(trade.entryTimestamp);
    if (active.length >= maxConcurrent) {
      rejectedCapacity += 1;
      continue;
    }
    const riskFraction = Math.max(0.001, trade.stopPercent);
    const notional = Math.min(equity * notionalCap, equity * riskPerTrade / riskFraction);
    if (!(notional > 0)) continue;
    active.push({ ...trade, notional });
    accepted += 1;
  }
  realizeUntil(Number.POSITIVE_INFINITY);

  return {
    acceptedTrades: accepted,
    capacityRejectedTrades: rejectedCapacity,
    netReturn: equity - 1,
    finalEquity: equity,
    realizedEquityMaxDrawdown: maxDrawdown,
    maxConcurrent,
    riskPerTrade,
    notionalCap,
    equityCurve,
  };
}

function getAt(map, timestamp) {
  return map.get(timestamp) ?? null;
}

function evaluateThemeLane({
  market,
  themes,
  data,
  benchmarkSymbol,
  costs,
  config,
}) {
  const benchmarkCandles = data.get(benchmarkSymbol);
  if (!benchmarkCandles) throw new Error(`BENCHMARK_MISSING:${market}:${benchmarkSymbol}`);
  const benchmarkByTime = candleMap(benchmarkCandles);
  const allRawTrades = [];
  const diagnostics = [];
  let evaluatedThemeBars = 0;
  let validThemeBars = 0;

  for (const theme of themes) {
    const available = theme.symbols.filter((symbol) => data.has(symbol));
    if (available.length < 3) {
      diagnostics.push({ theme: theme.key, status: 'SKIP_INSUFFICIENT_MEMBERS', available });
      continue;
    }
    const maps = new Map(available.map((symbol) => [symbol, candleMap(data.get(symbol))]));
    const anchor = data.get(available[0]);
    const params = config;
    const rawSignals = [];

    for (let anchorIndex = params.slowBars + 2; anchorIndex < anchor.length - 1; anchorIndex += 1) {
      const timestamp = anchor[anchorIndex].timestamp;
      if (timestamp < START || timestamp >= END) continue;
      evaluatedThemeBars += 1;
      const benchEntry = getAt(benchmarkByTime, timestamp);
      if (!benchEntry || benchEntry.index < params.slowBars) continue;
      const benchFast = sma(benchmarkCandles, benchEntry.index, params.fastBars);
      const benchSlow = sma(benchmarkCandles, benchEntry.index, params.slowBars);
      if (benchFast == null || benchSlow == null) continue;
      const marketRegime = benchEntry.row.close > benchSlow && benchFast > benchSlow;
      if (!marketRegime) continue;

      const snapshots = [];
      for (const symbol of available) {
        const entry = getAt(maps.get(symbol), timestamp);
        if (!entry || entry.index < params.slowBars) continue;
        const candles = data.get(symbol);
        const fast = sma(candles, entry.index, params.fastBars);
        const slow = sma(candles, entry.index, params.slowBars);
        const retFast = returnBars(candles, entry.index, params.momentumBars);
        const retSlow = returnBars(candles, entry.index, params.longMomentumBars);
        const rvBase = averageVolumeBefore(candles, entry.index, 20);
        const rvol = rvBase && rvBase > 0 ? entry.row.volume / rvBase : null;
        const high = highestHigh(candles, entry.index, params.highLookback);
        if ([fast, slow, retFast, retSlow, rvol, high].some((value) => value == null)) continue;
        snapshots.push({
          symbol,
          entry,
          fast,
          slow,
          retFast,
          retSlow,
          rvol,
          high,
          aboveFast: entry.row.close > fast,
          leaderStrength: retFast * 0.65 + retSlow * 0.35,
        });
      }
      if (snapshots.length < 3) continue;
      const breadth = snapshots.filter((row) => row.aboveFast).length / snapshots.length;
      const benchmarkRet = returnBars(benchmarkCandles, benchEntry.index, params.momentumBars);
      const themeRet = mean(snapshots.map((row) => row.retFast));
      if (benchmarkRet == null || themeRet == null) continue;
      const themeAlpha = themeRet - benchmarkRet;
      if (breadth < FROZEN_RULES.theme.breadthMinimum || themeAlpha < params.themeAlphaMinimum) continue;
      validThemeBars += 1;

      const leaders = [...snapshots]
        .sort((a, b) => b.leaderStrength - a.leaderStrength || b.rvol - a.rvol || a.symbol.localeCompare(b.symbol))
        .slice(0, FROZEN_RULES.theme.leaderCount);

      for (const leader of leaders) {
        const candles = data.get(leader.symbol);
        const index = leader.entry.index;
        const current = leader.entry.row;
        const previous = candles[index - 1];
        const pullback = leader.high > 0 ? 1 - current.close / leader.high : null;
        const overextension = current.close / leader.fast - 1;
        const bullish = current.close > current.open && current.close > previous.close;
        const qualifies = pullback != null
          && pullback >= params.pullbackMin
          && pullback <= params.pullbackMax
          && current.close > leader.fast
          && leader.fast > leader.slow
          && bullish
          && leader.rvol >= FROZEN_RULES.theme.relativeVolume[0]
          && leader.rvol <= FROZEN_RULES.theme.relativeVolume[1]
          && overextension <= params.maxOverextension;
        if (!qualifies) continue;
        rawSignals.push({
          symbol: leader.symbol,
          theme: theme.key,
          themeLabel: theme.label,
          signalIndex: index,
          signalTimestamp: timestamp,
          breadth,
          themeAlpha,
          leaderStrength: leader.leaderStrength,
          rvol: leader.rvol,
          pullback,
        });
      }
    }

    // Prevent overlapping same-symbol trades. First eligible setup wins until exit.
    const lastExitBySymbol = new Map();
    let emitted = 0;
    for (const signal of rawSignals.sort((a, b) => a.signalTimestamp - b.signalTimestamp || a.symbol.localeCompare(b.symbol))) {
      const candles = data.get(signal.symbol);
      const previousExit = lastExitBySymbol.get(signal.symbol) ?? -Infinity;
      if (signal.signalTimestamp <= previousExit) continue;
      const rawTrade = simulateRunnerTrade(candles, signal.signalIndex, {
        stopAtr: params.stopAtr,
        target1R: FROZEN_RULES.theme.firstTargetR,
        target2R: FROZEN_RULES.theme.secondTargetR,
        trailAtr: params.trailAtr,
        maxHoldBars: params.maxHoldBars,
      });
      if (!rawTrade || rawTrade.entryTimestamp >= END) continue;
      allRawTrades.push({
        ...rawTrade,
        symbol: signal.symbol,
        lane: market,
        theme: signal.theme,
        themeLabel: signal.themeLabel,
        breadth: signal.breadth,
        themeAlpha: signal.themeAlpha,
        rvol: signal.rvol,
        pullback: signal.pullback,
      });
      lastExitBySymbol.set(signal.symbol, rawTrade.exitTimestamp);
      emitted += 1;
    }
    diagnostics.push({ theme: theme.key, status: 'EVALUATED', available, rawSignals: rawSignals.length, emittedTrades: emitted });
  }

  const trades = allRawTrades.map((trade) => applyCost(trade, costs));
  const stressTrades = allRawTrades.map((trade) => applyCost(trade, costs * FROZEN_RULES.costsPerSide.stressMultiplier));
  return {
    market,
    benchmarkSymbol,
    benchmarkReturn: benchmarkReturn(benchmarkCandles),
    evaluatedThemeBars,
    validThemeBars,
    selectivity: evaluatedThemeBars ? validThemeBars / evaluatedThemeBars : null,
    metrics: summarizeTrades(trades),
    stressMetrics: summarizeTrades(stressTrades),
    portfolio: portfolioProxy(trades),
    stressPortfolio: portfolioProxy(stressTrades),
    diagnostics,
    trades,
  };
}

function evaluateUsExplosion({ data, benchmarkSymbol }) {
  const benchmarkCandles = data.get(benchmarkSymbol);
  if (!benchmarkCandles) throw new Error('US_EXPLOSION_BENCHMARK_MISSING');
  const benchmarkByTime = candleMap(benchmarkCandles);
  const rawTrades = [];
  const events = [];

  for (const symbol of US_EXPLOSION_SYMBOLS) {
    const candles = data.get(symbol);
    if (!candles || candles.length < 80) continue;
    let lastExit = -Infinity;
    for (let i = 21; i < candles.length - 2; i += 1) {
      const candle = candles[i];
      if (candle.timestamp < START || candle.timestamp >= END) continue;
      if (candle.timestamp <= lastExit) continue;
      const previous = candles[i - 1];
      const avgVolume = averageVolumeBefore(candles, i, 20);
      if (!(avgVolume > 0)) continue;
      const gap = candle.open / previous.close - 1;
      const rvol = candle.volume / avgVolume;
      const dollarVolume = candle.close * candle.volume;
      const dayReturn = candle.close / previous.close - 1;
      const benchEntry = getAt(benchmarkByTime, candle.timestamp);
      if (!benchEntry || benchEntry.index < 20) continue;
      const bench20 = returnBars(benchmarkCandles, benchEntry.index, 20);
      if (bench20 == null || bench20 < -0.08) continue;
      const exploded = previous.close >= 1
        && previous.close <= 80
        && gap >= FROZEN_RULES.usExplosionDailyProxy.gapRange[0]
        && gap <= FROZEN_RULES.usExplosionDailyProxy.gapRange[1]
        && dayReturn >= 0.08
        && rvol >= FROZEN_RULES.usExplosionDailyProxy.minRelativeVolume
        && dollarVolume >= FROZEN_RULES.usExplosionDailyProxy.minDollarVolumeUsd
        && closeLocation(candle) >= FROZEN_RULES.usExplosionDailyProxy.minCloseLocation;
      if (!exploded) continue;

      let setupIndex = null;
      for (let j = i + 1; j <= Math.min(candles.length - 2, i + FROZEN_RULES.usExplosionDailyProxy.setupLookaheadBars); j += 1) {
        const setup = candles[j];
        const prior = candles[j - 1];
        const pullback = 1 - setup.close / candle.high;
        const contraction = setup.volume <= candle.volume * 0.90;
        const constructive = setup.close > setup.open && setup.close > prior.close && setup.close > candle.open;
        if (pullback >= FROZEN_RULES.usExplosionDailyProxy.pullbackRange[0]
          && pullback <= FROZEN_RULES.usExplosionDailyProxy.pullbackRange[1]
          && contraction
          && constructive) {
          setupIndex = j;
          break;
        }
      }
      events.push({ symbol, timestamp: candle.timestamp, gap, rvol, dollarVolume, dayReturn, setupFound: setupIndex != null });
      if (setupIndex == null) continue;
      const trade = simulateRunnerTrade(candles, setupIndex, {
        stopAtr: FROZEN_RULES.usExplosionDailyProxy.stopAtr,
        target1R: FROZEN_RULES.usExplosionDailyProxy.firstTargetR,
        target2R: FROZEN_RULES.usExplosionDailyProxy.secondTargetR,
        trailAtr: 2.5,
        maxHoldBars: FROZEN_RULES.usExplosionDailyProxy.maxHoldBars,
      });
      if (!trade || trade.entryTimestamp >= END) continue;
      rawTrades.push({ ...trade, symbol, lane: 'US_EXPLOSION_DAILY_PROXY', explosionTimestamp: candle.timestamp, gap, rvol, dollarVolume });
      lastExit = trade.exitTimestamp;
    }
  }

  const cost = FROZEN_RULES.costsPerSide.usExplosionProxy;
  const trades = rawTrades.map((trade) => applyCost(trade, cost));
  const stressTrades = rawTrades.map((trade) => applyCost(trade, cost * FROZEN_RULES.costsPerSide.stressMultiplier));
  return {
    market: 'US_EXPLOSION_DAILY_PROXY',
    benchmarkSymbol,
    benchmarkReturn: benchmarkReturn(benchmarkCandles),
    eventCount: events.length,
    setupConversionCount: events.filter((event) => event.setupFound).length,
    setupConversionRate: events.length ? events.filter((event) => event.setupFound).length / events.length : null,
    metrics: summarizeTrades(trades),
    stressMetrics: summarizeTrades(stressTrades),
    portfolio: portfolioProxy(trades, {
      riskPerTrade: FROZEN_RULES.portfolioProxy.usExplosionRiskPerTrade,
      notionalCap: FROZEN_RULES.portfolioProxy.usExplosionNotionalCap,
      maxConcurrent: 3,
    }),
    stressPortfolio: portfolioProxy(stressTrades, {
      riskPerTrade: FROZEN_RULES.portfolioProxy.usExplosionRiskPerTrade,
      notionalCap: FROZEN_RULES.portfolioProxy.usExplosionNotionalCap,
      maxConcurrent: 3,
    }),
    events,
    trades,
  };
}

function compactLane(lane) {
  return {
    market: lane.market,
    benchmarkSymbol: lane.benchmarkSymbol,
    benchmarkReturnPct: round((lane.benchmarkReturn ?? 0) * 100, 3),
    eventCount: lane.eventCount ?? null,
    setupConversionCount: lane.setupConversionCount ?? null,
    setupConversionRatePct: lane.setupConversionRate == null ? null : round(lane.setupConversionRate * 100, 3),
    evaluatedThemeBars: lane.evaluatedThemeBars ?? null,
    validThemeBars: lane.validThemeBars ?? null,
    selectivityPct: lane.selectivity == null ? null : round(lane.selectivity * 100, 3),
    metrics: {
      ...lane.metrics,
      winRatePct: lane.metrics.winRate == null ? null : round(lane.metrics.winRate * 100, 3),
      expectancyPct: lane.metrics.expectancy == null ? null : round(lane.metrics.expectancy * 100, 3),
      averageWinnerPct: lane.metrics.averageWinner == null ? null : round(lane.metrics.averageWinner * 100, 3),
      averageLoserPct: lane.metrics.averageLoser == null ? null : round(lane.metrics.averageLoser * 100, 3),
      target1HitRatePct: lane.metrics.target1HitRate == null ? null : round(lane.metrics.target1HitRate * 100, 3),
      target2HitRatePct: lane.metrics.target2HitRate == null ? null : round(lane.metrics.target2HitRate * 100, 3),
    },
    stressMetrics: {
      ...lane.stressMetrics,
      winRatePct: lane.stressMetrics.winRate == null ? null : round(lane.stressMetrics.winRate * 100, 3),
      expectancyPct: lane.stressMetrics.expectancy == null ? null : round(lane.stressMetrics.expectancy * 100, 3),
    },
    portfolio: {
      ...lane.portfolio,
      netReturnPct: round(lane.portfolio.netReturn * 100, 3),
      realizedEquityMaxDrawdownPct: round(lane.portfolio.realizedEquityMaxDrawdown * 100, 3),
      equityCurve: undefined,
    },
    stressPortfolio: {
      ...lane.stressPortfolio,
      netReturnPct: round(lane.stressPortfolio.netReturn * 100, 3),
      realizedEquityMaxDrawdownPct: round(lane.stressPortfolio.realizedEquityMaxDrawdown * 100, 3),
      equityCurve: undefined,
    },
  };
}

function combinedPortfolio(lanes) {
  const trades = lanes.flatMap((lane) => lane.trades);
  const stressTrades = lanes.flatMap((lane) => lane.trades.map((trade) => {
    const laneCost = trade.lane === 'KR_STOCK'
      ? FROZEN_RULES.costsPerSide.krStock
      : trade.lane === 'US_STOCK'
        ? FROZEN_RULES.costsPerSide.usStock
        : trade.lane === 'CRYPTO_SPOT'
          ? FROZEN_RULES.costsPerSide.cryptoSpot
          : FROZEN_RULES.costsPerSide.usExplosionProxy;
    return applyCost(trade, laneCost * FROZEN_RULES.costsPerSide.stressMultiplier);
  }));
  return {
    normal: portfolioProxy(trades, { riskPerTrade: 0.0035, notionalCap: 0.15, maxConcurrent: 8 }),
    stress: portfolioProxy(stressTrades, { riskPerTrade: 0.0035, notionalCap: 0.15, maxConcurrent: 8 }),
  };
}

function markdown(result) {
  const lines = [
    '# Selective Opportunity 6M V1 — Research-only proxy backtest',
    '',
    `Window: **${FROZEN_RULES.evaluationWindow.start} ~ ${FROZEN_RULES.evaluationWindow.endInclusive}**`,
    '',
    '> Non-canonical exploratory evidence. Static theme universes are not point-in-time membership history; unavailable historical news/float/dilution evidence is not fabricated.',
    '',
    '| Lane | Trades | Win | Expectancy/trade | PF | Portfolio proxy | Realized MDD | Benchmark |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const lane of result.summary.lanes) {
    lines.push(`| ${lane.market} | ${lane.metrics.trades} | ${lane.metrics.winRatePct ?? 'NA'}% | ${lane.metrics.expectancyPct ?? 'NA'}% | ${lane.metrics.profitFactor == null ? 'NA' : round(lane.metrics.profitFactor, 3)} | ${lane.portfolio.netReturnPct}% | ${lane.portfolio.realizedEquityMaxDrawdownPct}% | ${lane.benchmarkReturnPct}% |`);
  }
  lines.push(
    '',
    '## Combined equal-risk proxy',
    '',
    `- Normal net return: **${round(result.summary.combined.normal.netReturn * 100, 3)}%**`,
    `- Normal realized-equity MDD: **${round(result.summary.combined.normal.realizedEquityMaxDrawdown * 100, 3)}%**`,
    `- Stress net return: **${round(result.summary.combined.stress.netReturn * 100, 3)}%**`,
    `- Stress realized-equity MDD: **${round(result.summary.combined.stress.realizedEquityMaxDrawdown * 100, 3)}%**`,
    '',
    '## Evidence boundary',
    '',
    '- executionAuthority = NONE',
    '- actualOrders = 0',
    '- profitabilityPromotionAllowed = false',
    '- themeMembershipPointInTime = false',
    '- historicalNewsPointInTime = false',
    '- historicalFloatDilutionPointInTime = false',
    '- US Explosion lane is a daily liquid/high-beta proxy, not the microcap premarket/VWAP strategy.',
    '',
  );
  return lines.join('\n') + '\n';
}

function syntheticCandles({ start = Date.parse('2025-01-01T00:00:00Z'), bars = 180, step = DAY, drift = 0.002 }) {
  const rows = [];
  let close = 100;
  for (let i = 0; i < bars; i += 1) {
    const wave = Math.sin(i / 8) * 0.01;
    const open = close * (1 + wave * 0.2);
    close = Math.max(1, open * (1 + drift + wave * 0.1));
    rows.push({
      timestamp: start + i * step,
      open,
      high: Math.max(open, close) * 1.01,
      low: Math.min(open, close) * 0.99,
      close,
      volume: 1_000_000 * (1 + (i % 7) * 0.05),
    });
  }
  return rows;
}

function selfTest() {
  const candles = syntheticCandles({});
  if (!(sma(candles, 80, 20) > 0)) throw new Error('SELF_TEST_SMA');
  if (!(atr(candles, 80, 14) > 0)) throw new Error('SELF_TEST_ATR');
  const trade = simulateRunnerTrade(candles, 100, { stopAtr: 2.5, target1R: 2, target2R: 4, trailAtr: 3, maxHoldBars: 20 });
  if (!trade || !(trade.stopPercent > 0)) throw new Error('SELF_TEST_TRADE');
  const costed = applyCost(trade, 0.0015);
  if (!Number.isFinite(costed.netReturn)) throw new Error('SELF_TEST_COST');
  const portfolio = portfolioProxy([{ ...costed, symbol: 'TEST' }]);
  if (!Number.isFinite(portfolio.netReturn)) throw new Error('SELF_TEST_PORTFOLIO');
  console.log('SELECTIVE_OPPORTUNITY_6M_V1_SELF_TEST_OK');
}

async function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const outputJson = process.argv[2] ?? 'docs/selective-opportunity-6m-v1-result.json';
  const outputMd = process.argv[3] ?? 'docs/selective-opportunity-6m-v1-result.md';

  const krSymbols = [...new Set(['069500', ...KR_THEMES.flatMap((theme) => theme.symbols)])];
  const usSymbols = [...new Set(['SPY', ...US_THEMES.flatMap((theme) => theme.symbols), ...US_EXPLOSION_SYMBOLS])];
  const cryptoSymbols = [...new Set(CRYPTO_THEMES.flatMap((theme) => theme.symbols))];

  const [krCollected, usCollected, cryptoCollected] = await Promise.all([
    collectStocks('KR_STOCK', krSymbols),
    collectStocks('US_STOCK', usSymbols),
    collectCrypto(cryptoSymbols),
  ]);

  const kr = evaluateThemeLane({
    market: 'KR_STOCK',
    themes: KR_THEMES,
    data: krCollected.data,
    benchmarkSymbol: '069500',
    costs: FROZEN_RULES.costsPerSide.krStock,
    config: {
      fastBars: 20, slowBars: 60, momentumBars: 20, longMomentumBars: 60, highLookback: 20,
      pullbackMin: FROZEN_RULES.theme.pullbackStock[0], pullbackMax: FROZEN_RULES.theme.pullbackStock[1],
      themeAlphaMinimum: FROZEN_RULES.theme.themeAlphaMinimumStock,
      maxOverextension: 0.08, stopAtr: FROZEN_RULES.theme.stockStopAtr, trailAtr: 3.0,
      maxHoldBars: FROZEN_RULES.theme.maxHoldStockBars,
    },
  });
  const us = evaluateThemeLane({
    market: 'US_STOCK',
    themes: US_THEMES,
    data: usCollected.data,
    benchmarkSymbol: 'SPY',
    costs: FROZEN_RULES.costsPerSide.usStock,
    config: {
      fastBars: 20, slowBars: 60, momentumBars: 20, longMomentumBars: 60, highLookback: 20,
      pullbackMin: FROZEN_RULES.theme.pullbackStock[0], pullbackMax: FROZEN_RULES.theme.pullbackStock[1],
      themeAlphaMinimum: FROZEN_RULES.theme.themeAlphaMinimumStock,
      maxOverextension: 0.08, stopAtr: FROZEN_RULES.theme.stockStopAtr, trailAtr: 3.0,
      maxHoldBars: FROZEN_RULES.theme.maxHoldStockBars,
    },
  });
  const crypto = evaluateThemeLane({
    market: 'CRYPTO_SPOT',
    themes: CRYPTO_THEMES,
    data: cryptoCollected.data,
    benchmarkSymbol: 'BTC',
    costs: FROZEN_RULES.costsPerSide.cryptoSpot,
    config: {
      fastBars: 30, slowBars: 120, momentumBars: 30, longMomentumBars: 90, highLookback: 30,
      pullbackMin: FROZEN_RULES.theme.pullbackCrypto[0], pullbackMax: FROZEN_RULES.theme.pullbackCrypto[1],
      themeAlphaMinimum: FROZEN_RULES.theme.themeAlphaMinimumCrypto,
      maxOverextension: 0.12, stopAtr: FROZEN_RULES.theme.cryptoStopAtr, trailAtr: 3.2,
      maxHoldBars: FROZEN_RULES.theme.maxHoldCryptoBars,
    },
  });
  const explosion = evaluateUsExplosion({ data: usCollected.data, benchmarkSymbol: 'SPY' });
  const lanes = [kr, us, explosion, crypto];
  const combined = combinedPortfolio(lanes);

  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    researchCodeSha: process.env.RESEARCH_CODE_SHA ?? null,
    frozenRules: FROZEN_RULES,
    collection: {
      kr: { requested: krSymbols.length, collected: krCollected.data.size, failures: krCollected.failures },
      us: { requested: usSymbols.length, collected: usCollected.data.size, failures: usCollected.failures },
      crypto: { requested: cryptoSymbols.length, collected: cryptoCollected.data.size, failures: cryptoCollected.failures },
    },
    summary: {
      lanes: lanes.map(compactLane),
      combined,
    },
    detail: {
      lanes: Object.fromEntries(lanes.map((lane) => [lane.market, lane])),
    },
    conclusionAuthority: {
      canonicalEvidenceEligible: false,
      profitabilityProven: false,
      profitabilityPromotionAllowed: false,
      executionAuthority: 'NONE',
      actualOrders: 0,
    },
  };

  await mkdir(new URL('../docs/', import.meta.url), { recursive: true }).catch(() => {});
  await mkdir(outputJson.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  await mkdir(outputMd.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  await writeFile(outputJson, JSON.stringify(result, null, 2) + '\n', 'utf8');
  await writeFile(outputMd, markdown(result), 'utf8');
  console.log(markdown(result));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
