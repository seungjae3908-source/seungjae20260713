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

import { runExtendedExitBacktestV1, runExtendedExitFinalHoldoutV1 } from './extended-exit-backtest-v1.mjs';
import {
  appendExperimentRecordV1,
  experimentRecordV1,
  monteCarloTradeSequenceV1,
  regimeDependenceV1,
  regimeSeriesV1,
  rollingSelectionWalkForwardV1,
} from './research-analytics-v1.mjs';
import { LIQUIDITY_COST_MODEL_VERSION_V1, liquidityImpactV1, liquidityProfileV1, verifyCandleDatasetV1 } from './data-integrity-v1.mjs';
import {
  TRIAL_LEDGER_POLICY_V1,
  deflatedSharpeFromStatsV1,
  holdoutAllowedV1,
  priorTrialsExcludingV1,
  readTrialLedgerV1,
  recordExperimentTrialsV1,
  recordHoldoutUseV1,
  benjaminiHochbergCumulativeV1,
  writeTrialLedgerV1,
} from './trial-ledger-v1.mjs';
import { RESEARCH_BACKTEST_PERIOD } from '../../market-prediction-lab/src/multi-market-backtest-engine.js';
import { collectUpbitSpotHistory } from '../../market-prediction-lab/src/upbit-spot-history.js';
import { collectBitgetCandles } from '../../market-prediction-lab/src/bitget-candle-collector.js';
import { BitgetPublicClient } from '../../market-prediction-lab/src/bitget-public-client.js';
import { collectFundingRateHistory } from '../../market-prediction-lab/src/derivatives-history.js';
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
  UPBIT_1H: Object.freeze({ timeframe: '1h', lookbackDays: 820, symbols: Object.freeze([
    'KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE', 'KRW-ADA', 'KRW-AVAX', 'KRW-LINK', 'KRW-DOT', 'KRW-TRX',
    'KRW-BCH', 'KRW-ETC', 'KRW-ATOM', 'KRW-NEAR', 'KRW-LTC', 'KRW-XLM', 'KRW-AAVE', 'KRW-UNI', 'KRW-EOS', 'KRW-SAND']) }),
  BITGET_1H: Object.freeze({ timeframe: '1h', lookbackDays: 820, symbols: Object.freeze([
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'LTCUSDT',
    'BCHUSDT', 'ATOMUSDT', 'NEARUSDT', 'UNIUSDT', 'AAVEUSDT', 'TRXUSDT', 'ETCUSDT', 'XLMUSDT', 'FILUSDT', 'APTUSDT']) }),
  YAHOO_KR_1D: Object.freeze({ timeframe: '1d', lookbackDays: 5 * 365, symbols: Object.freeze([
    '069500', '229200', '005930', '000660', '035420', '005380', '000270', '051910', '006400', '035720',
    '068270', '105560', '055550', '012330', '066570', '003550', '028260', '096770', '017670', '030200']) }),
  YAHOO_US_1D: Object.freeze({ timeframe: '1d', lookbackDays: 5 * 365, symbols: Object.freeze([
    'SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'DIA', 'XLK', 'XLF', 'XLE', 'XLV',
    'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'XOM', 'JNJ', 'WMT', 'KO']) }),
});
// Survivorship note: these are large, long-lived names that still trade today,
// so history looks slightly better than a universe that included delisted ones.


export const LANE_DATA_SOURCE_V1 = Object.freeze({
  CRYPTO_SPOT_LONG: 'UPBIT_1H',
  CRYPTO_FUTURES_LONG: 'BITGET_1H',
  CRYPTO_FUTURES_SHORT: 'BITGET_1H',
  KR_STOCK_LONG: 'YAHOO_KR_1D',
  US_STOCK_LONG: 'YAHOO_US_1D',
});

// KR ETFs are exempt from the securities transaction tax; single stocks are not.
// Sell-side securities transaction tax for KR single stocks (0.20% from 2026; was 0.15%).
const KR_STOCK_SELL_TAX_RATE = 0.002;
const KR_ETF = new Set(['069500', '229200']);
// Retail overseas-stock friction the base lane cost (0.01% fee) does not cover:
// broker commission of about 0.10% per side and a KRW/USD conversion spread of
// about 0.10% per side. Assumptions, to be replaced with the broker's real rates.
const US_RETAIL_COMMISSION_RATE = 0.001;
const US_RETAIL_FX_SPREAD_RATE = 0.001;
function baseSymbolCost(lane, symbol) {
  if (lane.market === 'KR_STOCK' && !KR_ETF.has(symbol)) return { ...lane.cost, taxRate: KR_STOCK_SELL_TAX_RATE };
  if (lane.market === 'US_STOCK') {
    return {
      ...lane.cost,
      entryFeeRate: lane.cost.entryFeeRate + US_RETAIL_COMMISSION_RATE,
      exitFeeRate: lane.cost.exitFeeRate + US_RETAIL_COMMISSION_RATE,
      slippageRate: lane.cost.slippageRate + US_RETAIL_FX_SPREAD_RATE,
    };
  }
  return { ...lane.cost };
}

// Fixed slippage plus square-root market impact of the lane's full position
// notional (initial capital x leverage, the largest order the sizing allows)
// against the symbol's pre-2026 median daily traded value. Without a liquidity
// profile the base cost is used (identical to the pre-impact model).
export function combinationSymbolCostV1(lane, symbol, liquidity = null) {
  const base = baseSymbolCost(lane, symbol);
  if (!liquidity) return base;
  const notional = lane.initialCapital * combinationRiskModelV1(lane).leverage;
  const impact = liquidityImpactV1({ notional, medianDailyValue: liquidity.medianDailyValue, dailyVolatility: liquidity.dailyVolatility });
  return { ...base, slippageRate: base.slippageRate + impact };
}
const symbolCost = combinationSymbolCostV1;

// Coin futures are researched at 5x leverage with a 2% per-trade loss budget
// (owner decision 2026-10-16). Every other lane keeps 1x and 1%. Research only.
export function combinationRiskModelV1(lane) {
  return lane.market === 'CRYPTO_FUTURES' ? { riskPerTrade: 0.02, leverage: 5 } : { riskPerTrade: 0.01, leverage: 1 };
}

// X1/X2: fixed ATR stop, fixed target, time exit (canonical backtester).
// X3: let winners run - ATR trailing stop from +1R, no fixed target, 3x time.
// X4: scale out - half at +1.5R, stop to break-even, trail the rest, 3x time.
// X3/X4 use the extended-exit loop (proven equal to the canonical loop on
// plain exits). Only X1/X2 rules are exported to the Signal V3 scanner, whose
// plan model has fixed targets; X3/X4 rules are validated by forward paper.
export const COMBINATION_EXIT_PROFILES_V1 = Object.freeze([
  Object.freeze({ id: 'X1', stopAtrMultiple: 1.5, targetRiskMultiple: 2, timeBarsFactor: 1 }),
  Object.freeze({ id: 'X2', stopAtrMultiple: 2.5, targetRiskMultiple: 1.5, timeBarsFactor: 2 }),
  Object.freeze({ id: 'X3', stopAtrMultiple: 1.5, targetRiskMultiple: null, timeBarsFactor: 3,
    extended: Object.freeze({ trailing: Object.freeze({ atrMultiple: 2.5, activationRiskMultiple: 1 }) }) }),
  Object.freeze({ id: 'X4', stopAtrMultiple: 1.5, targetRiskMultiple: null, timeBarsFactor: 3,
    extended: Object.freeze({ partials: Object.freeze([Object.freeze({ riskMultiple: 1.5, fraction: 0.5 })]),
      trailing: Object.freeze({ atrMultiple: 2, activationRiskMultiple: 1.5 }), breakevenAfterFirstPartial: true }) }),
]);

export const SCANNER_EXPORTABLE_EXIT_IDS_V1 = Object.freeze(['X1', 'X2']);

/** Backtester parameters for one lane and exit profile. */
export function combinationExitParametersV1(lane, exit) {
  const parameters = { atrPeriod: 14, stopAtrMultiple: exit.stopAtrMultiple, timeBars: lane.timeBars * exit.timeBarsFactor };
  if (exit.extended) parameters.extended = exit.extended;
  else parameters.targetRiskMultiple = exit.targetRiskMultiple;
  return parameters;
}

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
  // Every fourth symbol of the universe never takes part in selection. A
  // survivor must also beat the market baseline on those unseen symbols before
  // the sealed 2026 holdout is spent on it.
  unseenSymbolStride: 4,
  minimumUnseenTrades: 15,
  requireUnseenSymbolPass: true,
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

function cleanCandles(rows, { allowHoldout = false } = {}) {
  return rows.map((row) => ({
    timestamp: Number(row.timestamp), open: Number(row.open), high: Number(row.high), low: Number(row.low),
    close: Number(row.close), volume: Number(row.volume ?? row.baseVolume ?? 0),
  })).filter((row) => Number.isSafeInteger(row.timestamp) && (allowHoldout || row.timestamp < HOLDOUT_START)
    && [row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)
    && row.open > 0 && row.high >= row.low && row.low > 0 && row.volume >= 0
    && row.open <= row.high && row.open >= row.low && row.close <= row.high && row.close >= row.low)
    .sort((a, b) => a.timestamp - b.timestamp)
    .filter((row, index, all) => index === 0 || row.timestamp > all[index - 1].timestamp);
}

async function fetchSourceCandles({ source, symbol, startTime, endTime, fetchImpl }) {
  if (source === 'UPBIT_1H') {
    const pages = Math.min(100, Math.ceil((endTime - startTime) / (200 * 3_600_000)) + 2);
    const history = await collectUpbitSpotHistory({ symbol: symbol.replace(/^KRW-/u, ''), timeframe: '60m', startTime, endTime,
      maxPages: pages, minIntervalMs: 150, fetchImpl });
    return history.candles;
  }
  if (source === 'BITGET_1H') {
    const history = await collectBitgetCandles({ client: new BitgetPublicClient({ fetchImpl }), market: 'CRYPTO_FUTURES', symbol,
      timeframe: '1h', startTime, endTime, maxCandles: 20_000, productType: 'usdt-futures' });
    return history.candles;
  }
  const history = await collectYahooStockHistory({ market: source === 'YAHOO_KR_1D' ? 'KR_STOCK' : 'US_STOCK', symbol, startTime, endTime, fetchImpl });
  return history.candles;
}

// Perpetual futures pay or receive funding while a position is open, so a
// futures backtest without it overstates long returns in bull runs and short
// returns in bear runs. Fail closed: incomplete funding history is an error,
// never a silent zero.
// Bitget serves only about four months of funding history, so older windows are
// completed from Binance USDT-M perpetuals (same 8h series, public) and labelled
// fundingSource BINANCE_PROXY. Still fail closed when neither source covers it.
async function fetchBinanceFundingRates({ symbol, startTime, endTime, fetchImpl }) {
  const rows = [];
  let cursor = startTime;
  for (let page = 0; page < 20; page += 1) {
    const response = await fetchImpl(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&startTime=${cursor}&endTime=${endTime}&limit=1000`);
    if (!response.ok) throw new Error(`COMBINATION_FUNDING_PROXY_HTTP_${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error('COMBINATION_FUNDING_PROXY_SHAPE');
    for (const row of payload) {
      const timestamp = Number(row.fundingTime);
      const rate = Number(row.fundingRate);
      if (Number.isSafeInteger(timestamp) && Number.isFinite(rate) && timestamp >= startTime && timestamp <= endTime) rows.push({ timestamp, rate });
    }
    const last = Number(payload.at(-1)?.fundingTime);
    if (payload.length < 1000 || !Number.isFinite(last) || last < cursor) break;
    cursor = last + 1;
  }
  return rows.sort((a, b) => a.timestamp - b.timestamp).filter((row, index, all) => index === 0 || row.timestamp > all[index - 1].timestamp);
}

export async function fetchCombinationFundingRatesV1({ source, symbol, startTime, endTime, fetchImpl, minimumRecords }) {
  if (source !== 'BITGET_1H') return { rows: [], fundingSource: null };
  let bitgetCount = 0;
  try {
    const history = await collectFundingRateHistory({
      client: new BitgetPublicClient({ fetchImpl }), symbol, startTime, endTime, maxPages: 80,
    });
    const rows = history.records.map((row) => ({ timestamp: row.timestamp, rate: row.rate }))
      .filter((row) => Number.isSafeInteger(row.timestamp) && Number.isFinite(row.rate));
    bitgetCount = rows.length;
    if (history.exhausted && rows.length >= minimumRecords) return { rows, fundingSource: 'BITGET' };
  } catch {
    bitgetCount = 0;
  }
  const proxy = await fetchBinanceFundingRates({ symbol, startTime, endTime, fetchImpl });
  if (proxy.length < minimumRecords) throw new Error(`COMBINATION_FUNDING_INCOMPLETE:${bitgetCount}/${proxy.length}`);
  return { rows: proxy, fundingSource: 'BINANCE_PROXY' };
}

/** Public candles only, capped before the sealed 2026 holdout. */
export async function loadCombinationDatasetV1({ source, symbol, fetchImpl = globalThis.fetch, universe = COMBINATION_UNIVERSE_V1 }) {
  const spec = universe[source];
  if (!spec || !spec.symbols.includes(symbol)) throw new Error('COMBINATION_DATASET_UNKNOWN');
  const endTime = HOLDOUT_START - 3_600_000;
  const startTime = endTime - (spec.lookbackDays * DAY);
  const candles = cleanCandles(await fetchSourceCandles({ source, symbol, startTime, endTime, fetchImpl }) ?? []);
  const minimum = spec.timeframe === '1d' ? 500 : 2_000;
  if (candles.length < minimum) throw new Error(`COMBINATION_DATASET_INSUFFICIENT:${candles.length}`);
  // About 3 funding payments per day; require two thirds of that as coverage.
  const funding = await fetchCombinationFundingRatesV1({ source, symbol, startTime, endTime, fetchImpl, minimumRecords: Math.floor(spec.lookbackDays * 2) });
  return Object.freeze({ source, symbol, timeframe: spec.timeframe, candles, fundingRates: funding.rows, fundingSource: funding.fundingSource });
}

export const HOLDOUT_END_V1 = RESEARCH_BACKTEST_PERIOD.defaultEndTime;

/** 2026 holdout candles, fetched only when a survivor needs its one-time check. */
export async function loadCombinationHoldoutDatasetV1({ source, symbol, fetchImpl = globalThis.fetch, nowMs = Date.now(), universe = COMBINATION_UNIVERSE_V1 }) {
  const spec = universe[source];
  if (!spec || !spec.symbols.includes(symbol)) throw new Error('COMBINATION_DATASET_UNKNOWN');
  const endTime = Math.min(HOLDOUT_END_V1, nowMs);
  const rows = await fetchSourceCandles({ source, symbol, startTime: HOLDOUT_START, endTime, fetchImpl });
  const candles = cleanCandles(rows ?? [], { allowHoldout: true }).filter((row) => row.timestamp >= HOLDOUT_START && row.timestamp <= HOLDOUT_END_V1);
  const minimum = spec.timeframe === '1d' ? 60 : 1_000;
  if (candles.length < minimum) throw new Error(`COMBINATION_HOLDOUT_INSUFFICIENT:${candles.length}`);
  const holdoutDays = Math.max(1, Math.floor((endTime - HOLDOUT_START) / DAY));
  const funding = await fetchCombinationFundingRatesV1({ source, symbol, startTime: HOLDOUT_START, endTime, fetchImpl, minimumRecords: Math.max(10, Math.floor(holdoutDays * 2)) });
  return Object.freeze({ source, symbol, timeframe: spec.timeframe, candles, fundingRates: funding.rows, fundingSource: funding.fundingSource });
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

export function evaluateCombinationTrialV1({ lane, trial, datasets, policy = COMBINATION_POLICY_V1, collectReturns = false }) {
  const exit = COMBINATION_EXIT_PROFILES_V1.find((row) => row.id === trial.exitId);
  if (!exit) throw new Error('COMBINATION_EXIT_UNKNOWN');
  const side = lane.direction === 'SHORT' ? 'short' : 'long';
  const discovery = []; const validation = [];
  const windows = Array.from({ length: policy.walkForwardWindows }, () => []);
  const perSymbol = [];
  // Out-of-sample (validation) returns per market regime of the traded symbol.
  const regimeReturns = { BULL: [], BEAR: [], SIDEWAYS: [] };
  for (const data of datasets) {
    const { candles, atoms, symbol, splitTime, windowEdges, fundingRates = [], liquidity = null, regimes = null } = data;
    const regimeAt = regimes ? new Map(candles.map((row, i) => [row.timestamp, regimes[i]])) : null;
    const arrays = trial.atoms.map((id) => atoms.get(id));
    const signalEvaluator = ({ index }) => (arrays.every((array) => array[index] === 1) ? { combination: trial.trialId } : null);
    const result = runExtendedExitBacktestV1({
      backtestInput: {
        market: lane.market, side, symbol, timeframe: lane.timeframe, candles, fundingRates,
        initialCapital: lane.initialCapital, costModel: symbolCost(lane, symbol, liquidity), riskModel: combinationRiskModelV1(lane),
      },
      strategy: 'combination_search_v1', strategyVersion: `COMBINATION:${trial.trialId}`,
      parameters: combinationExitParametersV1(lane, exit),
      signalEvaluator,
      period: { startTime: candles[0].timestamp, endTime: candles.at(-1).timestamp },
    });
    const symbolValidation = [];
    for (const trade of result.trades) {
      if (!(trade.equityBefore > 0)) continue;
      const r = trade.netPnl / trade.equityBefore;
      if (trade.signalTime < splitTime) discovery.push(r);
      else {
        validation.push(r); symbolValidation.push(r);
        const regime = regimeAt?.get(trade.signalTime);
        if (regime) regimeReturns[regime].push(r);
      }
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
    regimes: Object.fromEntries(Object.entries(regimeReturns).map(([key, rows]) => [key, { trades: rows.length, meanReturn: rows.length ? round(rows.reduce((a, b) => a + b, 0) / rows.length) : null }])),
    ...(collectReturns ? { validationReturns: validation } : {}),
  });
}

/** Final classification needs the lane-wide FDR, so it runs over all trials. */
export function classifyLaneTrialsV1(trials, { symbolCount, baselines = {}, policy = COMBINATION_POLICY_V1, priorTrials = 0 } = {}) {
  const rows = Object.values(trials);
  // Earlier experiments on the same data count in the FDR denominator (p = 1).
  const totalTrials = rows.length + Math.max(0, Math.floor(Number(priorTrials) || 0));
  const q = benjaminiHochbergCumulativeV1(rows.map((row) => row.pValue ?? 1), totalTrials);
  // Deflated Sharpe (reported): luck benchmark from the spread of per-trade
  // Sharpe estimates across this lane's non-rejected trials.
  const sharpes = rows.filter((row) => row.status !== 'REJECT' && row.validation?.trades >= 3)
    .map((row) => row.validation.tStat / Math.sqrt(row.validation.trades));
  const sMean = sharpes.reduce((a, b) => a + b, 0) / Math.max(1, sharpes.length);
  const sharpeVariance = sharpes.length > 1 ? sharpes.reduce((a, b) => a + ((b - sMean) ** 2), 0) / (sharpes.length - 1) : null;
  const out = rows.map((row, index) => {
    if (row.status === 'REJECT') return { ...row, qValue: round(q[index], 6), finalStatus: 'REJECT' };
    const n = row.validation?.trades ?? 0;
    const dsr = deflatedSharpeFromStatsV1({ sharpe: n > 0 ? row.validation.tStat / Math.sqrt(n) : 0, n, trials: totalTrials, sharpeVariance });
    row = { ...row, deflatedSharpeProbability: round(dsr.probability, 4) };
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
  out.totalTrials = totalTrials;
  return out;
}

// ---------- one-time 2026 holdout check ----------

export const HOLDOUT_POLICY_V1 = Object.freeze({ minimumTrades: 10, minimumSymbolBreadth: 0.6, warmupBars: 400 });

function holdoutReturns({ lane, atomIds, exitId, data }) {
  const exit = COMBINATION_EXIT_PROFILES_V1.find((row) => row.id === exitId);
  const side = lane.direction === 'SHORT' ? 'short' : 'long';
  const arrays = atomIds.map((id) => data.atoms.get(id));
  const result = runExtendedExitFinalHoldoutV1({
    backtestInput: {
      market: lane.market, side, symbol: data.symbol, timeframe: lane.timeframe, candles: data.candles, fundingRates: data.fundingRates ?? [],
      initialCapital: lane.initialCapital, costModel: symbolCost(lane, data.symbol, data.liquidity ?? null), riskModel: combinationRiskModelV1(lane),
    },
    strategy: 'combination_search_v1', strategyVersion: `COMBINATION_HOLDOUT:${atomIds.join('+') || 'BASELINE'}`,
    parameters: combinationExitParametersV1(lane, exit),
    signalEvaluator: ({ index }) => (arrays.every((array) => array[index] === 1) ? { holdout: true } : null),
    period: { startTime: HOLDOUT_START, endTime: Math.min(HOLDOUT_END_V1, data.candles.at(-1).timestamp), includeFinalHoldout: true },
  });
  return result.trades.filter((trade) => trade.equityBefore > 0 && trade.signalTime >= HOLDOUT_START)
    .map((trade) => trade.netPnl / trade.equityBefore);
}

/**
 * Evaluates a SURVIVOR exactly once on sealed 2026 data. The result is stored
 * and never used to pick or tune anything; a fail is final for that trial.
 */
export function evaluateHoldoutV1({ lane, trial, holdoutDatasets, observedAt, policy = HOLDOUT_POLICY_V1 }) {
  const pooled = []; const baseline = []; const perSymbol = [];
  for (const data of holdoutDatasets) {
    const r = holdoutReturns({ lane, atomIds: trial.atoms, exitId: trial.exitId, data });
    pooled.push(...r);
    baseline.push(...holdoutReturns({ lane, atomIds: [], exitId: trial.exitId, data }));
    const st = stats(r);
    perSymbol.push({ symbol: data.symbol, trades: st.trades, meanReturn: round(st.meanReturn) });
  }
  const h = stats(pooled); const b = stats(baseline);
  const traded = perSymbol.filter((row) => row.trades > 0);
  const breadth = traded.length === 0 ? 0 : traded.filter((row) => row.meanReturn > 0).length / traded.length;
  let reason = null;
  if (h.trades < policy.minimumTrades) reason = 'HOLDOUT_TOO_FEW_TRADES';
  else if (!(h.meanReturn > 0)) reason = 'HOLDOUT_NOT_POSITIVE';
  else if (!(h.meanReturn > b.meanReturn)) reason = 'HOLDOUT_BELOW_BASELINE';
  else if (breadth < policy.minimumSymbolBreadth) reason = 'HOLDOUT_SYMBOL_BREADTH_LOW';
  return Object.freeze({
    trialId: trial.trialId, checkedAt: observedAt, oneTimeOnly: true,
    period: { start: '2026-01-01', end: new Date(Math.min(HOLDOUT_END_V1, ...holdoutDatasets.map((d) => d.candles.at(-1).timestamp))).toISOString().slice(0, 10) },
    result: compact(h), baseline: compact(b), symbolBreadth: round(breadth, 4), symbols: perSymbol,
    pass: reason == null, reason,
  });
}

async function loadHoldoutSource({ root, source, warm, fetchImpl, loader, observedAtMs, fetchBudget, log, policy, universe = COMBINATION_UNIVERSE_V1 }) {
  const out = [];
  for (const data of warm) {
    const path = join(root, 'combination-research', 'holdout-datasets', source, `${data.symbol}.json`);
    let cached = await readJson(path);
    if (!cached?.candles?.length || (source === 'BITGET_1H' && !Array.isArray(cached.fundingRates))) {
      const failurePath = `${path.slice(0, -5)}.failure.json`;
      const failure = await readJson(failurePath);
      if (Number(failure?.retryAfter) > observedAtMs) { log.push(`HOLDOUT_${source}:${data.symbol}:RETRY_LATER`); continue; }
      if (fetchBudget.remaining <= 0) { log.push(`HOLDOUT_${source}:${data.symbol}:FETCH_BUDGET_NEXT_TICK`); continue; }
      fetchBudget.remaining -= 1;
      try {
        const fetched = await loader({ source, symbol: data.symbol, fetchImpl, nowMs: observedAtMs, universe });
        cached = { contract: 'combination-holdout-dataset/v1', source, symbol: data.symbol, fetchedAt: observedAtMs, candles: fetched.candles, fundingRates: fetched.fundingRates ?? [], fundingSource: fetched.fundingSource ?? null };
        await atomicJson(path, cached);
        log.push(`HOLDOUT_${source}:${data.symbol}:FETCHED:${fetched.candles.length}`);
      } catch (error) {
        const reason = String(error?.message ?? error).slice(0, 160);
        await atomicJson(failurePath, { reason, retryAfter: observedAtMs + 3_600_000 });
        log.push(`HOLDOUT_${source}:${data.symbol}:FAILED:${reason}`);
        continue;
      }
    }
    const future = cached.candles.filter((row) => row.timestamp >= HOLDOUT_START && row.timestamp <= HOLDOUT_END_V1);
    const candles = [...data.candles.slice(-policy.warmupBars), ...future];
    // Liquidity is the pre-2026 profile of the warm dataset: nothing measured
    // inside the holdout changes the cost charged in it.
    out.push({ symbol: data.symbol, candles, fundingRates: cached.fundingRates ?? [], liquidity: data.liquidity ?? null,
      atoms: computeCombinationAtomsV1(candles, { timeframe: data.timeframe }) });
  }
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

async function loadSourceDatasets({ root, source, fetchImpl, loader, observedAtMs, fetchBudget, log, universe = COMBINATION_UNIVERSE_V1 }) {
  const spec = universe[source];
  const ready = [];
  let pending = 0;
  for (const symbol of spec.symbols) {
    const path = join(root, 'combination-research', 'datasets', source, `${symbol}.json`);
    let cached = await readJson(path);
    const failurePath = join(root, 'combination-research', 'datasets', source, `${symbol}.failure.json`);
    // Datasets cached before funding was recorded are refetched for futures.
    if (!cached?.candles?.length || cached.lookbackDays !== spec.lookbackDays || (source === 'BITGET_1H' && !Array.isArray(cached.fundingRates))) {
      const failure = await readJson(failurePath);
      if (Number(failure?.retryAfter) > observedAtMs) { log.push(`${source}:${symbol}:RETRY_LATER`); continue; }
      if (fetchBudget.remaining <= 0) { log.push(`${source}:${symbol}:FETCH_BUDGET_NEXT_TICK`); pending += 1; continue; }
      fetchBudget.remaining -= 1;
      try {
        const data = await loader({ source, symbol, fetchImpl, universe });
        cached = { contract: 'combination-dataset/v1', source, symbol, timeframe: data.timeframe, lookbackDays: spec.lookbackDays, fetchedAt: observedAtMs, candles: data.candles, fundingRates: data.fundingRates ?? [], fundingSource: data.fundingSource ?? null };
        await atomicJson(path, cached);
        log.push(`${source}:${symbol}:FETCHED:${data.candles.length}`);
      } catch (error) {
        const reason = String(error?.message ?? error).slice(0, 160);
        // A short listing history will not grow within a day; do not churn the symbol set.
        const retryMs = reason.startsWith('COMBINATION_DATASET_INSUFFICIENT') ? 24 * 3_600_000 : 3_600_000;
        await atomicJson(failurePath, { reason, retryAfter: observedAtMs + retryMs });
        log.push(`${source}:${symbol}:FAILED:${reason}`);
        continue;
      }
    }
    // Defence in depth: never let a cached/injected 2026 candle into selection.
    const candles = cached.candles.filter((row) => row.timestamp < HOLDOUT_START);
    if (candles.length < 300) { log.push(`${source}:${symbol}:TOO_FEW_CANDLES:${candles.length}`); continue; }
    // Attestation: hash + coverage + OHLC checks. FAIL never enters a backtest.
    const integrity = verifyCandleDatasetV1(candles, { timeframe: cached.timeframe });
    if (integrity.status === 'FAIL') { log.push(`${source}:${symbol}:INTEGRITY_FAIL:${integrity.findings.join(',')}`); continue; }
    if (integrity.status === 'WARN') log.push(`${source}:${symbol}:INTEGRITY_WARN:${integrity.findings.join(',')}`);
    ready.push({ symbol, timeframe: cached.timeframe, candles, integrity,
      liquidity: liquidityProfileV1(candles, { timeframe: cached.timeframe }),
      fundingRates: (cached.fundingRates ?? []).filter((row) => row.timestamp < HOLDOUT_START) });
  }
  return { ready, pending };
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
      holdout: row.holdout ?? null, unseen: row.unseen ?? null,
      deflatedSharpeProbability: row.deflatedSharpeProbability ?? null, holdoutBudgetExhausted: row.holdoutBudgetExhausted === true,
      regimes: row.regimes ?? null, regimeDependence: row.regimeDependence ?? null, monteCarlo: row.monteCarlo ?? null,
    }));
  const paperCandidates = classified.filter((row) => row.finalStatus === 'SURVIVOR' && row.holdout?.pass === true
      && (!policy.requireUnseenSymbolPass || row.unseen?.pass === true))
    .map((row) => ({ trialId: row.trialId, atoms: row.atoms, labels: row.atoms.map((id) => combinationAtomV1(id).label),
      exitId: row.exitId, holdout: row.holdout }));
  const evaluated = classified.length;
  return Object.freeze({
    laneId: lane.id, market: lane.market, direction: lane.direction, timeframe: lane.timeframe,
    symbols, trialsEvaluated: evaluated, trialsPlanned: planned,
    survivors: count('SURVIVOR'), watch: count('WATCH'), rejected: count('REJECT'),
    holdoutChecked: classified.filter((row) => row.holdout).length,
    paperCandidates,
    searchExhausted: evaluated >= Math.min(planned, policy.maximumTrialsPerLane),
    baselines: Object.fromEntries(Object.entries(baselines).map(([exitId, row]) => [exitId, { validation: row.validation, discovery: row.discovery }])),
    top,
  });
}

function pooled(a, b) {
  const trades = a.trades + b.trades;
  return { trades, meanReturn: trades === 0 ? 0 : ((a.meanReturn * a.trades) + (b.meanReturn * b.trades)) / trades };
}

/** Survivor check on symbols that never took part in discovery or selection. */
export function evaluateUnseenSymbolsV1({ lane, trial, unseenDatasets, unseenBaselines, policy = COMBINATION_POLICY_V1 }) {
  const symbols = unseenDatasets.map((row) => row.symbol);
  const baseline = unseenBaselines?.[trial.exitId];
  if (unseenDatasets.length === 0 || !baseline) return Object.freeze({ pass: false, reason: 'NO_UNSEEN_SYMBOLS', symbols, trades: 0, meanReturn: 0, baselineMeanReturn: 0 });
  const result = evaluateCombinationTrialV1({ lane, trial, datasets: unseenDatasets, policy });
  const own = pooled(result.discovery, result.validation);
  const base = pooled(baseline.discovery, baseline.validation);
  let reason = 'PASS';
  if (own.trades < policy.minimumUnseenTrades) reason = 'UNSEEN_TRADES_TOO_FEW';
  else if (!(own.meanReturn > 0)) reason = 'UNSEEN_RETURN_NOT_POSITIVE';
  else if (!(own.meanReturn > base.meanReturn)) reason = 'UNSEEN_NOT_BETTER_THAN_BASELINE';
  return Object.freeze({
    pass: reason === 'PASS', reason, symbols, trades: own.trades,
    meanReturn: round(own.meanReturn), baselineMeanReturn: round(base.meanReturn),
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
  holdoutLoader = loadCombinationHoldoutDatasetV1,
  lanes = RESEARCH_LANES_V2,
  policy = COMBINATION_POLICY_V1,
  universe = COMBINATION_UNIVERSE_V1,
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
  // A corrupt ledger throws: never search with a forgotten trial count.
  const ledger = await readTrialLedgerV1(root);
  const cursor = Number((await readJson(cursorPath))?.next ?? 0) % Math.max(lanes.length, 1);
  const ordered = lanes.map((_, k) => lanes[(cursor + k) % lanes.length]);

  for (const lane of ordered) {
    const source = LANE_DATA_SOURCE_V1[lane.id];
    if (!source) continue;
    if (!sourceCache.has(source)) {
      const { ready, pending } = await loadSourceDatasets({ root, source, fetchImpl, loader: datasetLoader, observedAtMs, fetchBudget, log, universe });
      const all = ready.map((data) => {
        const { splitTime, windowEdges } = splitEdges(data.candles, policy);
        return { ...data, atoms: computeCombinationAtomsV1(data.candles, { timeframe: data.timeframe }), regimes: regimeSeriesV1(data.candles), splitTime, windowEdges };
      });
      const universeSymbols = universe[source].symbols;
      const isUnseen = (symbol) => policy.unseenSymbolStride > 0
        && universeSymbols.indexOf(symbol) % policy.unseenSymbolStride === policy.unseenSymbolStride - 1;
      sourceCache.set(source, { pending, seen: all.filter((row) => !isUnseen(row.symbol)), unseen: all.filter((row) => isUnseen(row.symbol)) });
    }
    const { pending: pendingSymbols, seen: datasets, unseen: unseenDatasets } = sourceCache.get(source);
    // Never search while the symbol set is still filling up: every change of the
    // set restarts the experiment and would re-spend the one-time 2026 check.
    if (pendingSymbols > 0) {
      summaries.push({ laneId: lane.id, status: 'WAITING_FOR_DATA', reason: 'DATASETS_STILL_DOWNLOADING', pendingSymbols, symbols: datasets.map((row) => row.symbol) });
      continue;
    }
    const statePath = join(root, 'combination-research', 'lanes', lane.id, 'state.json');
    const prior = await readJson(statePath);
    const symbolKey = `${datasets.map((row) => row.symbol).join(',')}|unseen:${unseenDatasets.map((row) => row.symbol).join(',')}|${universe[source].lookbackDays}d|${policy.unseenSymbolStride}`
      + `|exits:${COMBINATION_EXIT_PROFILES_V1.map((row) => row.id).join(',')}|cost:${LIQUIDITY_COST_MODEL_VERSION_V1}`;
    const experimentKey = sha256([lane.id, COMBINATION_ATOM_LIBRARY_VERSION, symbolKey].join('|')).slice(0, 24);
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
    // Baseline on the unseen symbols, used only for their out-of-sample check.
    const unseenBaselines = fresh ? {} : { ...(prior?.unseenBaselines ?? {}) };
    if (unseenDatasets.length > 0) {
      for (const exit of COMBINATION_EXIT_PROFILES_V1) {
        if (unseenBaselines[exit.id]) continue;
        unseenBaselines[exit.id] = evaluateCombinationTrialV1({ lane, trial: { trialId: `baseline-unseen-${exit.id}`, atoms: [], exitId: exit.id, stage: 'BASELINE' }, datasets: unseenDatasets, policy });
      }
    }
    for (const trial of pending) {
      if (clock() >= deadline || Object.keys(trials).length >= policy.maximumTrialsPerLane) break;
      trials[trial.trialId] = evaluateCombinationTrialV1({ lane, trial, datasets, policy });
      evaluatedThisTick += 1;
    }
    const planned = base.length + planTripleTrialsV1(lane, Object.fromEntries(Object.entries(trials).filter(([, row]) => row.atoms.length === 2)), policy).length;
    const priorTrials = priorTrialsExcludingV1(ledger, source, experimentKey);
    recordExperimentTrialsV1(ledger, { source, laneId: lane.id, experimentKey, trials: Object.keys(trials).length, observedAt });
    const classified = classifyLaneTrialsV1(trials, { symbolCount: datasets.length, baselines, policy, priorTrials });
    // One-time sealed-holdout check, only for survivors not yet checked.
    const holdout = fresh ? {} : { ...(prior?.holdout ?? {}) };
    // Survivors must first hold up on symbols that never took part in selection.
    const unseenChecks = fresh ? {} : { ...(prior?.unseenChecks ?? {}) };
    for (const row of classified) {
      if (row.finalStatus !== 'SURVIVOR') continue;
      if (!unseenChecks[row.trialId]) unseenChecks[row.trialId] = evaluateUnseenSymbolsV1({ lane, trial: row, unseenDatasets, unseenBaselines, policy });
      row.unseen = unseenChecks[row.trialId];
    }
    const unseenOk = (row) => !policy.requireUnseenSymbolPass || row.unseen?.pass === true;
    // The sealed 2026 check has a fixed per-source budget across ALL
    // experiments; once spent, only the live forward paper sample can validate.
    const unchecked = [];
    // Scarce budget goes to the strongest survivors first (same order as the report).
    const byStrength = [...classified].sort((a, b) => (a.qValue - b.qValue) || (b.validation.meanReturn - a.validation.meanReturn) || a.trialId.localeCompare(b.trialId));
    for (const row of byStrength) {
      if (row.finalStatus !== 'SURVIVOR' || !unseenOk(row) || holdout[row.trialId]) continue;
      if (holdoutAllowedV1(ledger, { source, trialId: row.trialId }).allowed) unchecked.push(row);
      else row.holdoutBudgetExhausted = true;
    }
    if (unchecked.length > 0 && clock() < deadline) {
      const holdoutDatasets = await loadHoldoutSource({ root, source, warm: datasets, fetchImpl, loader: holdoutLoader,
        observedAtMs, fetchBudget, log, policy: HOLDOUT_POLICY_V1, universe });
      if (holdoutDatasets.length === datasets.length) {
        for (const row of unchecked) {
          if (clock() >= deadline) break;
          if (!holdoutAllowedV1(ledger, { source, trialId: row.trialId }).allowed) { row.holdoutBudgetExhausted = true; continue; }
          holdout[row.trialId] = evaluateHoldoutV1({ lane, trial: row, holdoutDatasets, observedAt });
          recordHoldoutUseV1(ledger, { source, laneId: lane.id, trialId: row.trialId, observedAt, pass: holdout[row.trialId].pass });
        }
      }
    }
    for (const row of classified) if (holdout[row.trialId]) row.holdout = holdout[row.trialId];
    // Reproducibility: one append-only record per experiment with input digests.
    await appendExperimentRecordV1(root, experimentRecordV1({ laneId: lane.id, experimentKey, researchCodeSha, atomLibraryVersion: COMBINATION_ATOM_LIBRARY_VERSION,
      symbolKey, policy, observedAt, datasetDigests: Object.fromEntries(datasets.map((row) => [row.symbol, row.integrity?.sha256 ?? null])) }));
    // Monte Carlo of the out-of-sample trade sequence for the strongest rows
    // (re-evaluated once, returns not persisted) and regime dependence.
    const strongest = classified.filter((row) => row.finalStatus !== 'REJECT')
      .sort((a, b) => (a.qValue - b.qValue) || (b.validation.meanReturn - a.validation.meanReturn)).slice(0, 3);
    for (const row of strongest) {
      if (clock() >= deadline) break;
      const again = evaluateCombinationTrialV1({ lane, trial: row, datasets, policy, collectReturns: true });
      row.monteCarlo = monteCarloTradeSequenceV1(again.validationReturns, { paths: 1_000, seed: parseInt(row.trialId.slice(0, 8), 16) || 7 });
    }
    for (const row of classified) if (row.regimes) row.regimeDependence = regimeDependenceV1(row.regimes);
    const rollingWalkForward = rollingSelectionWalkForwardV1(trials, { minimumTrades: policy.minimumDiscoveryTrades });
    await atomicJson(statePath, {
      contract: COMBINATION_SEARCH_CONTRACT_V1, atomLibraryVersion: COMBINATION_ATOM_LIBRARY_VERSION,
      laneId: lane.id, symbolKey, experimentKey, priorTrials, source, updatedAt: observedAt, researchCodeSha, baselines, unseenBaselines, unseenChecks, holdout, trials,
      integrity: Object.fromEntries(datasets.map((row) => [row.symbol, { status: row.integrity?.status ?? null, sha256: row.integrity?.sha256 ?? null, findings: row.integrity?.findings ?? [] }])),
    });
    summaries.push({ ...laneSummary(lane, classified, planned, datasets.map((row) => row.symbol), policy, baselines),
      stage, status: 'SEARCHING', source, universeVersion: universe[source].universeVersion ?? 'V1', rollingWalkForward,
      cumulativeTrials: classified.totalTrials, priorTrials,
      holdoutUsed: ledger.holdoutUses.filter((row) => row.source === source).length, holdoutBudget: TRIAL_LEDGER_POLICY_V1.holdoutChecksPerSource,
      integrityWarnings: datasets.filter((row) => row.integrity?.status === 'WARN').length });
    if (clock() >= deadline) break;
  }
  await writeTrialLedgerV1(root, ledger);
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
    if (lane.rollingWalkForward?.outOfSampleTrades) {
      const w = lane.rollingWalkForward;
      lines.push(`  선택 과정 워크포워드(과거 구간에서 1등 고르고 다음 구간 성적): ${w.outOfSampleTrades}회 · 거래당 ${pct(w.outOfSampleMean, 3)} → ${w.verdict === 'SELECTION_HOLDS_OUT_OF_SAMPLE' ? '선택 방식이 다음 구간에서도 통함' : '선택 방식이 다음 구간에서 안 통함(과적합 경고)'}`);
    }
    if (lane.cumulativeTrials != null) lines.push(`  누적 시도(같은 데이터, 이전 실험 포함): ${lane.cumulativeTrials}개 → 우연 보정에 모두 반영 · 2026 확인 사용 ${lane.holdoutUsed ?? 0}/${lane.holdoutBudget ?? '-'}회 · 종목 목록 ${lane.universeVersion ?? 'V1'}`);
    lines.push(`  판정: 합격 ${lane.survivors} · 관찰 ${lane.watch} · 탈락 ${lane.rejected}`);
    const b1 = lane.baselines?.X1?.validation; const b2 = lane.baselines?.X2?.validation;
    if (b1 || b2) lines.push(`  기준선(조건 없이 아무 때나 진입) 검증구간 거래당 평균: 청산1 ${pct(b1?.meanReturn, 3)} · 청산2 ${pct(b2?.meanReturn, 3)} — 합격하려면 이것보다 높아야 함`);
    lane.top.slice(0, 5).forEach((row, index) => {
      lines.push(`  ${index + 1}) [${STATUS_KO[row.finalStatus] ?? row.finalStatus}] ${row.labels.join(' + ')}`);
      lines.push(`     청산: ${EXIT_KO[row.exitId] ?? row.exitId}`);
      lines.push(`     검증구간(처음 보는 뒤 40%): 거래 ${row.validation.trades}회 · 거래당 평균 ${pct(row.validation.meanReturn, 3)} · 승률 ${pct(row.validation.winRate, 0).replace('+', '')} · 손익비 ${row.validation.profitFactor ?? '-'}`);
      lines.push(`     탐색구간(앞 60%): 거래 ${row.discovery.trades}회 · 거래당 평균 ${pct(row.discovery.meanReturn, 3)}`);
      if (row.beatsBaseline === false) lines.push('     ※ 기준선(그냥 시장에 있기)보다 낮아서 합격 아님');
      if (row.unseen) {
        const u = row.unseen;
        const whyU = { NO_UNSEEN_SYMBOLS: '처음 보는 종목 데이터 없음', UNSEEN_TRADES_TOO_FEW: '거래 수 부족', UNSEEN_RETURN_NOT_POSITIVE: '손실', UNSEEN_NOT_BETTER_THAN_BASELINE: '기준선보다 낮음' }[u.reason] ?? u.reason;
        lines.push(`     처음 보는 종목 확인(${u.symbols.join(', ') || '-'}): ${u.pass ? '통과' : `실패(${whyU})`} · 거래 ${u.trades}회 · 거래당 ${pct(u.meanReturn, 3)} · 기준선 ${pct(u.baselineMeanReturn, 3)}`);
      }
      if (row.holdout) {
        const h = row.holdout;
        const why = { HOLDOUT_TOO_FEW_TRADES: '거래 수 부족', HOLDOUT_NOT_POSITIVE: '손실', HOLDOUT_BELOW_BASELINE: '기준선보다 낮음', HOLDOUT_SYMBOL_BREADTH_LOW: '플러스 종목 부족' }[h.reason] ?? h.reason;
        lines.push(`     2026 봉인 데이터 1회 확인(${h.period.start}~${h.period.end}): ${h.pass ? '통과 → 모의매매 후보' : `실패(${why})`} · 거래 ${h.result.trades}회 · 거래당 ${pct(h.result.meanReturn, 3)} · 기준선 ${pct(h.baseline.meanReturn, 3)} · 플러스 종목 ${Math.round(h.symbolBreadth * 100)}%`);
      } else if (row.finalStatus === 'SURVIVOR' && row.holdoutBudgetExhausted) {
        lines.push(`     2026 봉인 데이터 확인: 이 데이터의 확인 횟수(${lane.holdoutBudget ?? '-'}회)를 다 써서 하지 않음 → 실시간 모의매매 결과로만 검증`);
      } else if (row.finalStatus === 'SURVIVOR') {
        lines.push('     2026 봉인 데이터 확인: 대기 중(다음 회차)');
      }
      lines.push(`     일관성: 검증구간 플러스 종목 ${Math.round((row.symbolBreadth ?? 0) * 100)}% · 전체 4구간 중 ${row.positiveWindows}구간 플러스 · 우연 보정 q=${row.qValue} (0.10 이하면 통과)`);
      if (row.deflatedSharpeProbability != null) lines.push(`     운 보정 샤프(참고): ${Math.round(row.deflatedSharpeProbability * 100)}% (95% 이상이면 운으로 설명하기 어려움)`);
      if (row.regimes) {
        const g = row.regimes;
        const dep = { ALL_REGIMES: '모든 국면에서 플러스', ONLY_BULL: '상승장에서만 플러스(주의)', ONLY_BEAR: '하락장에서만 플러스', ONLY_SIDEWAYS: '횡보장에서만 플러스', MIXED: '국면별로 엇갈림', NONE: '모든 국면에서 마이너스', INSUFFICIENT: '국면별 표본 부족' }[row.regimeDependence] ?? '-';
        lines.push(`     시장 국면(검증구간): 상승 ${g.BULL.trades}회 ${pct(g.BULL.meanReturn, 3)} · 하락 ${g.BEAR.trades}회 ${pct(g.BEAR.meanReturn, 3)} · 횡보 ${g.SIDEWAYS.trades}회 ${pct(g.SIDEWAYS.meanReturn, 3)} → ${dep}`);
      }
      if (row.monteCarlo?.paths) {
        const mc = row.monteCarlo;
        lines.push(`     몬테카를로(거래 순서 ${mc.paths}회 섞기): 최대낙폭 중간 ${pct(-mc.maxDrawdown.p50, 1)} · 나쁜 5% ${pct(-mc.maxDrawdown.p95, 1)} · 원금 ${Math.round(mc.ruinDrawdown * 100)}% 손실 확률 ${Math.round(mc.probabilityOfRuin * 100)}%`);
      }
    });
    if (lane.top.length === 0) lines.push('  아직 관찰할 만한 조합 없음 (모두 탈락)');
    if (lane.paperCandidates?.length) lines.push(`  ★ 모의매매 후보 ${lane.paperCandidates.length}개: ${lane.paperCandidates.map((row) => row.labels.join(' + ')).join(' / ')}`);
  }
  lines.push('');
  lines.push('용어: 합격 = 검증구간에서도 수익, 기준선(그냥 시장에 있기)보다 높음, 우연 보정(q ≤ 0.10) 통과, 종목 60% 이상·4구간 중 3구간 이상 플러스, 손익비 1.1 이상.');
  lines.push('      관찰 = 탐색·검증 둘 다 플러스지만 합격 기준은 아직 못 넘음. 2026년 데이터는 봉인(나중에 합격 조합만 1회 확인).');
  return lines.join('\n');
}
