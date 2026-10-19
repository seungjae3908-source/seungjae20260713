import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RESEARCH_LANES_V2 } from '../src/autonomous-research-discovery-v2.mjs';
import { COMBINATION_ATOM_LIBRARY_VERSION, computeCombinationAtomsV1 } from '../src/combination-atoms-v1.mjs';
import { FORWARD_PAPER_START_MS } from '../src/extended-exit-backtest-v1.mjs';
import {
  assertPaperOnlyRulesV1,
  formatExploratoryPaperReportKoV1,
  runExploratoryPaperLedgerV1,
  sampleSummaryV1,
  selectExploratoryRulesV1,
  simulateRuleOnSymbolV1,
  updateTradeJournalV1,
} from '../src/exploratory-paper-ledger-v1.mjs';

const KR = RESEARCH_LANES_V2.find((lane) => lane.id === 'KR_STOCK_LONG');
const DAY = 86_400_000;

function trial(id, atoms, { status = 'WATCH', p = 0.01, mean = 0.004, exitId = 'X1' } = {}) {
  return { trialId: id, atoms, exitId, stage: 'PAIR', status, reason: null, pValue: p,
    discovery: { trades: 40, meanReturn: mean, profitFactor: 1.4, tStat: 2, winRate: 0.55, totalReturn: 0.1 },
    validation: { trades: 40, meanReturn: mean, profitFactor: 1.4, tStat: 2.5, winRate: 0.55, totalReturn: 0.1 },
    walkForward: { windows: [], positiveWindows: 4 }, symbolBreadth: 1, symbols: [] };
}

function laneState(extra = {}) {
  const trials = {
    surv: trial('surv', ['T_CLOSE_ABOVE_SMA50', 'M_RSI14_GT_50'], { p: 0.000001, mean: 0.01 }),
    w1: trial('w1', ['T_SMA20_ABOVE_SMA50', 'M_MACD_HIST_POS'], { p: 0.2 }),
    w2: trial('w2', ['T_CLOSE_ABOVE_SMA200', 'M_ROC10_POS'], { p: 0.3, exitId: 'X3' }),
    bad: trial('bad', ['M_RSI14_LT_30'], { status: 'REJECT', p: 1 }),
  };
  return {
    atomLibraryVersion: COMBINATION_ATOM_LIBRARY_VERSION,
    symbolKey: '005930,000660,035420,005380|unseen:000270|1825d|4',
    baselines: { X1: { validation: { meanReturn: 0.0001 } }, X3: { validation: { meanReturn: 0.0001 } } },
    trials,
    unseenChecks: { surv: { pass: true } },
    holdout: { surv: { pass: true, result: { trades: 12, meanReturn: 0.01 } } },
    ...extra,
  };
}

function dailyTrend(n, seed, start = FORWARD_PAPER_START_MS - (420 * DAY)) {
  let s = seed; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out = []; let price = 100;
  for (let i = 0; i < n; i += 1) {
    const open = price; const close = open * (1 + 0.003 + ((rnd() - 0.5) * 0.03));
    out.push({ timestamp: start + (i * DAY), open, close, high: Math.max(open, close) * 1.01, low: Math.min(open, close) * 0.99, volume: 1e6 });
    price = close;
  }
  return out;
}

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'exploratory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('rule selection: survivors with unseen + holdout pass are AUTO_SELECTED, the next best are EXPLORE, rejects never', () => {
  const rules = selectExploratoryRulesV1({ lanes: [KR], laneStates: { KR_STOCK_LONG: laneState() } });
  const byId = Object.fromEntries(rules.map((row) => [row.ruleId, row.mode]));
  assert.equal(byId.surv, 'AUTO_SELECTED');
  assert.equal(byId.w1, 'EXPLORE');
  assert.equal(byId.w2, 'EXPLORE');
  assert.equal(byId.bad, undefined);
  const failedHoldout = laneState();
  failedHoldout.holdout.surv.pass = false;
  assert.equal(selectExploratoryRulesV1({ lanes: [KR], laneStates: { KR_STOCK_LONG: failedHoldout } }).some((row) => row.ruleId === 'surv'), false,
    'a rule that failed the sealed check is never paper-traded');
  const user = selectExploratoryRulesV1({ lanes: [KR], laneStates: { KR_STOCK_LONG: laneState() }, userRules: [{ laneId: 'KR_STOCK_LONG', ruleId: 'w1' }],
    policy: { exploreRulesPerLane: 0, maximumRulesPerLane: 12 } });
  assert.equal(user.find((row) => row.ruleId === 'w1').mode, 'USER_SELECTED');
});

test('forward simulation never trades on research or holdout candles', () => {
  const candles = dailyTrend(520, 5);
  const atoms = computeCombinationAtomsV1(candles, { timeframe: '1d' });
  const rule = { ruleId: 'r', atoms: ['T_CLOSE_ABOVE_SMA50'], exitId: 'X1' };
  const trades = simulateRuleOnSymbolV1({ lane: KR, rule, symbol: '005930', candles, atoms, nowMs: candles.at(-1).timestamp + DAY });
  assert.ok(trades.length > 0);
  assert.ok(trades.every((trade) => trade.signalTime >= FORWARD_PAPER_START_MS));
  const x3 = simulateRuleOnSymbolV1({ lane: KR, rule: { ...rule, exitId: 'X3' }, symbol: '005930', candles, atoms, nowMs: candles.at(-1).timestamp + DAY });
  assert.ok(x3.length > 0);
  assert.ok(x3.every((trade) => Number.isFinite(trade.rMultiple)));
});

test('sample summary bounds', () => {
  const s = sampleSummaryV1([1, -0.5, 2, 1, -1, 1.5, 0.5]);
  assert.equal(s.n, 7);
  assert.ok(s.lower95 < s.mean && s.mean < s.upper95);
  assert.equal(sampleSummaryV1([]).n, 0);
});

test('ledger tick: deterministic, idempotent, strict sample starts at activation, Korean report', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'combination-research', 'lanes', 'KR_STOCK_LONG'), { recursive: true });
  await writeFile(join(root, 'combination-research', 'lanes', 'KR_STOCK_LONG', 'state.json'), JSON.stringify(laneState()));
  const symbols = ['005930', '000660', '035420', '005380'];
  const nowMs = FORWARD_PAPER_START_MS + (100 * DAY);
  let fetches = 0;
  const candleFetcher = async ({ symbol, endTime }) => { fetches += 1; return dailyTrend(520, Number(symbol) % 97 + 1).filter((row) => row.timestamp < endTime); };
  const run = (iso) => runExploratoryPaperLedgerV1({ stateRoot: root, lanes: [KR], watchUniverse: { YAHOO_KR_1D: symbols }, candleFetcher,
    now: () => iso });
  const first = await run(new Date(nowMs).toISOString());
  assert.equal(fetches, symbols.length);
  assert.ok(first.totals.trades > 0);
  assert.equal(first.safety.executionAuthority, 'NONE');
  assert.equal(first.safety.formalCandidate, false);
  // Activated "now": every earlier signal is outside the strict sample.
  assert.ok(first.rules.every((rule) => rule.forwardStrict.n === 0));
  assert.ok(first.rules.some((rule) => rule.forwardAll.n > 0));
  const again = await run(new Date(nowMs + 60_000).toISOString());
  assert.equal(fetches, symbols.length, 'cache reused within the refresh window');
  assert.deepEqual(again.recentTrades.map((row) => row.tradeId), first.recentTrades.map((row) => row.tradeId), 'recomputation is idempotent');
  const stored = JSON.parse(await readFile(join(root, 'latest', 'exploratory-paper-ledger-v1.json'), 'utf8'));
  assert.equal(stored.lane, 'EXPLORATORY');
  const text = formatExploratoryPaperReportKoV1(first);
  assert.match(text, /탐색용 모의매매/u);
  assert.match(text, /엄격 표본/u);
  assert.match(text, /실제 주문 0/u);
});

test('a rule whose strict forward sample is clearly losing is demoted and never re-admitted', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'combination-research', 'lanes', 'KR_STOCK_LONG'), { recursive: true });
  await writeFile(join(root, 'combination-research', 'lanes', 'KR_STOCK_LONG', 'state.json'), JSON.stringify(laneState()));
  // Register every rule as active long ago so the forward window is strict.
  await mkdir(join(root, 'exploratory-paper'), { recursive: true });
  const activatedAt = new Date(FORWARD_PAPER_START_MS).toISOString();
  const registry = { contract: 'exploratory-paper-ledger/v1', firstSeen: {}, rules: {} };
  for (const id of ['surv', 'w1', 'w2']) registry.rules[id] = { ruleId: id, laneId: 'KR_STOCK_LONG', activatedAt, lifecycle: 'ACTIVE' };
  await writeFile(join(root, 'exploratory-paper', 'registry.json'), JSON.stringify(registry));
  // Falling market: long rules lose.
  const down = (seed) => dailyTrend(520, seed).map((row, i, all) => {
    if (row.timestamp < FORWARD_PAPER_START_MS) return row;
    const f = 0.996 ** (i - all.findIndex((x) => x.timestamp >= FORWARD_PAPER_START_MS));
    return { ...row, open: row.open * f, close: row.close * f * 0.99, high: row.high * f, low: row.low * f * 0.985 };
  });
  const symbols = Array.from({ length: 12 }, (_, i) => String(100000 + i));
  const candleFetcher = async ({ symbol }) => down(Number(symbol) % 89 + 2);
  const result = await runExploratoryPaperLedgerV1({ stateRoot: root, lanes: [KR], watchUniverse: { YAHOO_KR_1D: symbols }, candleFetcher,
    now: () => new Date(FORWARD_PAPER_START_MS + (95 * DAY)).toISOString() });
  const demoted = result.rules.filter((rule) => rule.lifecycle === 'DEMOTED');
  assert.ok(demoted.length > 0, 'falling market demotes at least one long rule');
  for (const rule of demoted) assert.ok(rule.forwardStrict.n >= 20 && rule.forwardStrict.upper95 < 0);
  const stored = JSON.parse(await readFile(join(root, 'exploratory-paper', 'registry.json'), 'utf8'));
  for (const rule of demoted) assert.equal(stored.rules[rule.ruleId].lifecycle, 'DEMOTED');
  const later = await runExploratoryPaperLedgerV1({ stateRoot: root, lanes: [KR], watchUniverse: { YAHOO_KR_1D: symbols }, candleFetcher,
    now: () => new Date(FORWARD_PAPER_START_MS + (96 * DAY)).toISOString() });
  for (const rule of demoted) assert.equal(later.rules.find((row) => row.ruleId === rule.ruleId).lifecycle, 'DEMOTED');
});

test('trade journal: closed rows are written once and kept when the recomputation forgets them; conflicts and trims are counted', () => {
  const t0 = Date.UTC(2026, 8, 1);
  const trade = (id, status, entryTime, extra = {}) => ({ tradeId: id, ruleId: 'r', laneId: 'KR_STOCK_LONG', market: 'KR_STOCK', symbol: '005930', side: 'long',
    signalTime: entryTime - DAY, entryTime, exitTime: status === 'CLOSED' ? entryTime + DAY : null, entryPrice: 100, exitPrice: status === 'CLOSED' ? 101 : null,
    exitReason: status === 'CLOSED' ? 'target' : null, status, equityReturn: 0.01, rMultiple: 1, legs: 1, mode: 'EXPLORE', strict: true, ...extra });
  const first = updateTradeJournalV1(null, [trade('a', 'CLOSED', t0), trade('b', 'OPEN', t0 + DAY)], { nowMs: t0 + (2 * DAY) });
  assert.equal(first.stats.recorded, 2);
  assert.equal(first.stats.closed, 1);
  assert.equal(first.journal.trades.a.closedRecordedAt, t0 + (2 * DAY));
  // Next tick: b closes, a is recomputed differently (ignored, counted), c is new, nothing vanished.
  const second = updateTradeJournalV1(first.journal, [trade('a', 'CLOSED', t0, { rMultiple: 2 }), trade('b', 'CLOSED', t0 + DAY), trade('c', 'OPEN', t0 + (2 * DAY))], { nowMs: t0 + (3 * DAY) });
  assert.equal(second.journal.trades.a.rMultiple, 1, 'a closed row is immutable');
  assert.equal(second.stats.conflicts, 1);
  assert.equal(second.journal.trades.b.status, 'CLOSED');
  assert.equal(second.journal.trades.b.recordedAt, t0 + (2 * DAY), 'first-seen time kept');
  assert.equal(second.stats.closedNow, 1);
  assert.equal(second.stats.vanished, 0);
  // Candle cache trimmed: a and b are no longer produced, but the journal keeps them.
  const third = updateTradeJournalV1(second.journal, [trade('c', 'CLOSED', t0 + (2 * DAY))], { nowMs: t0 + (4 * DAY) });
  assert.equal(third.stats.vanished, 2);
  assert.deepEqual(Object.keys(third.journal.trades).sort(), ['a', 'b', 'c']);
  assert.equal(third.journal.safety.executionAuthority, 'NONE');
  const trimmed = updateTradeJournalV1(third.journal, [], { nowMs: t0 + (5 * DAY), maximumTrades: 2 });
  assert.equal(trimmed.stats.trimmed, 1);
  assert.deepEqual(Object.keys(trimmed.journal.trades), ['b', 'c'], 'oldest entry dropped first');
});

test('ledger tick persists the trade journal across ticks and reports it; duplicates never count twice', async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, 'combination-research', 'lanes', 'KR_STOCK_LONG'), { recursive: true });
  await writeFile(join(root, 'combination-research', 'lanes', 'KR_STOCK_LONG', 'state.json'), JSON.stringify(laneState()));
  const symbols = ['005930', '000660', '035420', '005380'];
  const nowMs = FORWARD_PAPER_START_MS + (100 * DAY);
  const candleFetcher = async ({ symbol, endTime }) => dailyTrend(520, Number(symbol) % 97 + 1).filter((row) => row.timestamp < endTime);
  const first = await runExploratoryPaperLedgerV1({ stateRoot: root, lanes: [KR], watchUniverse: { YAHOO_KR_1D: symbols }, candleFetcher, now: () => new Date(nowMs).toISOString() });
  assert.equal(first.journal.recorded, first.totals.trades);
  assert.equal(first.totals.duplicateTradesDropped, 0);
  const journal = JSON.parse(await readFile(join(root, 'exploratory-paper', 'trade-journal.json'), 'utf8'));
  assert.equal(journal.contract, 'exploratory-paper-trade-journal/v1');
  assert.equal(Object.keys(journal.trades).length, first.totals.trades);
  // The watch list shrinks (symbol dropped): its trades vanish from the recomputation but stay in the journal.
  const second = await runExploratoryPaperLedgerV1({ stateRoot: root, lanes: [KR], watchUniverse: { YAHOO_KR_1D: symbols.slice(0, 2) }, candleFetcher,
    now: () => new Date(nowMs + 60_000).toISOString() });
  assert.ok(second.totals.trades < first.totals.trades);
  assert.equal(second.journal.recorded, first.totals.trades, 'journal keeps every trade ever recorded');
  assert.equal(second.journal.vanished, first.totals.trades - second.totals.trades);
  assert.match(formatExploratoryPaperReportKoV1(second), /거래 기록 원장: 누적 \d+건/u);
  assert.match(formatExploratoryPaperReportKoV1(second), /재계산에서 사라진 거래/u);
});

test('rule files that claim order authority or live trading are refused before anything runs', async (t) => {
  assert.equal(assertPaperOnlyRulesV1([{ ruleId: 'x' }, { ruleId: 'y', executionAuthority: 'NONE' }]), true);
  assert.throws(() => assertPaperOnlyRulesV1([{ ruleId: 'x', executionAuthority: 'LIVE' }], 'user-rules'), /EXPLORATORY_PAPER_AUTHORITY_INVALID:user-rules/u);
  assert.throws(() => assertPaperOnlyRulesV1([{ ruleId: 'x', realOrder: true }]), /EXPLORATORY_PAPER_AUTHORITY_INVALID/u);
  assert.throws(() => assertPaperOnlyRulesV1([{ ruleId: 'x', autoTrading: true }]), /EXPLORATORY_PAPER_AUTHORITY_INVALID/u);
  const root = await tempRoot(t);
  await mkdir(join(root, 'exploratory-paper'), { recursive: true });
  await writeFile(join(root, 'exploratory-paper', 'user-rules.json'), JSON.stringify({ rules: [{ laneId: 'KR_STOCK_LONG', ruleId: 'w1', executionAuthority: 'ORDER' }] }));
  await assert.rejects(runExploratoryPaperLedgerV1({ stateRoot: root, lanes: [KR], watchUniverse: { YAHOO_KR_1D: [] }, candleFetcher: async () => [] }),
    /EXPLORATORY_PAPER_AUTHORITY_INVALID:user-rules/u);
});
