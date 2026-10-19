// Exploratory forward paper ledger ("신호 걸리면 그것만 거래", lane=EXPLORATORY).
//
// Watches the liquid universe of every research data source and paper-trades
// a rule ONLY when all of its conditions fire on a closed candle, with the
// same next-open entry, ATR stop, exits, costs and funding as the research
// backtester. Every trade is recomputed from cached public candles each tick,
// so the ledger is deterministic and idempotent: it cannot drift, double count
// or be edited by hand.
//
// Rule sources (`mode`):
//   AUTO_SELECTED - research survivors that passed the unseen-symbol check and
//                   either passed the sealed 2026 check or found its budget
//                   spent (then forward paper is their ONLY remaining test);
//   EXPLORE       - the strongest non-rejected rules per lane, to measure how
//                   "nearly good" rules behave out of sample;
//   USER_SELECTED - rules the owner listed in exploratory-paper/user-rules.json.
//
// Sample windows: every candle at or after 2026-08-10 is unseen by research
// (selection used data before 2026, the holdout ends 2026-08-09). `strict`
// statistics count only signals after the ledger first activated the rule;
// promotion eligibility uses the strict sample only.
//
// This lane is NEVER the formal candidate list, never feeds automatic live
// trading, and holds no order authority. executionAuthority NONE.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { collectUpbitSpotHistory } from '../../market-prediction-lab/src/upbit-spot-history.js';
import { collectBitgetCandles } from '../../market-prediction-lab/src/bitget-candle-collector.js';
import { BitgetPublicClient } from '../../market-prediction-lab/src/bitget-public-client.js';
import { collectYahooStockHistory } from '../../market-prediction-lab/src/yahoo-stock-history.js';
import { RESEARCH_LANES_V2 } from './autonomous-research-discovery-v2.mjs';
import { COMBINATION_ATOM_LIBRARY_VERSION, atomsForDirectionV1, combinationAtomV1, computeCombinationAtomsV1 } from './combination-atoms-v1.mjs';
import {
  COMBINATION_EXIT_PROFILES_V1,
  COMBINATION_POLICY_V1,
  COMBINATION_UNIVERSE_V1,
  LANE_DATA_SOURCE_V1,
  classifyLaneTrialsV1,
  combinationExitParametersV1,
  combinationRiskModelV1,
  combinationSymbolCostV1,
} from './combination-search-lane-v1.mjs';
import { liquidityProfileV1, verifyCandleDatasetV1 } from './data-integrity-v1.mjs';
import { FORWARD_PAPER_START_MS, runExtendedExitForwardV1 } from './extended-exit-backtest-v1.mjs';
import { normalCdfV1 } from './trial-ledger-v1.mjs';
import { monteCarloTradeSequenceV1, portfolioRiskV1 } from './research-analytics-v1.mjs';

export const EXPLORATORY_PAPER_CONTRACT_V1 = 'exploratory-paper-ledger/v1';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const INTERVAL = Object.freeze({ '1h': HOUR, '1d': DAY });

export const EXPLORATORY_PAPER_POLICY_V1 = Object.freeze({
  exploreRulesPerLane: 5,
  maximumRulesPerLane: 12,
  maximumActiveRules: 60,
  maximumSymbolsPerSource: 300,
  maximumFetchesPerTick: 80,
  // Indicator warm-up kept before the forward window (200-bar averages, ADX...).
  warmupBars: 320,
  // Refresh cadence per timeframe (a daily bar needs one fetch a day).
  refreshAfterMs: Object.freeze({ '1h': 50 * 60_000, '1d': 20 * HOUR }),
  // Owner promotion criteria (2026-10-16): 30 trades, 95% lower bound of the
  // mean above zero, at least 3 distinct symbols.
  promotionMinimumTrades: 30,
  promotionMinimumSymbols: 3,
  // Lifecycle: enough strict trades and a 95% UPPER bound below zero = demoted.
  demotionMinimumTrades: 20,
  lateDetectionBars: 2,
  // Append-only trade journal (evidence that survives candle-cache changes).
  journalMaximumTrades: 20_000,
});

export const EXPLORATORY_TRADE_JOURNAL_CONTRACT_V1 = 'exploratory-paper-trade-journal/v1';

// ---------- helpers ----------

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

function sha(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function round(value, digits = 6) {
  return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

/** Mean, sd and two-sided 95% bounds of the mean (normal approximation). */
export function sampleSummaryV1(values) {
  const n = values.length;
  if (n === 0) return { n: 0, mean: null, lower95: null, upper95: null, winRate: null, total: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((s, v) => s + ((v - mean) ** 2), 0) / (n - 1)) : null;
  const half = sd == null ? null : 1.959964 * (sd / Math.sqrt(n));
  return {
    n,
    mean: round(mean),
    lower95: half == null ? null : round(mean - half),
    upper95: half == null ? null : round(mean + half),
    winRate: round(values.filter((v) => v > 0).length / n, 4),
    total: round(values.reduce((s, v) => s + v, 0)),
    pPositive: sd ? round(normalCdfV1(mean / (sd / Math.sqrt(n))), 4) : null,
  };
}

// ---------- candles ----------

function closedOnly(candles, timeframe, nowMs) {
  const interval = INTERVAL[timeframe];
  return candles.filter((row) => row.timestamp + interval <= nowMs);
}

function clean(rows) {
  return (rows ?? []).map((row) => ({ timestamp: Number(row.timestamp), open: Number(row.open), high: Number(row.high), low: Number(row.low),
    close: Number(row.close), volume: Number(row.volume ?? row.baseVolume ?? 0) }))
    .filter((row) => Number.isSafeInteger(row.timestamp) && [row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)
      && row.low > 0 && row.high >= row.low && row.open <= row.high && row.open >= row.low && row.close <= row.high && row.close >= row.low)
    .sort((a, b) => a.timestamp - b.timestamp)
    .filter((row, index, all) => index === 0 || row.timestamp > all[index - 1].timestamp);
}

export async function fetchForwardCandlesV1({ source, symbol, startTime, endTime, fetchImpl }) {
  if (source === 'UPBIT_1H') {
    const pages = Math.min(100, Math.ceil((endTime - startTime) / (200 * HOUR)) + 2);
    return (await collectUpbitSpotHistory({ symbol: symbol.replace(/^KRW-/u, ''), timeframe: '60m', startTime, endTime, maxPages: pages, minIntervalMs: 120, fetchImpl })).candles;
  }
  if (source === 'BITGET_1H') {
    return (await collectBitgetCandles({ client: new BitgetPublicClient({ fetchImpl }), market: 'CRYPTO_FUTURES', symbol, timeframe: '1h',
      startTime, endTime, maxCandles: 20_000, productType: 'usdt-futures' })).candles;
  }
  return (await collectYahooStockHistory({ market: source === 'YAHOO_KR_1D' ? 'KR_STOCK' : 'US_STOCK', symbol, startTime, endTime, fetchImpl })).candles;
}

async function fetchForwardFunding({ symbol, startTime, endTime, fetchImpl }) {
  const rows = [];
  let cursor = startTime;
  for (let page = 0; page < 10; page += 1) {
    const response = await fetchImpl(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&startTime=${cursor}&endTime=${endTime}&limit=1000`);
    if (!response.ok) throw new Error(`FORWARD_FUNDING_HTTP_${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error('FORWARD_FUNDING_SHAPE');
    for (const row of payload) {
      const timestamp = Number(row.fundingTime); const rate = Number(row.fundingRate);
      if (Number.isSafeInteger(timestamp) && Number.isFinite(rate)) rows.push({ timestamp, rate });
    }
    const last = Number(payload.at(-1)?.fundingTime);
    if (payload.length < 1000 || !Number.isFinite(last) || last < cursor) break;
    cursor = last + 1;
  }
  return rows.sort((a, b) => a.timestamp - b.timestamp).filter((row, i, all) => i === 0 || row.timestamp > all[i - 1].timestamp);
}

// ---------- paper-only guard ----------

/**
 * Registry and owner rule files are inputs this lane trusts for strategy
 * selection only. Any row that claims order authority, live or automatic
 * trading is refused before anything runs: this lane never carries it.
 */
export function assertPaperOnlyRulesV1(rows, label = 'rules') {
  for (const row of rows ?? []) {
    if (!row || typeof row !== 'object') continue;
    const authority = Object.hasOwn(row, 'executionAuthority') && row.executionAuthority !== 'NONE';
    const flags = row.realOrder === true || row.liveTrading === true || row.autoTrading === true || row.automaticLiveFeed === true;
    if (authority || flags) throw new Error(`EXPLORATORY_PAPER_AUTHORITY_INVALID:${label}`);
  }
  return true;
}

// ---------- trade journal ----------

function journalRow(trade, nowMs, prior) {
  return {
    tradeId: trade.tradeId, ruleId: trade.ruleId, laneId: trade.laneId, market: trade.market, symbol: trade.symbol, side: trade.side,
    signalTime: trade.signalTime, entryTime: trade.entryTime, exitTime: trade.exitTime, entryPrice: trade.entryPrice, exitPrice: trade.exitPrice,
    exitReason: trade.exitReason, status: trade.status, equityReturn: trade.equityReturn, rMultiple: trade.rMultiple, legs: trade.legs,
    mode: trade.mode, strict: trade.strict, recordedAt: prior?.recordedAt ?? nowMs, closedRecordedAt: trade.status === 'CLOSED' ? prior?.closedRecordedAt ?? nowMs : null,
  };
}

/**
 * Pure: folds this tick's recomputed trades into the append-only journal.
 * A CLOSED row is written once and never changed afterwards (a later
 * recomputation that disagrees is counted as a conflict, the original stays);
 * an OPEN row is updated until it closes. Trades no longer produced by the
 * recomputation (candle cache trimmed or corrected) stay in the journal and
 * are counted as vanished, so lost evidence is visible instead of silent.
 */
export function updateTradeJournalV1(journal, trades, { nowMs, maximumTrades = EXPLORATORY_PAPER_POLICY_V1.journalMaximumTrades } = {}) {
  const rows = { ...(journal?.trades ?? {}) };
  const stats = { added: 0, closedNow: 0, updatedOpen: 0, conflicts: 0, vanished: 0, trimmed: 0 };
  const live = new Set();
  for (const trade of trades) {
    live.add(trade.tradeId);
    const prior = rows[trade.tradeId];
    if (!prior) { rows[trade.tradeId] = journalRow(trade, nowMs, null); stats.added += 1; if (trade.status === 'CLOSED') stats.closedNow += 1; continue; }
    if (prior.status === 'CLOSED') {
      if (trade.status !== 'CLOSED' || prior.exitTime !== trade.exitTime || prior.rMultiple !== trade.rMultiple) stats.conflicts += 1;
      continue;
    }
    rows[trade.tradeId] = journalRow(trade, nowMs, prior);
    if (trade.status === 'CLOSED') stats.closedNow += 1; else stats.updatedOpen += 1;
  }
  for (const row of Object.values(rows)) if (!live.has(row.tradeId)) stats.vanished += 1;
  let ordered = Object.values(rows).sort((a, b) => a.entryTime - b.entryTime || a.tradeId.localeCompare(b.tradeId));
  if (ordered.length > maximumTrades) { stats.trimmed = ordered.length - maximumTrades; ordered = ordered.slice(stats.trimmed); }
  const next = {
    contract: EXPLORATORY_TRADE_JOURNAL_CONTRACT_V1, updatedAt: nowMs,
    firstRecordedAt: journal?.firstRecordedAt ?? nowMs,
    trades: Object.fromEntries(ordered.map((row) => [row.tradeId, row])),
    safety: Object.freeze({ paperOnly: true, realOrder: false, executionAuthority: 'NONE' }),
  };
  const closed = ordered.filter((row) => row.status === 'CLOSED').length;
  return { journal: next, stats: Object.freeze({ ...stats, recorded: ordered.length, closed, open: ordered.length - closed, firstRecordedAt: next.firstRecordedAt }) };
}

// ---------- rule selection ----------

export function customUserRuleV1(lane, wanted) {
  if (!Array.isArray(wanted?.atoms) || wanted.atoms.length < 1 || wanted.atoms.length > 3) return null;
  const allowed = new Set(atomsForDirectionV1(lane.direction).map((atom) => atom.id));
  const atoms = [...new Set(wanted.atoms.map(String))].sort();
  if (atoms.some((id) => !allowed.has(id))) return null;
  if (!atoms.some((id) => combinationAtomV1(id).side !== 'BOTH')) return null;
  const exitId = COMBINATION_EXIT_PROFILES_V1.some((row) => row.id === wanted.exitId) ? wanted.exitId : 'X1';
  return Object.freeze({ trialId: `user-${sha([lane.id, atoms, exitId]).slice(0, 16)}`, atoms: Object.freeze(atoms), exitId,
    finalStatus: 'USER', qValue: null, validation: { meanReturn: null } });
}

/** Rules this tick should paper-trade, per lane, from the research lane states. */
export function selectExploratoryRulesV1({ lanes = RESEARCH_LANES_V2, laneStates, userRules = [], policy = EXPLORATORY_PAPER_POLICY_V1, researchPolicy = COMBINATION_POLICY_V1 }) {
  const out = [];
  for (const lane of lanes) {
    const state = laneStates[lane.id];
    if (!state?.trials || state.atomLibraryVersion !== COMBINATION_ATOM_LIBRARY_VERSION) continue;
    const symbols = String(state.symbolKey ?? '').split('|')[0].split(',').filter(Boolean);
    const classified = classifyLaneTrialsV1(state.trials, { symbolCount: symbols.length, baselines: state.baselines ?? {}, policy: researchPolicy,
      priorTrials: Number(state.priorTrials ?? 0) });
    const ranked = classified.filter((row) => row.finalStatus !== 'REJECT')
      .sort((a, b) => (a.qValue - b.qValue) || (b.validation.meanReturn - a.validation.meanReturn) || a.trialId.localeCompare(b.trialId));
    const picked = new Map();
    for (const row of ranked) {
      const unseenPass = state.unseenChecks?.[row.trialId]?.pass === true;
      const holdout = state.holdout?.[row.trialId];
      const holdoutOk = holdout?.pass === true || (!holdout && row.finalStatus === 'SURVIVOR');
      if (row.finalStatus === 'SURVIVOR' && unseenPass && holdoutOk) picked.set(row.trialId, { row, mode: 'AUTO_SELECTED' });
    }
    for (const row of ranked) {
      if ([...picked.values()].filter((item) => item.mode === 'EXPLORE').length >= policy.exploreRulesPerLane) break;
      if (!picked.has(row.trialId) && state.holdout?.[row.trialId]?.pass !== false) picked.set(row.trialId, { row, mode: 'EXPLORE' });
    }
    for (const wanted of userRules.filter((item) => item.laneId === lane.id)) {
      const row = classified.find((item) => item.trialId === wanted.ruleId);
      if (row && !picked.has(row.trialId)) { picked.set(row.trialId, { row, mode: 'USER_SELECTED' }); continue; }
      // Owner-approved custom formula (e.g. an approved paper draft): library
      // atoms on the lane's side and a known exit profile only.
      const custom = customUserRuleV1(lane, wanted);
      if (custom && !picked.has(custom.trialId)) picked.set(custom.trialId, { row: custom, mode: 'USER_SELECTED' });
    }
    for (const { row, mode } of [...picked.values()].slice(0, policy.maximumRulesPerLane)) {
      out.push(Object.freeze({
        ruleId: row.trialId, laneId: lane.id, mode, atoms: Object.freeze([...row.atoms]), exitId: row.exitId,
        labels: Object.freeze(row.atoms.map((id) => combinationAtomV1(id).label)), researchStatus: row.finalStatus, qValue: row.qValue,
        researchValidationMean: row.validation?.meanReturn ?? null, holdoutPass: state.holdout?.[row.trialId]?.pass ?? null,
      }));
    }
  }
  return out;
}

// ---------- simulation ----------

/** Recomputes every forward paper trade of one rule on one symbol. */
export function simulateRuleOnSymbolV1({ lane, rule, symbol, candles, atoms, fundingRates = [], liquidity = null, nowMs }) {
  const exit = COMBINATION_EXIT_PROFILES_V1.find((row) => row.id === rule.exitId);
  if (!exit) throw new Error('EXPLORATORY_EXIT_UNKNOWN');
  if (!candles.length || candles.at(-1).timestamp < FORWARD_PAPER_START_MS) return [];
  const arrays = rule.atoms.map((id) => atoms.get(id));
  const result = runExtendedExitForwardV1({
    backtestInput: {
      market: lane.market, side: lane.direction === 'SHORT' ? 'short' : 'long', symbol, timeframe: lane.timeframe, candles, fundingRates,
      initialCapital: lane.initialCapital, costModel: combinationSymbolCostV1(lane, symbol, liquidity), riskModel: combinationRiskModelV1(lane),
    },
    strategy: 'exploratory_paper_v1', strategyVersion: `EXPLORATORY:${rule.ruleId}`,
    parameters: combinationExitParametersV1(lane, exit),
    signalEvaluator: ({ index }) => (arrays.every((array) => array[index] === 1) ? { rule: rule.ruleId } : null),
    period: { startTime: FORWARD_PAPER_START_MS, endTime: candles.at(-1).timestamp, forwardPaper: true },
  });
  const risk = combinationRiskModelV1(lane).riskPerTrade;
  return result.trades.map((trade) => {
    const open = trade.exitReason === 'end_of_data';
    const equityReturn = trade.netPnl / trade.equityBefore;
    return Object.freeze({
      tradeId: sha([rule.ruleId, symbol, trade.entryTime]).slice(0, 20),
      ruleId: rule.ruleId, laneId: lane.id, market: lane.market, symbol, side: trade.side,
      signalTime: trade.signalTime, entryTime: trade.entryTime, exitTime: open ? null : trade.exitTime,
      entryPrice: round(trade.entryPrice, 10), exitPrice: open ? null : round(trade.averageExitPrice, 10),
      markPrice: open ? round(trade.averageExitPrice, 10) : null,
      exitReason: open ? null : trade.exitReason, status: open ? 'OPEN' : 'CLOSED',
      equityReturn: round(equityReturn, 8), rMultiple: round(equityReturn / risk, 6),
      legs: trade.legs?.length ?? 1, observedThrough: nowMs,
    });
  });
}

function laneSourceSpec(lane, universe) {
  const source = LANE_DATA_SOURCE_V1[lane.id];
  return source ? { source, spec: universe[source] } : null;
}

// ---------- tick ----------

export async function runExploratoryPaperLedgerV1({
  stateRoot,
  now = () => new Date().toISOString(),
  fetchImpl = globalThis.fetch,
  lanes = RESEARCH_LANES_V2,
  watchUniverse = null,
  universe = COMBINATION_UNIVERSE_V1,
  candleFetcher = fetchForwardCandlesV1,
  fundingFetcher = fetchForwardFunding,
  policy = EXPLORATORY_PAPER_POLICY_V1,
  researchPolicy = COMBINATION_POLICY_V1,
  clock = () => Date.now(),
  budgetMs = 120_000,
} = {}) {
  if (!stateRoot) throw new Error('EXPLORATORY_STATE_ROOT_REQUIRED');
  const observedAt = now();
  const nowMs = Date.parse(observedAt);
  const started = clock();
  const base = join(stateRoot, 'exploratory-paper');
  const log = [];
  const registry = (await readJson(join(base, 'registry.json'))) ?? { contract: EXPLORATORY_PAPER_CONTRACT_V1, rules: {}, firstSeen: {} };
  const userRules = (await readJson(join(base, 'user-rules.json')))?.rules ?? [];
  assertPaperOnlyRulesV1(Object.values(registry.rules ?? {}), 'registry');
  assertPaperOnlyRulesV1(Array.isArray(userRules) ? userRules : [], 'user-rules');
  const laneStates = {};
  for (const lane of lanes) laneStates[lane.id] = await readJson(join(stateRoot, 'combination-research', 'lanes', lane.id, 'state.json'));
  const selected = selectExploratoryRulesV1({ lanes, laneStates, userRules: Array.isArray(userRules) ? userRules : [], policy, researchPolicy });
  for (const rule of selected) {
    const prior = registry.rules[rule.ruleId];
    // Demoted rules stay demoted: a rule is never re-admitted by re-selection.
    if (prior?.lifecycle === 'DEMOTED' || prior?.lifecycle === 'RETIRED') continue;
    registry.rules[rule.ruleId] = { ...rule, activatedAt: prior?.activatedAt ?? observedAt, lastSelectedAt: observedAt, lifecycle: prior?.lifecycle ?? 'ACTIVE' };
  }
  // Once paper-traded, a rule keeps being tracked (its strict sample must not
  // vanish when the research ranking shifts). Bound the book: when too many
  // rules are active, retire the oldest EXPLORE rules that are no longer selected.
  const selectedIds = new Set(selected.map((row) => row.ruleId));
  const active = Object.values(registry.rules).filter((rule) => rule.lifecycle === 'ACTIVE');
  const overflow = active.length - policy.maximumActiveRules;
  if (overflow > 0) {
    active.filter((rule) => rule.mode === 'EXPLORE' && !selectedIds.has(rule.ruleId))
      .sort((a, b) => String(a.lastSelectedAt).localeCompare(String(b.lastSelectedAt)) || a.ruleId.localeCompare(b.ruleId))
      .slice(0, overflow)
      .forEach((rule) => { rule.lifecycle = 'RETIRED'; rule.retiredAt = observedAt; });
  }
  const activeRules = Object.values(registry.rules).filter((rule) => rule.lifecycle === 'ACTIVE');

  // Candle cache refresh (bounded, oldest first).
  let fetches = 0;
  const sources = new Map();
  for (const lane of lanes) {
    const ls = laneSourceSpec(lane, universe);
    if (!ls || sources.has(ls.source)) continue;
    const symbols = [...(watchUniverse?.[ls.source] ?? ls.spec.symbols)].slice(0, policy.maximumSymbolsPerSource);
    sources.set(ls.source, { ...ls, symbols });
  }
  const cache = new Map();
  for (const [source, { spec, symbols }] of sources) {
    const interval = INTERVAL[spec.timeframe];
    const rows = [];
    for (const symbol of symbols) {
      const path = join(base, 'candles', source, `${symbol}.json`);
      rows.push({ symbol, path, cached: await readJson(path) });
    }
    rows.sort((a, b) => Number(a.cached?.fetchedAt ?? 0) - Number(b.cached?.fetchedAt ?? 0));
    for (const row of rows) {
      const stale = !row.cached || nowMs - Number(row.cached.fetchedAt ?? 0) >= policy.refreshAfterMs[spec.timeframe];
      if (stale && fetches < policy.maximumFetchesPerTick && clock() - started < budgetMs) {
        fetches += 1;
        const fullStart = Math.floor(FORWARD_PAPER_START_MS - (policy.warmupBars * interval * (spec.timeframe === '1d' ? 1.5 : 1)));
        const prior = row.cached?.candles ?? [];
        // Incremental: one page back from the last cached bar (public
        // collectors refuse fewer than ~120 hourly / 60 daily bars, and the
        // overlap also picks up late corrections of recent bars).
        const incremental = prior.length > 0 && prior[0].timestamp <= fullStart + (interval * 3);
        const overlap = spec.timeframe === '1d' ? 100 * DAY : 150 * HOUR;
        const startTime = incremental ? Math.max(fullStart, prior.at(-1).timestamp - overlap) : fullStart;
        try {
          const fetched = clean(await candleFetcher({ source, symbol: row.symbol, startTime, endTime: nowMs, fetchImpl }));
          const merged = new Map(prior.filter((candle) => candle.timestamp >= fullStart).map((candle) => [candle.timestamp, candle]));
          for (const candle of fetched) merged.set(candle.timestamp, candle);
          const fresh = clean([...merged.values()]);
          let fundingRates = row.cached?.fundingRates ?? [];
          if (source === 'BITGET_1H') {
            try { fundingRates = await fundingFetcher({ symbol: row.symbol, startTime: FORWARD_PAPER_START_MS, endTime: nowMs, fetchImpl }); }
            catch (error) { log.push(`${source}:${row.symbol}:FUNDING_FAILED:${String(error?.message ?? error).slice(0, 80)}`); }
          }
          row.cached = { contract: 'exploratory-forward-candles/v1', source, symbol: row.symbol, fetchedAt: nowMs, candles: fresh, fundingRates };
          await atomicJson(row.path, row.cached);
        } catch (error) {
          log.push(`${source}:${row.symbol}:FETCH_FAILED:${String(error?.message ?? error).slice(0, 100)}`);
        }
      }
      if (row.cached?.candles?.length) cache.set(`${source}|${row.symbol}`, row.cached);
    }
  }

  // Deterministic recomputation of all trades (atoms computed once per symbol,
  // shared by the long and short futures lanes).
  const simulated = [];
  const prepared = new Map();
  for (const lane of lanes) {
    const ls = laneSourceSpec(lane, universe);
    if (!ls) continue;
    const laneRules = activeRules.filter((rule) => rule.laneId === lane.id);
    if (laneRules.length === 0) continue;
    for (const symbol of sources.get(ls.source)?.symbols ?? []) {
      const key = `${ls.source}|${symbol}`;
      const cached = cache.get(key);
      if (!cached) continue;
      if (!prepared.has(key)) {
        const candles = closedOnly(cached.candles, ls.spec.timeframe, nowMs);
        if (candles.length < 260 || candles.at(-1).timestamp < FORWARD_PAPER_START_MS) { prepared.set(key, null); continue; }
        const integrity = verifyCandleDatasetV1(candles, { timeframe: ls.spec.timeframe });
        if (integrity.status === 'FAIL') { log.push(`${ls.source}:${symbol}:INTEGRITY_FAIL`); prepared.set(key, null); continue; }
        prepared.set(key, {
          candles,
          atoms: computeCombinationAtomsV1(candles, { timeframe: ls.spec.timeframe }),
          liquidity: liquidityProfileV1(candles.filter((row) => row.timestamp < FORWARD_PAPER_START_MS), { timeframe: ls.spec.timeframe }),
        });
      }
      const ready = prepared.get(key);
      if (!ready) continue;
      const { candles, atoms, liquidity } = ready;
      for (const rule of laneRules) {
        try {
          simulated.push(...simulateRuleOnSymbolV1({ lane, rule, symbol, candles, atoms, fundingRates: cached.fundingRates ?? [], liquidity, nowMs }));
        } catch (error) {
          log.push(`${rule.ruleId}:${symbol}:SIMULATION_FAILED:${String(error?.message ?? error).slice(0, 80)}`);
        }
      }
    }
  }

  // One row per trade identity: the same (rule, symbol, entry) can only be
  // produced once per tick, so a duplicate is a bug upstream and must never
  // be counted twice. Dropped duplicates are reported.
  const seenTradeIds = new Set();
  const trades = [];
  let duplicateTradesDropped = 0;
  for (const trade of simulated) {
    if (seenTradeIds.has(trade.tradeId)) { duplicateTradesDropped += 1; continue; }
    seenTradeIds.add(trade.tradeId);
    trades.push(trade);
  }
  if (duplicateTradesDropped > 0) log.push(`DUPLICATE_TRADES_DROPPED:${duplicateTradesDropped}`);
  // First time each trade was seen (detection delay; late = backfilled data).
  for (const trade of trades) registry.firstSeen[trade.tradeId] ??= nowMs;
  // Keep detection times only for trades that still exist (bounded registry).
  const live = new Set(trades.map((trade) => trade.tradeId));
  registry.firstSeen = Object.fromEntries(Object.entries(registry.firstSeen).filter(([id]) => live.has(id)));
  const decorated = trades.map((trade) => {
    const rule = registry.rules[trade.ruleId];
    const interval = INTERVAL[RESEARCH_LANES_V2.find((lane) => lane.id === trade.laneId)?.timeframe ?? '1h'];
    const detectedAt = registry.firstSeen[trade.tradeId];
    return {
      ...trade,
      lane: 'EXPLORATORY',
      mode: rule?.mode ?? 'EXPLORE',
      strict: trade.signalTime >= Date.parse(rule?.activatedAt ?? observedAt),
      lateDetection: detectedAt - trade.entryTime > policy.lateDetectionBars * interval,
      detectedAt,
    };
  });

  // Per-rule statistics, lifecycle and promotion eligibility.
  const ruleStats = [];
  for (const rule of Object.values(registry.rules)) {
    const closed = decorated.filter((trade) => trade.ruleId === rule.ruleId && trade.status === 'CLOSED');
    const strict = closed.filter((trade) => trade.strict);
    const all = sampleSummaryV1(closed.map((trade) => trade.rMultiple));
    const strictSummary = sampleSummaryV1(strict.map((trade) => trade.rMultiple));
    const strictSymbols = new Set(strict.map((trade) => trade.symbol)).size;
    if (rule.lifecycle === 'ACTIVE' && strictSummary.n >= policy.demotionMinimumTrades && strictSummary.upper95 != null && strictSummary.upper95 < 0) {
      rule.lifecycle = 'DEMOTED';
      rule.demotedAt = observedAt;
      rule.demotionReason = 'FORWARD_UPPER95_BELOW_ZERO';
    }
    const promotionEligible = strictSummary.n >= policy.promotionMinimumTrades && strictSummary.lower95 != null && strictSummary.lower95 > 0
      && strictSymbols >= policy.promotionMinimumSymbols;
    ruleStats.push(Object.freeze({
      ruleId: rule.ruleId, laneId: rule.laneId, mode: rule.mode, lifecycle: rule.lifecycle, labels: rule.labels ?? [], exitId: rule.exitId,
      currentlySelected: selectedIds.has(rule.ruleId),
      activatedAt: rule.activatedAt, researchStatus: rule.researchStatus, holdoutPass: rule.holdoutPass,
      open: decorated.filter((trade) => trade.ruleId === rule.ruleId && trade.status === 'OPEN').length,
      forwardAll: all, forwardStrict: strictSummary, strictSymbols,
      lateShare: closed.length ? round(closed.filter((trade) => trade.lateDetection).length / closed.length, 4) : null,
      promotionEligible,
      promotionGap: promotionEligible ? null : {
        tradesNeeded: Math.max(0, policy.promotionMinimumTrades - strictSummary.n),
        symbolsNeeded: Math.max(0, policy.promotionMinimumSymbols - strictSymbols),
        lowerBoundPositive: strictSummary.lower95 != null && strictSummary.lower95 > 0,
      },
    }));
  }
  const group = (key) => {
    const out = {};
    for (const trade of decorated.filter((row) => row.status === 'CLOSED')) (out[trade[key]] ??= []).push(trade.rMultiple);
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, sampleSummaryV1(v)]));
  };
  await atomicJson(join(base, 'registry.json'), registry);
  // Append-only evidence of every paper trade, independent of the candle cache.
  const journalPath = join(base, 'trade-journal.json');
  const priorJournal = await readJson(journalPath);
  const { journal, stats: journalStats } = updateTradeJournalV1(priorJournal?.contract === EXPLORATORY_TRADE_JOURNAL_CONTRACT_V1 ? priorJournal : null, decorated,
    { nowMs, maximumTrades: policy.journalMaximumTrades });
  await atomicJson(journalPath, journal);
  if (journalStats.vanished > 0) log.push(`JOURNAL_TRADES_VANISHED_FROM_RECOMPUTATION:${journalStats.vanished}`);
  if (journalStats.conflicts > 0) log.push(`JOURNAL_CLOSED_TRADE_CONFLICTS:${journalStats.conflicts}`);
  const recent = [...decorated].sort((a, b) => b.entryTime - a.entryTime).slice(0, 400);
  const result = Object.freeze({
    schemaVersion: 1,
    contract: EXPLORATORY_PAPER_CONTRACT_V1,
    lane: 'EXPLORATORY',
    observedAt,
    forwardStart: new Date(FORWARD_PAPER_START_MS).toISOString(),
    fetchesThisTick: fetches,
    elapsedMs: clock() - started,
    sources: Object.fromEntries([...sources].map(([source, row]) => [source, { watched: row.symbols.length,
      cached: row.symbols.filter((symbol) => cache.has(`${source}|${symbol}`)).length }])),
    rules: ruleStats,
    totals: {
      trades: decorated.length,
      closed: decorated.filter((row) => row.status === 'CLOSED').length,
      open: decorated.filter((row) => row.status === 'OPEN').length,
      byMode: group('mode'), byMarket: group('market'), byLane: group('laneId'),
      promotionEligibleRules: ruleStats.filter((row) => row.promotionEligible).length,
      demotedRules: ruleStats.filter((row) => row.lifecycle === 'DEMOTED').length,
      duplicateTradesDropped,
    },
    journal: journalStats,
    // Cross-rule risk and the drawdown distribution of the whole forward book.
    portfolio: portfolioRiskV1(decorated),
    monteCarlo: monteCarloTradeSequenceV1(decorated.filter((row) => row.status === 'CLOSED').map((row) => row.equityReturn), { paths: 1_000 }),
    recentTrades: recent,
    log: log.slice(0, 200),
    safety: Object.freeze({ lane: 'EXPLORATORY', formalCandidate: false, automaticLiveFeed: false, paperOnly: true, realOrder: false, executionAuthority: 'NONE' }),
  });
  await atomicJson(join(stateRoot, 'latest', 'exploratory-paper-ledger-v1.json'), result);
  return result;
}

// ---------- Korean report ----------

const MODE_KO = Object.freeze({ AUTO_SELECTED: '자동 선별', EXPLORE: '전체 탐색', USER_SELECTED: '직접 선택' });
const LANE_KO = Object.freeze({ CRYPTO_SPOT_LONG: '코인현물 매수', CRYPTO_FUTURES_LONG: '코인선물 롱', CRYPTO_FUTURES_SHORT: '코인선물 숏', KR_STOCK_LONG: '국내주식 매수', US_STOCK_LONG: '해외주식 매수' });

function r(value) {
  return value == null ? '-' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}R`;
}

export function formatExploratoryPaperReportKoV1(result) {
  const lines = [];
  lines.push(`[탐색용 모의매매(EXPLORATORY)] ${result.observedAt}`);
  lines.push(`실제 주문 0 · 정식 후보/자동매매와 분리 · 2026-08-10 이후 데이터만 사용(연구가 본 적 없는 구간)`);
  lines.push(`거래 ${result.totals.trades}건 (종료 ${result.totals.closed} · 보유 중 ${result.totals.open}) · 졸업 조건 충족 규칙 ${result.totals.promotionEligibleRules}개 · 강등 ${result.totals.demotedRules}개`);
  const j = result.journal;
  if (j) lines.push(`거래 기록 원장: 누적 ${j.recorded}건(종료 ${j.closed})${j.vanished ? ` · 재계산에서 사라진 거래 ${j.vanished}건(원장에는 보존)` : ''}${j.conflicts ? ` · 종료 거래 불일치 ${j.conflicts}건` : ''}`);
  for (const [mode, row] of Object.entries(result.totals.byMode)) lines.push(`  ${MODE_KO[mode] ?? mode}: ${row.n}건 · 평균 ${r(row.mean)} · 승률 ${row.winRate == null ? '-' : `${Math.round(row.winRate * 100)}%`}`);
  const p = result.portfolio;
  if (p?.rules) lines.push(`포트폴리오: 규칙 ${p.rules}개 · 합계 ${r(p.totalR)} · 최대낙폭 ${r(-p.maxDrawdownR)} · 동시 보유 최대 ${p.maxConcurrentPositions}건 · 평균 상관 ${p.averageAbsoluteCorrelation ?? '-'}${p.concentrationWarning ? ' (규칙들이 비슷하게 움직임 — 분산 효과 작음)' : ''}`);
  const mc = result.monteCarlo;
  if (mc?.paths) lines.push(`몬테카를로: 최대낙폭 나쁜 5% ${(mc.maxDrawdown.p95 * 100).toFixed(1)}% · 손실로 끝날 확률 ${Math.round(mc.probabilityOfLoss * 100)}%`);
  const rules = [...result.rules].sort((a, b) => (b.forwardStrict.n - a.forwardStrict.n) || a.ruleId.localeCompare(b.ruleId)).slice(0, 15);
  if (rules.length === 0) lines.push('아직 모의매매 중인 규칙 없음 (연구 결과가 쌓이면 자동으로 추가됨)');
  for (const rule of rules) {
    const s = rule.forwardStrict;
    lines.push('');
    lines.push(`■ [${MODE_KO[rule.mode] ?? rule.mode}] ${LANE_KO[rule.laneId] ?? rule.laneId} · ${rule.labels.join(' + ')} (${rule.exitId})${rule.lifecycle === 'DEMOTED' ? ' — 강등됨' : ''}`);
    lines.push(`   엄격 표본(규칙 활성화 이후): ${s.n}건 · 종목 ${rule.strictSymbols}개 · 평균 ${r(s.mean)} · 95% 하한 ${r(s.lower95)} · 보유 중 ${rule.open}건`);
    lines.push(`   전체 전진 표본(8/10 이후): ${rule.forwardAll.n}건 · 평균 ${r(rule.forwardAll.mean)}`);
    if (rule.promotionEligible) lines.push('   ★ 졸업 기준(30건·95% 하한>0·3종목) 충족 → 사람 승인 후 정식 검토 가능');
    else if (rule.promotionGap) lines.push(`   졸업까지: 거래 ${rule.promotionGap.tradesNeeded}건 더 · 종목 ${rule.promotionGap.symbolsNeeded}개 더 · 하한 ${rule.promotionGap.lowerBoundPositive ? '통과' : '아직 0 이하'}`);
  }
  return lines.join('\n');
}

export async function listExploratoryCandleSourcesV1(stateRoot) {
  try { return await readdir(join(stateRoot, 'exploratory-paper', 'candles')); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
}
