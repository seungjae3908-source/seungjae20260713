export const MARKETS = Object.freeze({
  KR_STOCK: 'KR_STOCK',
  US_STOCK: 'US_STOCK',
  CRYPTO_SPOT: 'CRYPTO_SPOT',
  CRYPTO_FUTURES: 'CRYPTO_FUTURES',
});

const MARKET_VALUES = new Set(Object.values(MARKETS));

function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function pct(from, to) {
  return from > 0 ? (to / from) - 1 : 0;
}

function validateCandle(candle, index) {
  for (const key of ['ts', 'open', 'high', 'low', 'close', 'volume']) {
    finite(candle[key], `candle[${index}].${key}`);
  }
  if (candle.ts < 0 || candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0 || candle.volume < 0) {
    throw new RangeError(`invalid candle at index ${index}`);
  }
  if (candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close, candle.high)) {
    throw new RangeError(`inconsistent OHLC at index ${index}`);
  }
}

export function validateCandles(candles) {
  if (!Array.isArray(candles)) throw new TypeError('candles must be an array');
  let previousTs = -Infinity;
  candles.forEach((candle, index) => {
    validateCandle(candle, index);
    if (candle.ts <= previousTs) throw new RangeError('candles must be strictly time-sorted');
    previousTs = candle.ts;
  });
  return candles;
}

export function candlesAtOrBefore(candles, asOf) {
  validateCandles(candles);
  finite(asOf, 'asOf');
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid].ts <= asOf) lo = mid + 1;
    else hi = mid;
  }
  return candles.slice(0, lo);
}

export function trueRange(current, previousClose) {
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previousClose),
    Math.abs(current.low - previousClose),
  );
}

export function atr(candles, period = 14) {
  validateCandles(candles);
  if (candles.length < 2) return 0;
  const start = Math.max(1, candles.length - period);
  const ranges = [];
  for (let i = start; i < candles.length; i += 1) {
    ranges.push(trueRange(candles[i], candles[i - 1].close));
  }
  return mean(ranges);
}

export function scorePastOnly(candles, asOf) {
  const past = candlesAtOrBefore(candles, asOf);
  if (past.length < 30) return null;
  const last = past.at(-1);
  const ret5 = pct(past.at(-6).close, last.close);
  const ret15 = pct(past.at(-16).close, last.close);
  const ret30 = pct(past.at(-30).close, last.close);
  const avgVol20 = mean(past.slice(-21, -1).map((c) => c.volume));
  const rvol = avgVol20 > 0 ? last.volume / avgVol20 : 0;
  const prior20High = Math.max(...past.slice(-21, -1).map((c) => c.high));
  const breakout = prior20High > 0 ? Math.max(0, pct(prior20High, last.close)) : 0;
  const avgClose10 = mean(past.slice(-10).map((c) => c.close));
  const trend = avgClose10 > 0 ? pct(avgClose10, last.close) : 0;
  const a = atr(past, 14);
  const atrPct = a > 0 ? a / last.close : 0;

  const score =
    clamp(ret5 * 900, -15, 25) +
    clamp(ret15 * 500, -15, 25) +
    clamp(ret30 * 250, -10, 15) +
    clamp((rvol - 1) * 12, -8, 24) +
    clamp(breakout * 1000, 0, 15) +
    clamp(trend * 700, -10, 15) -
    clamp(Math.max(0, atrPct - 0.06) * 200, 0, 10);

  return {
    score,
    features: { ret5, ret15, ret30, rvol, breakout, trend, atrPct },
    lastTs: last.ts,
    lastClose: last.close,
  };
}

export function discoverCandidates({ market, symbols, candlesBySymbol, asOf, topK = 20, minScore = 0 }) {
  if (!MARKET_VALUES.has(market)) throw new RangeError(`unsupported market: ${market}`);
  if (!Array.isArray(symbols)) throw new TypeError('symbols must be an array');
  const ranked = [];
  for (const symbol of symbols) {
    const candles = candlesBySymbol[symbol];
    if (!candles) continue;
    const scored = scorePastOnly(candles, asOf);
    if (!scored || scored.score < minScore) continue;
    ranked.push({ market, symbol, asOf, ...scored });
  }
  ranked.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  return ranked.slice(0, topK).map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function initialStop({ past, entry, atrMult, structureLookback, minStopPct, maxStopPct }) {
  const a = atr(past, 14);
  const atrStop = a > 0 ? entry - (a * atrMult) : entry * (1 - maxStopPct);
  const structureLow = Math.min(...past.slice(-structureLookback).map((c) => c.low));
  let stop = Math.max(atrStop, structureLow);
  stop = Math.min(stop, entry * (1 - minStopPct));
  stop = Math.max(stop, entry * (1 - maxStopPct));
  if (!(stop > 0 && stop < entry)) stop = entry * (1 - maxStopPct);
  return { stop, atr: a, structureLow };
}

function roundTripCostRate({ feeBps = 0, slippageBps = 0, spreadBps = 0 } = {}) {
  return ((feeBps * 2) + (slippageBps * 2) + spreadBps) / 10_000;
}

export function evaluateForward({
  candles,
  discoveredAt,
  maxBars = 120,
  atrStopMult = 1.2,
  structureLookback = 10,
  minStopPct = 0.003,
  maxStopPct = 0.025,
  breakEvenAtR = 1.0,
  trailActivateAtR = 2.0,
  trailAtrMult = 2.0,
  sameBarPolicy = 'STOP_FIRST',
  costs = {},
}) {
  validateCandles(candles);
  if (!['STOP_FIRST'].includes(sameBarPolicy)) throw new RangeError('unsupported sameBarPolicy');
  const past = candlesAtOrBefore(candles, discoveredAt);
  if (past.length < Math.max(30, structureLookback)) throw new RangeError('insufficient past-only candles');
  const discoveryIndex = past.length - 1;
  const entryIndex = discoveryIndex + 1;
  if (entryIndex >= candles.length) throw new RangeError('no next-bar entry available');

  const entryBar = candles[entryIndex];
  const entry = entryBar.open;
  const init = initialStop({ past, entry, atrMult: atrStopMult, structureLookback, minStopPct, maxStopPct });
  const initialRisk = entry - init.stop;
  if (!(initialRisk > 0)) throw new RangeError('invalid initial risk');

  let stop = init.stop;
  let highest = entry;
  let mfe = 0;
  let mae = 0;
  let maxR = 0;
  let exitPrice = null;
  let exitTs = null;
  let exitReason = null;
  let ambiguousBars = 0;
  const targetHitTs = { pct3: null, pct5: null, pct10: null };
  const stopHistory = [{ ts: entryBar.ts, stop, reason: 'INITIAL' }];
  const endIndex = Math.min(candles.length - 1, entryIndex + maxBars - 1);

  for (let i = entryIndex; i <= endIndex; i += 1) {
    const bar = candles[i];
    const stopAtBarOpen = stop;

    if (bar.low <= stopAtBarOpen) {
      if (bar.high >= entry * 1.03) ambiguousBars += 1;
      exitPrice = Math.min(bar.open, stopAtBarOpen);
      exitTs = bar.ts;
      exitReason = stopAtBarOpen > init.stop ? 'TRAIL_STOP' : 'INITIAL_STOP';
      mae = Math.min(mae, pct(entry, exitPrice));
      break;
    }

    highest = Math.max(highest, bar.high);
    mfe = Math.max(mfe, pct(entry, bar.high));
    mae = Math.min(mae, pct(entry, bar.low));
    maxR = Math.max(maxR, (bar.high - entry) / initialRisk);
    if (targetHitTs.pct3 === null && bar.high >= entry * 1.03) targetHitTs.pct3 = bar.ts;
    if (targetHitTs.pct5 === null && bar.high >= entry * 1.05) targetHitTs.pct5 = bar.ts;
    if (targetHitTs.pct10 === null && bar.high >= entry * 1.10) targetHitTs.pct10 = bar.ts;

    const currentR = (highest - entry) / initialRisk;
    let nextStop = stop;
    let reason = null;
    if (currentR >= breakEvenAtR) {
      const breakeven = entry;
      if (breakeven > nextStop) {
        nextStop = breakeven;
        reason = 'BREAKEVEN';
      }
    }
    if (currentR >= trailActivateAtR) {
      const seen = candles.slice(0, i + 1);
      const rollingAtr = atr(seen, 14) || init.atr;
      const trail = highest - (rollingAtr * trailAtrMult);
      if (trail > nextStop) {
        nextStop = trail;
        reason = 'ATR_TRAIL';
      }
    }
    nextStop = Math.min(nextStop, bar.close * 0.999999);
    if (nextStop > stop) {
      stop = nextStop;
      stopHistory.push({ ts: bar.ts, stop, reason });
    }
  }

  if (exitPrice === null) {
    const lastBar = candles[endIndex];
    exitPrice = lastBar.close;
    exitTs = lastBar.ts;
    exitReason = 'TIME_EXIT';
  }

  const grossReturn = pct(entry, exitPrice);
  const costRate = roundTripCostRate(costs);
  const netReturn = grossReturn - costRate;
  const netR = netReturn / (initialRisk / entry);
  return {
    discoveredAt,
    entryTs: entryBar.ts,
    entry,
    initialStop: init.stop,
    initialRiskPct: initialRisk / entry,
    structureLow: init.structureLow,
    discoveryAtr: init.atr,
    exitTs,
    exitPrice,
    exitReason,
    grossReturn,
    netReturn,
    netR,
    mfe,
    mae,
    maxR,
    targetHitTs,
    finalStop: stop,
    stopHistory,
    ambiguousBars,
    sameBarPolicy,
    barsObserved: Math.max(1, candles.findIndex((c) => c.ts === exitTs) - entryIndex + 1),
  };
}

export function summarizeTrials(trials) {
  const settled = trials.filter((t) => Number.isFinite(t.netReturn));
  const n = settled.length;
  if (!n) return { n: 0, winRate: 0, avgNetReturn: 0, avgNetR: 0, profitFactor: 0, maxDrawdown: 0 };
  const wins = settled.filter((t) => t.netReturn > 0);
  const grossProfit = wins.reduce((s, t) => s + t.netReturn, 0);
  const grossLoss = -settled.filter((t) => t.netReturn < 0).reduce((s, t) => s + t.netReturn, 0);
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const t of settled) {
    equity *= 1 + t.netReturn;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - (equity / peak));
  }
  return {
    n,
    winRate: wins.length / n,
    avgNetReturn: mean(settled.map((t) => t.netReturn)),
    avgNetR: mean(settled.map((t) => t.netR)),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    maxDrawdown,
    pct3HitRate: settled.filter((t) => t.targetHitTs?.pct3 !== null).length / n,
    pct5HitRate: settled.filter((t) => t.targetHitTs?.pct5 !== null).length / n,
    pct10HitRate: settled.filter((t) => t.targetHitTs?.pct10 !== null).length / n,
    avgMfe: mean(settled.map((t) => t.mfe)),
    avgMae: mean(settled.map((t) => t.mae)),
  };
}

export function recallAtK({ discoveredSymbols, realizedMoverSymbols }) {
  const discovered = new Set(discoveredSymbols);
  const realized = new Set(realizedMoverSymbols);
  let captured = 0;
  for (const symbol of realized) if (discovered.has(symbol)) captured += 1;
  return { captured, totalMovers: realized.size, recall: realized.size ? captured / realized.size : 0 };
}

function addUtcMonths(ts, months) {
  const d = new Date(ts);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}

export function buildWalkForwardWindows({
  startTs,
  endTs,
  trainMonths = 12,
  validationMonths = 3,
  testMonths = 3,
  stepMonths = 3,
  purgeDays = 2,
}) {
  const day = 86_400_000;
  const purge = purgeDays * day;
  const out = [];
  for (let trainStart = startTs; ; trainStart = addUtcMonths(trainStart, stepMonths)) {
    const trainEnd = addUtcMonths(trainStart, trainMonths) - 1;
    const validationStart = trainEnd + 1 + purge;
    const validationEnd = addUtcMonths(validationStart, validationMonths) - 1;
    const testStart = validationEnd + 1 + purge;
    const testEnd = addUtcMonths(testStart, testMonths) - 1;
    if (testEnd > endTs) break;
    out.push({ trainStart, trainEnd, validationStart, validationEnd, testStart, testEnd });
  }
  return out;
}
