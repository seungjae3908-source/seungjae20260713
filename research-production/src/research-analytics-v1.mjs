// Research analytics that sit on top of the combination search and the
// forward paper ledger. Pure functions (plus one append-only experiment log);
// nothing here selects or tunes rules, places orders or calls an AI provider.
//
//  * Monte Carlo of the trade sequence: drawdown / ruin distribution instead of
//    the single path that happened (essential at 5x futures leverage).
//  * Market regime tags (bull / bear / sideways) and performance per regime,
//    so a long rule that only worked in a bull market is visible as such.
//  * Rolling selection walk-forward: re-runs the SELECTION PROCESS window by
//    window (pick the best rule on past windows, score it on the next one).
//  * Portfolio check across rules: daily R correlation, concurrent positions,
//    combined drawdown.
//  * Grid and DCA simulators that always report the tail loss.
//  * Reproducibility record: one line per experiment with every input digest.

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DAY = 86_400_000;

function round(value, digits = 6) {
  return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position); const high = Math.ceil(position);
  return sorted[low] + ((sorted[high] - sorted[low]) * (position - low));
}

function seededRandom(seed) {
  let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

// ---------- Monte Carlo ----------

/**
 * Bootstrap (with replacement) of per-trade equity returns. Returns the
 * distribution of final return and maximum drawdown, and the probability of
 * losing `ruinDrawdown` of equity at some point.
 */
export function monteCarloTradeSequenceV1(returns, { paths = 2_000, tradesPerPath = null, seed = 7, ruinDrawdown = 0.5 } = {}) {
  const sample = (returns ?? []).filter(Number.isFinite);
  if (sample.length < 5) return Object.freeze({ paths: 0, reason: 'TOO_FEW_TRADES', trades: sample.length });
  const n = tradesPerPath ?? sample.length;
  const random = seededRandom(seed);
  const finals = []; const drawdowns = []; let ruined = 0;
  for (let p = 0; p < paths; p += 1) {
    let equity = 1; let peak = 1; let worst = 0; let ruin = false;
    for (let k = 0; k < n; k += 1) {
      const r = sample[Math.floor(random() * sample.length)];
      equity *= Math.max(0, 1 + r);
      peak = Math.max(peak, equity);
      const dd = peak > 0 ? 1 - (equity / peak) : 1;
      worst = Math.max(worst, dd);
      if (dd >= ruinDrawdown) ruin = true;
    }
    finals.push(equity - 1); drawdowns.push(worst); if (ruin) ruined += 1;
  }
  finals.sort((a, b) => a - b); drawdowns.sort((a, b) => a - b);
  return Object.freeze({
    paths, tradesPerPath: n, sourceTrades: sample.length,
    finalReturn: { p05: round(quantile(finals, 0.05)), p50: round(quantile(finals, 0.5)), p95: round(quantile(finals, 0.95)) },
    maxDrawdown: { p50: round(quantile(drawdowns, 0.5)), p95: round(quantile(drawdowns, 0.95)), p99: round(quantile(drawdowns, 0.99)) },
    probabilityOfLoss: round(finals.filter((value) => value < 0).length / paths, 4),
    ruinDrawdown, probabilityOfRuin: round(ruined / paths, 4),
  });
}

// ---------- regimes ----------

/**
 * Regime per candle from closed data only: BULL when close > SMA200 and the
 * SMA200 rose over the last 20 bars, BEAR when both are down, else SIDEWAYS.
 * null during warm-up.
 */
export function regimeSeriesV1(candles, { period = 200, slopeBars = 20 } = {}) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  const sma = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) sma[i] = sum / period;
  }
  for (let i = 0; i < n; i += 1) {
    if (sma[i] == null || i < slopeBars || sma[i - slopeBars] == null) continue;
    const up = sma[i] > sma[i - slopeBars]; const above = candles[i].close > sma[i];
    out[i] = above && up ? 'BULL' : !above && !up ? 'BEAR' : 'SIDEWAYS';
  }
  return out;
}

/** Groups trade returns by the regime at each trade's signal time. */
export function performanceByRegimeV1(trades, candles, regimes) {
  const index = new Map(candles.map((row, i) => [row.timestamp, i]));
  const groups = { BULL: [], BEAR: [], SIDEWAYS: [], UNKNOWN: [] };
  for (const trade of trades) {
    const i = index.get(trade.signalTime);
    const regime = i == null ? null : regimes[i];
    groups[regime ?? 'UNKNOWN'].push(trade.return);
  }
  return Object.freeze(Object.fromEntries(Object.entries(groups).map(([key, values]) => [key, {
    trades: values.length,
    meanReturn: values.length ? round(values.reduce((s, v) => s + v, 0) / values.length) : null,
    winRate: values.length ? round(values.filter((v) => v > 0).length / values.length, 4) : null,
  }])));
}

/** Regime-dependence verdict for one rule: profitable only in one regime? */
export function regimeDependenceV1(byRegime, { minimumTrades = 10 } = {}) {
  const usable = Object.entries(byRegime).filter(([key, row]) => key !== 'UNKNOWN' && row.trades >= minimumTrades);
  const positive = usable.filter(([, row]) => row.meanReturn > 0).map(([key]) => key);
  if (usable.length < 2) return 'INSUFFICIENT';
  if (positive.length === usable.length) return 'ALL_REGIMES';
  if (positive.length === 1) return `ONLY_${positive[0]}`;
  if (positive.length === 0) return 'NONE';
  return 'MIXED';
}

// ---------- rolling selection walk-forward ----------

/**
 * Scores the selection PROCESS out of sample: for each window k >= 1, pick the
 * trial with the best pooled mean over windows < k (minimum trades), then
 * record that trial's result in window k. A process that only works in hind-
 * sight shows a negative or near-zero out-of-sample mean here.
 */
export function rollingSelectionWalkForwardV1(trials, { minimumTrades = 20 } = {}) {
  // Every trial with window data takes part. A trial's REJECT status was decided with the whole
  // sample (including windows later than k), so excluding it here would let hindsight shape the
  // choice at window k and make the out-of-sample score look better than the real process.
  const rows = Object.values(trials ?? {}).filter((row) => Array.isArray(row.walkForward?.windows));
  const windows = rows.length ? Math.min(...rows.map((row) => row.walkForward.windows.length)) : 0;
  const folds = [];
  for (let k = 1; k < windows; k += 1) {
    let best = null; let bestMean = -Infinity;
    for (const row of rows) {
      let trades = 0; let total = 0;
      for (let j = 0; j < k; j += 1) { trades += row.walkForward.windows[j].trades; total += row.walkForward.windows[j].trades * row.walkForward.windows[j].meanReturn; }
      if (trades < minimumTrades) continue;
      const mean = total / trades;
      if (mean > bestMean || (mean === bestMean && best && row.trialId < best.trialId)) { best = row; bestMean = mean; }
    }
    if (!best) { folds.push({ window: k, trialId: null }); continue; }
    const next = best.walkForward.windows[k];
    folds.push({ window: k, trialId: best.trialId, inSampleMean: round(bestMean), outOfSampleTrades: next.trades, outOfSampleMean: round(next.meanReturn) });
  }
  const scored = folds.filter((row) => row.trialId && row.outOfSampleTrades > 0);
  const oosTrades = scored.reduce((s, row) => s + row.outOfSampleTrades, 0);
  const oosMean = oosTrades ? scored.reduce((s, row) => s + (row.outOfSampleTrades * row.outOfSampleMean), 0) / oosTrades : null;
  return Object.freeze({ folds, outOfSampleTrades: oosTrades, outOfSampleMean: round(oosMean),
    verdict: oosMean == null ? 'INSUFFICIENT' : oosMean > 0 ? 'SELECTION_HOLDS_OUT_OF_SAMPLE' : 'SELECTION_FAILS_OUT_OF_SAMPLE' });
}

// ---------- portfolio ----------

function pearson(a, b) {
  const n = a.length;
  if (n < 5) return null;
  const ma = a.reduce((s, v) => s + v, 0) / n; const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i += 1) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}

/** Cross-rule risk from closed forward paper trades (R multiples). */
export function portfolioRiskV1(trades, { maxPairs = 40 } = {}) {
  const closed = (trades ?? []).filter((row) => row.status === 'CLOSED' && Number.isFinite(row.rMultiple) && Number.isFinite(row.exitTime));
  if (closed.length === 0) return Object.freeze({ trades: 0, rules: 0, reason: 'NO_CLOSED_TRADES' });
  const days = [...new Set(closed.map((row) => Math.floor(row.exitTime / DAY)))].sort((a, b) => a - b);
  const rules = [...new Set(closed.map((row) => row.ruleId))].sort();
  const daily = new Map(rules.map((rule) => [rule, new Map()]));
  for (const row of closed) {
    const day = Math.floor(row.exitTime / DAY);
    daily.get(row.ruleId).set(day, (daily.get(row.ruleId).get(day) ?? 0) + row.rMultiple);
  }
  const series = Object.fromEntries(rules.map((rule) => [rule, days.map((day) => daily.get(rule).get(day) ?? 0)]));
  const pairs = [];
  for (let i = 0; i < rules.length; i += 1) for (let j = i + 1; j < rules.length; j += 1) {
    const value = pearson(series[rules[i]], series[rules[j]]);
    if (value != null) pairs.push({ a: rules[i], b: rules[j], correlation: round(value, 4) });
  }
  pairs.sort((x, y) => Math.abs(y.correlation) - Math.abs(x.correlation));
  // Concurrent open positions (entry..exit intervals).
  const events = [];
  for (const row of (trades ?? [])) {
    if (!Number.isFinite(row.entryTime)) continue;
    events.push([row.entryTime, 1]);
    events.push([Number.isFinite(row.exitTime) ? row.exitTime : Number.MAX_SAFE_INTEGER, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0; let maxConcurrent = 0;
  for (const [, delta] of events) { open += delta; maxConcurrent = Math.max(maxConcurrent, open); }
  let cumulative = 0; let peak = 0; let maxDrawdownR = 0;
  for (const day of days) {
    cumulative += rules.reduce((s, rule) => s + (daily.get(rule).get(day) ?? 0), 0);
    peak = Math.max(peak, cumulative);
    maxDrawdownR = Math.max(maxDrawdownR, peak - cumulative);
  }
  const avgAbsCorrelation = pairs.length ? pairs.reduce((s, row) => s + Math.abs(row.correlation), 0) / pairs.length : null;
  return Object.freeze({
    trades: closed.length, rules: rules.length, days: days.length,
    totalR: round(cumulative, 4), maxDrawdownR: round(maxDrawdownR, 4), maxConcurrentPositions: maxConcurrent,
    averageAbsoluteCorrelation: round(avgAbsCorrelation, 4),
    mostCorrelated: pairs.slice(0, maxPairs),
    concentrationWarning: avgAbsCorrelation != null && avgAbsCorrelation > 0.5,
  });
}

// ---------- grid and DCA simulators ----------

/**
 * Long-only spot grid: `levels` buy orders evenly spaced between lower and
 * upper; each filled buy sells one step higher. Inventory left when price
 * falls below the grid is the tail risk and is always reported.
 */
export function simulateGridV1(candles, { lower, upper, levels = 10, capital = 1_000_000, feeRate = 0.0005 } = {}) {
  if (!(upper > lower && lower > 0) || !Number.isInteger(levels) || levels < 2) throw new Error('GRID_PARAMETERS_INVALID');
  const step = (upper - lower) / levels;
  const perLevel = capital / levels;
  const grid = Array.from({ length: levels }, (_, i) => ({ buy: lower + (i * step), sell: lower + ((i + 1) * step), quantity: 0 }));
  let cash = capital; let realized = 0; let fees = 0; let completedRounds = 0;
  let worstEquity = capital; let peakEquity = capital; let maxDrawdown = 0;
  for (const candle of candles) {
    for (const level of grid) {
      // Conservative intrabar order: buys at lows fill before sells at highs.
      if (level.quantity === 0 && candle.low <= level.buy && cash >= perLevel) {
        const fee = perLevel * feeRate;
        level.quantity = (perLevel - fee) / level.buy; cash -= perLevel; fees += fee;
      }
    }
    for (const level of grid) {
      if (level.quantity > 0 && candle.high >= level.sell && candle.high > level.buy) {
        const gross = level.quantity * level.sell; const fee = gross * feeRate;
        cash += gross - fee; fees += fee; realized += gross - fee - perLevel; level.quantity = 0; completedRounds += 1;
      }
    }
    const inventory = grid.reduce((s, level) => s + level.quantity, 0);
    const equity = cash + (inventory * candle.close);
    worstEquity = Math.min(worstEquity, equity);
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - (equity / peakEquity));
  }
  const last = candles.at(-1);
  const inventory = grid.reduce((s, level) => s + level.quantity, 0);
  const finalEquity = cash + (inventory * (last?.close ?? 0));
  return Object.freeze({
    kind: 'GRID', levels, lower, upper, completedRounds,
    realizedProfit: round(realized, 2), fees: round(fees, 2),
    finalReturn: round((finalEquity / capital) - 1),
    maxDrawdown: round(maxDrawdown), worstEquityReturn: round((worstEquity / capital) - 1),
    stuckInventoryValue: round(inventory * (last?.close ?? 0), 2),
    tailRiskNote: 'PRICE_BELOW_GRID_LEAVES_FULL_INVENTORY_AT_A_LOSS',
  });
}

/**
 * Classic DCA with safety orders: buy `baseOrder`, add `safetyOrder` each time
 * price falls `deviation` below the last buy (up to `maxSafetyOrders`), exit
 * everything at `takeProfit` above the average price. Reports the worst
 * unrealized loss and how long capital sat underwater.
 */
export function simulateDcaV1(candles, { baseOrder = 100_000, safetyOrder = 100_000, maxSafetyOrders = 5, deviation = 0.03, takeProfit = 0.02, feeRate = 0.0005 } = {}) {
  let quantity = 0; let invested = 0; let lastBuy = null; let safetyUsed = 0;
  let realized = 0; let cycles = 0; let worstUnrealized = 0; let maxInvested = 0; let underwaterBars = 0; let longestUnderwater = 0;
  const buy = (price, amount) => { const fee = amount * feeRate; quantity += (amount - fee) / price; invested += amount; lastBuy = price; maxInvested = Math.max(maxInvested, invested); };
  for (const candle of candles) {
    if (quantity === 0) { buy(candle.open, baseOrder); safetyUsed = 0; }
    while (safetyUsed < maxSafetyOrders && candle.low <= lastBuy * (1 - deviation)) { buy(lastBuy * (1 - deviation), safetyOrder); safetyUsed += 1; }
    const average = invested / quantity;
    const target = average * (1 + takeProfit);
    if (candle.high >= target) {
      const gross = quantity * target; const fee = gross * feeRate;
      realized += gross - fee - invested; cycles += 1; quantity = 0; invested = 0; lastBuy = null; underwaterBars = 0;
      continue;
    }
    const unrealized = (quantity * candle.close) - invested;
    worstUnrealized = Math.min(worstUnrealized, unrealized);
    if (unrealized < 0) { underwaterBars += 1; longestUnderwater = Math.max(longestUnderwater, underwaterBars); } else underwaterBars = 0;
  }
  const last = candles.at(-1);
  const openUnrealized = quantity > 0 ? (quantity * (last?.close ?? 0)) - invested : 0;
  return Object.freeze({
    kind: 'DCA', cycles, realizedProfit: round(realized, 2), openUnrealized: round(openUnrealized, 2),
    maxCapitalCommitted: round(maxInvested, 2),
    worstUnrealizedLoss: round(worstUnrealized, 2),
    worstUnrealizedLossOfCommitted: maxInvested > 0 ? round(worstUnrealized / maxInvested) : null,
    longestUnderwaterBars: longestUnderwater,
    tailRiskNote: 'SAFETY_ORDERS_EXHAUSTED_IN_A_TREND_DOWN_HOLD_FULL_LOSS',
  });
}

// ---------- reproducibility ----------

export function experimentRecordV1({ laneId, experimentKey, researchCodeSha, atomLibraryVersion, symbolKey, policy, datasetDigests, observedAt }) {
  const policyDigest = createHash('sha256').update(JSON.stringify(policy ?? {})).digest('hex');
  const datasetDigest = createHash('sha256').update(JSON.stringify(Object.entries(datasetDigests ?? {}).sort())).digest('hex');
  return Object.freeze({
    contract: 'combination-experiment-record/v1', laneId, experimentKey, researchCodeSha: researchCodeSha ?? null,
    atomLibraryVersion, symbolKey, policyDigest, datasetDigest, datasetDigests: datasetDigests ?? {}, firstSeenAt: observedAt,
    rerun: `git checkout ${researchCodeSha ?? '<sha>'} && node research-production/bin/autonomous-research-coordinator-v2.mjs (datasets verified by sha256)`,
  });
}

/** Appends a record once per experimentKey (append-only JSONL). */
export async function appendExperimentRecordV1(stateRoot, record) {
  const path = join(stateRoot, 'combination-research', 'experiments.jsonl');
  let existing = '';
  try { existing = await readFile(path, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (existing.includes(`"experimentKey":"${record.experimentKey}"`)) return false;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return true;
}
