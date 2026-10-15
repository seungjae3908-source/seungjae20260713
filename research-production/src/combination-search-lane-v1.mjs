// Deterministic (no-AI) combination research lane.
//
// Every tick it tests more combinations of atoms (formula + formula,
// formula + wave, formula + chart pattern, candle + trend, ...) on several
// symbols per market lane with the canonical independent backtester
// (closed candle signal, next-open entry, costs, ATR stop/target/time exit).
//
// Overfitting guards:
//  * every trial is counted (no silent retries) and persisted;
//  * selection uses the DISCOVERY window only; the later VALIDATION window is
//    out-of-sample for each trial;
//  * Benjamini-Hochberg false-discovery control over ALL trials of a lane;
//  * cross-symbol breadth and 4-window walk-forward consistency;
//  * data are capped before 2026-01-01 — the 2026 holdout stays sealed.
// Research only: no paper activation, no orders, executionAuthority NONE.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { runIndependentSignalBacktest } from '../../market-prediction-lab/src/independent-strategy-backtest.js';
import { collectUpbitSpotHistory } from '../../market-prediction-lab/src/upbit-spot-history.js';
import { collectBitgetCandles } from '../../market-prediction-lab/src/bitget-candle-collector.js';
import { BitgetPublicClient } from '../../market-prediction-lab/src/bitget-public-client.js';
import { collectYahooStockHistory } from '../../market-prediction-lab/src/yahoo-stock-history.js';
import { RESEARCH_LANES_V2 } from './autonomous-research-discovery-v2.mjs';
import {
  ATOM_FAMILIES,
  COMBINATION_ATOM_LIBRARY_VERSION,
  atomsForDirectionV1,
  combinationAtomV1,
  computeCombinationAtomsV1,
} from './combination-atoms-v1.mjs';

export const COMBINATION_SEARCH_CONTRACT_V1 = 'combination-search-lane/v1';
const HOLDOUT_START = Date.UTC(2026, 0, 1);
const DAY = 24 * 3_600_000;

// Five symbols per data source. Long-lived liquid names/ETFs, chosen before
// seeing any result; the list is part of the trial identity.
export const COMBINATION_UNIVERSE_V1 = Object.freeze({
  UPBIT_1H: Object.freeze({ timeframe: '1h', lookbackDays: 540, symbols: Object.freeze(['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE']) }),
  BITGET_1H: Object.freeze({ timeframe: '1h', lookbackDays: 540, symbols: Object.freeze(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT']) }),
  YAHOO_KR_1D: Object.freeze({ timeframe: '1d', lookbackDays: 5 * 365, symbols: Object.freeze(['069500', '229200', '005930', '000660', '035420']) }),
  YAHOO_US_1D: Object.freeze({ timeframe: '1d', lookbackDays: 5 * 365, symbols: Object.freeze(['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT']) }),
});

const LANE_DATA_SOURCE = Object.freeze({
  CRYPTO_SPOT_LONG: 'UPBIT_1H',
  CRYPTO_FUTURES_LONG: 'BITGET_1H',
  CRYPTO_FUTURES_SHORT: 'BITGET_1H',
  KR_STOCK_LONG: 'YAHOO_KR_1D',
  US_STOCK_LONG: 'YAHOO_US_1D',
});

// KR ETFs are exempt from the securities transaction tax; single stocks are not.
const KR_ETF = new Set(['069500', '229200']);
function symbolCost(lane, symbol) {
  if (lane.market === 'KR_STOCK' && !KR_ETF.has(symbol)) return { ...lane.cost, taxRate: 0.0015 };
  return { ...lane.cost };
}

export const COMBINATION_EXIT_PROFILES_V1 = Object.freeze([
  Object.freeze({ id: 'X1', stopAtrMultiple: 1.5, targetRiskMultiple: 2, timeBarsFactor: 1 }),
  Object.freeze({ id: 'X2', stopAtrMultiple: 2.5, targetRiskMultiple: 1.5, timeBarsFactor: 2 }),
]);

export const COMBINATION_POLICY_V1 = Object.freeze({
  discoveryFraction: 0.6,
  walkForwardWindows: 4,
  minimumDiscoveryTrades: 20,
  minimumValidationTrades: 20,
  minimumProfitFactor: 1.1,
  minimumSymbolBreadth: 0.6,
  minimumSymbols: 3,
  minimumPositiveWindows: 3,
  falseDiscoveryRate: 0.10,
  maximumTriplePairs: 15,
  maximumTrialsPerLane: 4_000,
});

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

function cleanCandles(rows) {
  return rows.map((row) => ({
    timestamp: Number(row.timestamp), open: Number(row.open), high: Number(row.high), low: Number(row.low),
    close: Number(row.close), volume: Number(row.volume ?? row.baseVolume ?? 0),
  })).filter((row) => Number.isSafeInteger(row.timestamp) && row.timestamp < HOLDOUT_START
    && [row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)
    && row.open > 0 && row.high >= row.low && row.low > 0 && row.volume >= 0
    && row.open <= row.high && row.open >= row.low && row.close <= row.high && row.close >= row.low)
    .sort((a, b) => a.timestamp - b.timestamp)
    .filter((row, index, all) => index === 0 || row.timestamp > all[index - 1].timestamp);
}

/** Public candles only, capped before the sealed 2026 holdout. */
export async function loadCombinationDatasetV1({ source, symbol, fetchImpl = globalThis.fetch }) {
  const spec = COMBINATION_UNIVERSE_V1[source];
  if (!spec || !spec.symbols.includes(symbol)) throw new Error('COMBINATION_DATASET_UNKNOWN');
  const endTime = HOLDOUT_START - 3_600_000;
  const startTime = endTime - (spec.lookbackDays * DAY);
  let rows;
  if (source === 'UPBIT_1H') {
    const history = await collectUpbitSpotHistory({ symbol: symbol.replace(/^KRW-/u, ''), timeframe: '60m', startTime, endTime,
      maxPages: 70, minIntervalMs: 150, fetchImpl });
    rows = history.candles;
  } else if (source === 'BITGET_1H') {
    const history = await collectBitgetCandles({ client: new BitgetPublicClient({ fetchImpl }), market: 'CRYPTO_FUTURES', symbol,
      timeframe: '1h', startTime, endTime, maxCandles: 14_000, productType: 'usdt-futures' });
    rows = history.candles;
  } else {
    const history = await collectYahooStockHistory({ market: source === 'YAHOO_KR_1D' ? 'KR_STOCK' : 'US_STOCK', symbol, startTime, endTime, fetchImpl });
    rows = history.candles;
  }
  const candles = cleanCandles(rows ?? []);
  const minimum = spec.timeframe === '1d' ? 500 : 2_000;
  if (candles.length < minimum) throw new Error(`COMBINATION_DATASET_INSUFFICIENT:${candles.length}`);
  return Object.freeze({ source, symbol, timeframe: spec.timeframe, candles });
}

// ---------- trial plan ----------

function trialId(laneId, atomIds, exitId) {
  return sha256([COMBINATION_ATOM_LIBRARY_VERSION, laneId, [...atomIds].sort(), exitId].join('|')).slice(0, 24);
}

/** Singles then cross-family pairs, deterministic order. */
export function planBaseTrialsV1(lane) {
  const atoms = atomsForDirectionV1(lane.direction);
  const directional = (ids) => ids.some((id) => combinationAtomV1(id).side !== 'BOTH');
  const combos = [];
  for (const atom of atoms) if (atom.side !== 'BOTH') combos.push([atom.id]);
  for (let a = 0; a < atoms.length; a += 1) {
    for (let b = a + 1; b < atoms.length; b += 1) {
      if (atoms[a].family === atoms[b].family) continue;
      const ids = [atoms[a].id, atoms[b].id];
      if (directional(ids)) combos.push(ids);
    }
  }
  const trials = [];
  for (const ids of combos) for (const exit of COMBINATION_EXIT_PROFILES_V1) {
    trials.push(Object.freeze({ trialId: trialId(lane.id, ids, exit.id), atoms: Object.freeze([...ids]), exitId: exit.id, stage: ids.length === 1 ? 'SINGLE' : 'PAIR' }));
  }
  return Object.freeze(trials);
}

/** Triples extend the best pairs chosen on DISCOVERY evidence only. */
export function planTripleTrialsV1(lane, trials, policy = COMBINATION_POLICY_V1) {
  const pairs = Object.values(trials).filter((row) => row.atoms.length === 2
    && row.discovery?.trades >= policy.minimumDiscoveryTrades * 1.5 && row.discovery.meanReturn > 0)
    .sort((a, b) => b.discovery.meanReturn - a.discovery.meanReturn || a.trialId.localeCompare(b.trialId))
    .slice(0, policy.maximumTriplePairs);
  const atoms = atomsForDirectionV1(lane.direction);
  const planned = [];
  const seen = new Set(Object.keys(trials));
  for (const pair of pairs) {
    const families = new Set(pair.atoms.map((id) => combinationAtomV1(id).family));
    for (const atom of atoms) {
      if (families.has(atom.family)) continue;
      const ids = [...pair.atoms, atom.id].sort();
      const id = trialId(lane.id, ids, pair.exitId);
      if (seen.has(id)) continue;
      seen.add(id);
      planned.push(Object.freeze({ trialId: id, atoms: Object.freeze(ids), exitId: pair.exitId, stage: 'TRIPLE' }));
    }
  }
  return Object.freeze(planned);
}

// ---------- statistics ----------

function stats(returns) {
  const n = returns.length;
  if (n === 0) return { trades: 0, meanReturn: 0, profitFactor: null, tStat: 0, winRate: 0, totalReturn: 0 };
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const variance = n > 1 ? returns.reduce((s, r) => s + ((r - mean) ** 2), 0) / (n - 1) : 0;
  const gains = returns.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const losses = -returns.filter((r) => r < 0).reduce((s, r) => s + r, 0);
  const tStat = variance > 0 ? mean / Math.sqrt(variance / n) : 0;
  return {
    trades: n,
    meanReturn: mean,
    profitFactor: losses > 0 ? gains / losses : (gains > 0 ? null : 0),
    tStat,
    winRate: returns.filter((r) => r > 0).length / n,
    totalReturn: returns.reduce((acc, r) => acc * (1 + r), 1) - 1,
  };
}

// One-sided p-value of mean > 0 using the normal approximation of t.
function normalUpperTail(z) {
  const t = 1 / (1 + (0.2316419 * Math.abs(z)));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? tail : 1 - tail;
}

function round(value, digits = 6) {
  return value == null || !Number.isFinite(value) ? value : Number(value.toFixed(digits));
}

function compact(s) {
  return { trades: s.trades, meanReturn: round(s.meanReturn), profitFactor: round(s.profitFactor, 4),
    tStat: round(s.tStat, 4), winRate: round(s.winRate, 4), totalReturn: round(s.totalReturn) };
}

/** Benjamini-Hochberg q-values over every trial of a lane. */
export function benjaminiHochbergV1(pValues) {
  const m = pValues.length;
  const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const q = new Array(m);
  let running = 1;
  for (let rank = m; rank >= 1; rank -= 1) {
    const { p, index } = order[rank - 1];
    running = Math.min(running, (p * m) / rank);
    q[index] = running;
  }
  return q;
}

// ---------- evaluation ----------

export function evaluateCombinationTrialV1({ lane, trial, datasets, policy = COMBINATION_POLICY_V1 }) {
  const exit = COMBINATION_EXIT_PROFILES_V1.find((row) => row.id === trial.exitId);
  if (!exit) throw new Error('COMBINATION_EXIT_UNKNOWN');
  const side = lane.direction === 'SHORT' ? 'short' : 'long';
  const discovery = []; const validation = [];
  const windows = Array.from({ length: policy.walkForwardWindows }, () => []);
  const perSymbol = [];
  for (const data of datasets) {
    const { candles, atoms, symbol, splitTime, windowEdges } = data;
    const arrays = trial.atoms.map((id) => atoms.get(id));
    const signalEvaluator = ({ index }) => (arrays.every((array) => array[index] === 1) ? { combination: trial.trialId } : null);
    const result = runIndependentSignalBacktest({
      backtestInput: {
        market: lane.market, side, symbol, timeframe: lane.timeframe, candles,
        initialCapital: lane.initialCapital, costModel: symbolCost(lane, symbol), riskModel: { riskPerTrade: 0.01, leverage: 1 },
      },
      strategy: 'combination_search_v1', strategyVersion: `COMBINATION:${trial.trialId}`,
      parameters: { atrPeriod: 14, stopAtrMultiple: exit.stopAtrMultiple, targetRiskMultiple: exit.targetRiskMultiple, timeBars: lane.timeBars * exit.timeBarsFactor },
      signalEvaluator,
      period: { startTime: candles[0].timestamp, endTime: candles.at(-1).timestamp },
    });
    const symbolValidation = [];
    for (const trade of result.trades) {
      if (!(trade.equityBefore > 0)) continue;
      const r = trade.netPnl / trade.equityBefore;
      if (trade.signalTime < splitTime) discovery.push(r);
      else { validation.push(r); symbolValidation.push(r); }
      let w = windowEdges.findIndex((edge) => trade.signalTime < edge);
      if (w < 0) w = windows.length - 1;
      windows[w].push(r);
    }
    const sv = stats(symbolValidation);
    perSymbol.push({ symbol, trades: result.trades.length, validationTrades: sv.trades, validationMeanReturn: round(sv.meanReturn) });
  }
  const d = stats(discovery); const v = stats(validation);
  const windowMeans = windows.map((rows) => stats(rows));
  const positiveWindows = windowMeans.filter((row) => row.trades > 0 && row.meanReturn > 0).length;
  const traded = perSymbol.filter((row) => row.validationTrades > 0);
  const breadth = traded.length === 0 ? 0 : traded.filter((row) => row.validationMeanReturn > 0).length / traded.length;
  let status = 'WATCH';
  let reason = null;
  if (d.trades < policy.minimumDiscoveryTrades) { status = 'REJECT'; reason = 'INSUFFICIENT_DISCOVERY_TRADES'; }
  else if (!(d.meanReturn > 0)) { status = 'REJECT'; reason = 'DISCOVERY_NOT_POSITIVE'; }
  else if (v.trades < policy.minimumValidationTrades) { status = 'REJECT'; reason = 'INSUFFICIENT_VALIDATION_TRADES'; }
  else if (!(v.meanReturn > 0)) { status = 'REJECT'; reason = 'VALIDATION_NOT_POSITIVE'; }
  // Rejected trials still count in the FDR denominator, with p = 1.
  const pValue = status === 'REJECT' ? 1 : normalUpperTail(v.tStat);
  return Object.freeze({
    trialId: trial.trialId, atoms: trial.atoms, exitId: trial.exitId, stage: trial.stage,
    status, reason, pValue: round(pValue, 8),
    discovery: compact(d), validation: compact(v),
    walkForward: { windows: windowMeans.map((row) => ({ trades: row.trades, meanReturn: round(row.meanReturn) })), positiveWindows },
    symbolBreadth: round(breadth, 4), symbols: perSymbol,
  });
}

/** Final classification needs the lane-wide FDR, so it runs over all trials. */
export function classifyLaneTrialsV1(trials, { symbolCount, baselines = {}, policy = COMBINATION_POLICY_V1 } = {}) {
  const rows = Object.values(trials);
  const q = benjaminiHochbergV1(rows.map((row) => row.pValue ?? 1));
  const out = rows.map((row, index) => {
    if (row.status === 'REJECT') return { ...row, qValue: round(q[index], 6), finalStatus: 'REJECT' };
    const survivor = q[index] <= policy.falseDiscoveryRate
      && (row.validation.profitFactor == null || row.validation.profitFactor >= policy.minimumProfitFactor)
      && row.symbolBreadth >= policy.minimumSymbolBreadth
      && symbolCount >= policy.minimumSymbols
      && row.walkForward.positiveWindows >= policy.minimumPositiveWindows;
    // Must beat simply being in the market (same exits, enter whenever flat).
    // Without this, a bull-market period makes almost any long entry look good.
    const baseline = baselines[row.exitId]?.validation?.meanReturn;
    const beatsBaseline = Number.isFinite(baseline) && row.validation.meanReturn > baseline;
    return { ...row, qValue: round(q[index], 6), baselineValidationMean: Number.isFinite(baseline) ? baseline : null,
      beatsBaseline, finalStatus: survivor && beatsBaseline ? 'SURVIVOR' : 'WATCH' };
  });
  return out;
}

// ---------- lane runner ----------

function splitEdges(candles, policy) {
  const first = candles[0].timestamp; const last = candles.at(-1).timestamp;
  const span = last - first;
  const splitTime = first + Math.floor(span * policy.discoveryFraction);
  const windowEdges = Array.from({ length: policy.walkForwardWindows - 1 }, (_, k) => first + Math.floor((span * (k + 1)) / policy.walkForwardWindows));
  return { splitTime, windowEdges };
}

async function loadSourceDatasets({ root, source, fetchImpl, loader, observedAtMs, fetchBudget, log }) {
  const spec = COMBINATION_UNIVERSE_V1[source];
  const ready = [];
  for (const symbol of spec.symbols) {
    const path = join(root, 'combination-research', 'datasets', source, `${symbol}.json`);
    let cached = await readJson(path);
    const failurePath = join(root, 'combination-research', 'datasets', source, `${symbol}.failure.json`);
    if (!cached?.candles?.length) {
      const failure = await readJson(failurePath);
      if (Number(failure?.retryAfter) > observedAtMs) { log.push(`${source}:${symbol}:RETRY_LATER`); continue; }
      if (fetchBudget.remaining <= 0) { log.push(`${source}:${symbol}:FETCH_BUDGET_NEXT_TICK`); continue; }
      fetchBudget.remaining -= 1;
      try {
        const data = await loader({ source, symbol, fetchImpl });
        cached = { contract: 'combination-dataset/v1', source, symbol, timeframe: data.timeframe, fetchedAt: observedAtMs, candles: data.candles };
        await atomicJson(path, cached);
        log.push(`${source}:${symbol}:FETCHED:${data.candles.length}`);
      } catch (error) {
        const reason = String(error?.message ?? error).slice(0, 160);
        await atomicJson(failurePath, { reason, retryAfter: observedAtMs + 3_600_000 });
        log.push(`${source}:${symbol}:FAILED:${reason}`);
        continue;
      }
    }
    // Defence in depth: never let a cached/injected 2026 candle into selection.
    const candles = cached.candles.filter((row) => row.timestamp < HOLDOUT_START);
    if (candles.length < 300) { log.push(`${source}:${symbol}:TOO_FEW_CANDLES:${candles.length}`); continue; }
    ready.push({ symbol, timeframe: cached.timeframe, candles });
  }
  return ready;
}

function laneSummary(lane, classified, planned, symbols, policy, baselines = {}) {
  const count = (status) => classified.filter((row) => row.finalStatus === status).length;
  const top = classified.filter((row) => row.finalStatus !== 'REJECT')
    .sort((a, b) => (a.qValue - b.qValue) || (b.validation.meanReturn - a.validation.meanReturn))
    .slice(0, 10)
    .map((row) => ({
      trialId: row.trialId, finalStatus: row.finalStatus, atoms: row.atoms,
      labels: row.atoms.map((id) => combinationAtomV1(id).label), families: row.atoms.map((id) => combinationAtomV1(id).family),
      exitId: row.exitId, qValue: row.qValue, validation: row.validation, discovery: row.discovery,
      positiveWindows: row.walkForward.positiveWindows, symbolBreadth: row.symbolBreadth,
      baselineValidationMean: row.baselineValidationMean, beatsBaseline: row.beatsBaseline,
    }));
  const evaluated = classified.length;
  return Object.freeze({
    laneId: lane.id, market: lane.market, direction: lane.direction, timeframe: lane.timeframe,
    symbols, trialsEvaluated: evaluated, trialsPlanned: planned,
    survivors: count('SURVIVOR'), watch: count('WATCH'), rejected: count('REJECT'),
    searchExhausted: evaluated >= Math.min(planned, policy.maximumTrialsPerLane),
    baselines: Object.fromEntries(Object.entries(baselines).map(([exitId, row]) => [exitId, { validation: row.validation, discovery: row.discovery }])),
    top,
  });
}

/**
 * Runs one bounded tick. `deadlineMs` is a wall-clock budget so the systemd
 * oneshot never exceeds its timeout; unfinished trials continue next tick.
 */
export async function runCombinationSearchLaneV1({
  stateRoot,
  researchCodeSha = null,
  now = () => new Date().toISOString(),
  clock = () => Date.now(),
  budgetMs = 240_000,
  maximumFetchesPerTick = 4,
  fetchImpl = globalThis.fetch,
  datasetLoader = loadCombinationDatasetV1,
  lanes = RESEARCH_LANES_V2,
  policy = COMBINATION_POLICY_V1,
} = {}) {
  const root = resolve(String(stateRoot ?? ''));
  if (!stateRoot) throw new Error('COMBINATION_STATE_ROOT_REQUIRED');
  const observedAt = now();
  const observedAtMs = Date.parse(observedAt);
  const started = clock();
  const deadline = started + budgetMs;
  const fetchBudget = { remaining: maximumFetchesPerTick };
  const log = [];
  const sourceCache = new Map();
  const summaries = [];
  let evaluatedThisTick = 0;
  const cursorPath = join(root, 'combination-research', 'cursor.json');
  const cursor = Number((await readJson(cursorPath))?.next ?? 0) % Math.max(lanes.length, 1);
  const ordered = lanes.map((_, k) => lanes[(cursor + k) % lanes.length]);

  for (const lane of ordered) {
    const source = LANE_DATA_SOURCE[lane.id];
    if (!source) continue;
    if (!sourceCache.has(source)) {
      const raw = await loadSourceDatasets({ root, source, fetchImpl, loader: datasetLoader, observedAtMs, fetchBudget, log });
      sourceCache.set(source, raw.map((data) => {
        const { splitTime, windowEdges } = splitEdges(data.candles, policy);
        return { ...data, atoms: computeCombinationAtomsV1(data.candles, { timeframe: data.timeframe }), splitTime, windowEdges };
      }));
    }
    const datasets = sourceCache.get(source);
    const statePath = join(root, 'combination-research', 'lanes', lane.id, 'state.json');
    const prior = await readJson(statePath);
    const symbolKey = datasets.map((row) => row.symbol).join(',');
    // A different atom library or symbol set is a different experiment.
    const fresh = prior?.atomLibraryVersion !== COMBINATION_ATOM_LIBRARY_VERSION || prior?.symbolKey !== symbolKey;
    const trials = fresh ? {} : { ...(prior?.trials ?? {}) };
    if (datasets.length < policy.minimumSymbols) {
      summaries.push({ laneId: lane.id, status: 'WAITING_FOR_DATA', symbols: datasets.map((row) => row.symbol) });
      continue;
    }
    // Market baseline per exit profile: no condition, enter whenever flat.
    const baselines = fresh ? {} : { ...(prior?.baselines ?? {}) };
    for (const exit of COMBINATION_EXIT_PROFILES_V1) {
      if (baselines[exit.id]) continue;
      baselines[exit.id] = evaluateCombinationTrialV1({ lane, trial: { trialId: `baseline-${exit.id}`, atoms: [], exitId: exit.id, stage: 'BASELINE' }, datasets, policy });
    }
    const base = planBaseTrialsV1(lane);
    let pending = base.filter((trial) => !trials[trial.trialId]);
    let stage = 'BASE';
    if (pending.length === 0) {
      pending = planTripleTrialsV1(lane, trials, policy).filter((trial) => !trials[trial.trialId]);
      stage = 'TRIPLE';
    }
    for (const trial of pending) {
      if (clock() >= deadline || Object.keys(trials).length >= policy.maximumTrialsPerLane) break;
      trials[trial.trialId] = evaluateCombinationTrialV1({ lane, trial, datasets, policy });
      evaluatedThisTick += 1;
    }
    const planned = base.length + planTripleTrialsV1(lane, Object.fromEntries(Object.entries(trials).filter(([, row]) => row.atoms.length === 2)), policy).length;
    const classified = classifyLaneTrialsV1(trials, { symbolCount: datasets.length, baselines, policy });
    await atomicJson(statePath, {
      contract: COMBINATION_SEARCH_CONTRACT_V1, atomLibraryVersion: COMBINATION_ATOM_LIBRARY_VERSION,
      laneId: lane.id, symbolKey, updatedAt: observedAt, researchCodeSha, baselines, trials,
    });
    summaries.push({ ...laneSummary(lane, classified, planned, datasets.map((row) => row.symbol), policy, baselines), stage, status: 'SEARCHING' });
    if (clock() >= deadline) break;
  }
  await atomicJson(cursorPath, { next: (cursor + 1) % Math.max(lanes.length, 1) });
  const result = Object.freeze({
    schemaVersion: 1,
    contract: COMBINATION_SEARCH_CONTRACT_V1,
    observedAt, researchCodeSha,
    atomLibraryVersion: COMBINATION_ATOM_LIBRARY_VERSION,
    atomFamilies: ATOM_FAMILIES,
    evaluatedThisTick,
    elapsedMs: clock() - started,
    datasetLog: log,
    lanes: summaries,
    policy,
    holdoutSealedBefore: '2026-01-01T00:00:00.000Z',
    aiProviderCalls: 0,
    safety: Object.freeze({ researchOnly: true, paperActivationAllowed: false, liveTrading: false, realOrder: false, executionAuthority: 'NONE' }),
  });
  await atomicJson(join(root, 'latest', 'combination-research-v1.json'), result);
  return result;
}

// ---------- Korean report ----------

const LANE_NAME_KO = Object.freeze({
  CRYPTO_SPOT_LONG: '코인현물 매수',
  CRYPTO_FUTURES_LONG: '코인선물 롱',
  CRYPTO_FUTURES_SHORT: '코인선물 숏',
  KR_STOCK_LONG: '국내주식 매수',
  US_STOCK_LONG: '해외주식 매수',
});
const STATUS_KO = Object.freeze({ SURVIVOR: '합격', WATCH: '관찰', REJECT: '탈락' });
const EXIT_KO = Object.freeze({
  X1: '손절 ATR×1.5 · 목표 손절폭×2 · 기본 보유기간',
  X2: '손절 ATR×2.5 · 목표 손절폭×1.5 · 보유기간 2배',
});

function pct(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return '-';
  const v = value * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

function datasetLineKo(line) {
  const [source, symbol, code, ...rest] = String(line).split(':');
  const detail = rest.join(':');
  const what = {
    FETCHED: `받음 (${detail}개 캔들)`,
    FAILED: `실패 (${detail}) → 1시간 뒤 다시 시도`,
    RETRY_LATER: '전에 실패해서 잠시 대기 중',
    FETCH_BUDGET_NEXT_TICK: '이번 회차 다운로드 한도 초과 → 다음 회차에 받음',
    TOO_FEW_CANDLES: `캔들 부족 (${detail}개)`,
  }[code] ?? code;
  return `  - ${source} ${symbol}: ${what}`;
}

/** Plain-Korean summary of one combination-search tick for the owner. */
export function formatCombinationReportKoV1(result) {
  const lines = [];
  lines.push(`[조합 연구 결과] ${result.observedAt}`);
  lines.push(`이번 실행: 조합 ${result.evaluatedThisTick}개 시험 · ${Math.round((result.elapsedMs ?? 0) / 1000)}초 · AI 사용 ${result.aiProviderCalls}회 · 실거래/주문 없음`);
  if (result.datasetLog?.length) {
    lines.push('데이터:');
    for (const line of result.datasetLog) lines.push(datasetLineKo(line));
  }
  for (const lane of result.lanes ?? []) {
    const name = LANE_NAME_KO[lane.laneId] ?? lane.laneId;
    if (lane.status === 'WAITING_FOR_DATA') {
      lines.push('');
      lines.push(`■ ${name}: 데이터 대기 중 (준비된 종목 ${lane.symbols?.length ?? 0}개, 최소 3개 필요)`);
      continue;
    }
    lines.push('');
    lines.push(`■ ${name} — 종목 ${lane.symbols.length}개 (${lane.symbols.join(', ')})`);
    lines.push(`  진행: ${lane.trialsEvaluated} / ${lane.trialsPlanned}개 시험 ${lane.searchExhausted ? '(이번 재료로는 탐색 완료)' : '(다음 회차에 계속)'}`);
    lines.push(`  판정: 합격 ${lane.survivors} · 관찰 ${lane.watch} · 탈락 ${lane.rejected}`);
    const b1 = lane.baselines?.X1?.validation; const b2 = lane.baselines?.X2?.validation;
    if (b1 || b2) lines.push(`  기준선(조건 없이 아무 때나 진입) 검증구간 거래당 평균: 청산1 ${pct(b1?.meanReturn, 3)} · 청산2 ${pct(b2?.meanReturn, 3)} — 합격하려면 이것보다 높아야 함`);
    lane.top.slice(0, 5).forEach((row, index) => {
      lines.push(`  ${index + 1}) [${STATUS_KO[row.finalStatus] ?? row.finalStatus}] ${row.labels.join(' + ')}`);
      lines.push(`     청산: ${EXIT_KO[row.exitId] ?? row.exitId}`);
      lines.push(`     검증구간(처음 보는 뒤 40%): 거래 ${row.validation.trades}회 · 거래당 평균 ${pct(row.validation.meanReturn, 3)} · 승률 ${pct(row.validation.winRate, 0).replace('+', '')} · 손익비 ${row.validation.profitFactor ?? '-'}`);
      lines.push(`     탐색구간(앞 60%): 거래 ${row.discovery.trades}회 · 거래당 평균 ${pct(row.discovery.meanReturn, 3)}`);
      if (row.beatsBaseline === false) lines.push('     ※ 기준선(그냥 시장에 있기)보다 낮아서 합격 아님');
      lines.push(`     일관성: 검증구간 플러스 종목 ${Math.round((row.symbolBreadth ?? 0) * 100)}% · 전체 4구간 중 ${row.positiveWindows}구간 플러스 · 우연 보정 q=${row.qValue} (0.10 이하면 통과)`);
    });
    if (lane.top.length === 0) lines.push('  아직 관찰할 만한 조합 없음 (모두 탈락)');
  }
  lines.push('');
  lines.push('용어: 합격 = 검증구간에서도 수익, 기준선(그냥 시장에 있기)보다 높음, 우연 보정(q ≤ 0.10) 통과, 종목 60% 이상·4구간 중 3구간 이상 플러스, 손익비 1.1 이상.');
  lines.push('      관찰 = 탐색·검증 둘 다 플러스지만 합격 기준은 아직 못 넘음. 2026년 데이터는 봉인(나중에 합격 조합만 1회 확인).');
  return lines.join('\n');
}
