import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  COMBINATION_ATOMS_V1,
  atomsForDirectionV1,
  computeCombinationAtomsV1,
} from '../src/combination-atoms-v1.mjs';
import {
  benjaminiHochbergV1,
  classifyLaneTrialsV1,
  evaluateCombinationTrialV1,
  formatCombinationReportKoV1,
  planBaseTrialsV1,
  planTripleTrialsV1,
  runCombinationSearchLaneV1,
} from '../src/combination-search-lane-v1.mjs';
import { RESEARCH_LANES_V2 } from '../src/autonomous-research-discovery-v2.mjs';

const LANE = (id) => RESEARCH_LANES_V2.find((lane) => lane.id === id);

function randomWalk(n, { seed = 1, start = Date.UTC(2024, 6, 1), step = 3_600_000 } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    const open = price;
    const close = Math.max(1, open + ((rnd() - 0.5) * 0.02 * open));
    out.push({ timestamp: start + (i * step), open, close,
      high: Math.max(open, close) * (1 + (rnd() * 0.005)), low: Math.min(open, close) * (1 - (rnd() * 0.005)), volume: 100 + (rnd() * 100) });
    price = close;
  }
  return out;
}

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'combination-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('atoms never look ahead: a prefix gives identical values at every prefix index', () => {
  const candles = randomWalk(900, { seed: 11 });
  const full = computeCombinationAtomsV1(candles, { timeframe: '1h' });
  for (const cut of [300, 457, 650]) {
    const prefix = computeCombinationAtomsV1(candles.slice(0, cut), { timeframe: '1h' });
    for (const atom of COMBINATION_ATOMS_V1) {
      const a = full.get(atom.id).slice(0, cut);
      assert.deepEqual([...prefix.get(atom.id)], [...a], `${atom.id} changed when future candles were added (cut ${cut})`);
    }
  }
});

test('atoms recognise an engineered bullish engulfing candle', () => {
  const candles = randomWalk(120, { seed: 3 });
  const i = 100;
  const p = candles[i - 1];
  candles[i - 1] = { ...p, open: 101, close: 99, high: 101.2, low: 98.8 };
  candles[i] = { ...candles[i], open: 98.9, close: 101.5, high: 101.6, low: 98.7 };
  const atoms = computeCombinationAtomsV1(candles, { timeframe: '1h' });
  assert.equal(atoms.get('C_BULLISH_ENGULFING')[i], 1);
  assert.equal(atoms.get('C_BEARISH_ENGULFING')[i], 0);
});

test('every library family is represented and short lanes never receive long-only atoms', () => {
  const families = new Set(COMBINATION_ATOMS_V1.map((atom) => atom.family));
  for (const family of ['TREND', 'MOMENTUM', 'VOLATILITY', 'VOLUME', 'CANDLE', 'WAVE', 'PATTERN']) assert.ok(families.has(family), family);
  assert.ok(atomsForDirectionV1('SHORT').every((atom) => atom.side !== 'LONG'));
  assert.ok(atomsForDirectionV1('LONG').every((atom) => atom.side !== 'SHORT'));
});

test('base plan is deterministic, cross-family and always directional', () => {
  const lane = LANE('CRYPTO_FUTURES_SHORT');
  const a = planBaseTrialsV1(lane);
  const b = planBaseTrialsV1(lane);
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map((row) => row.trialId)).size, a.length);
  const byId = new Map(COMBINATION_ATOMS_V1.map((atom) => [atom.id, atom]));
  for (const trial of a) {
    const atoms = trial.atoms.map((id) => byId.get(id));
    assert.ok(atoms.some((atom) => atom.side === 'SHORT'), trial.atoms.join('+'));
    if (atoms.length === 2) assert.notEqual(atoms[0].family, atoms[1].family);
  }
  assert.ok(a.some((trial) => trial.atoms.some((id) => id.startsWith('W_')) && trial.atoms.some((id) => id.startsWith('M_'))), 'formula + wave');
  assert.ok(a.some((trial) => trial.atoms.some((id) => id.startsWith('P_')) && trial.atoms.some((id) => id.startsWith('T_'))), 'formula + chart pattern');
});

test('triples extend pairs selected on discovery evidence only', () => {
  const lane = LANE('US_STOCK_LONG');
  const pair = planBaseTrialsV1(lane).find((row) => row.atoms.length === 2);
  const trials = { [pair.trialId]: { ...pair, discovery: { trades: 60, meanReturn: 0.002 }, validation: { trades: 50, meanReturn: -0.5 } } };
  const triples = planTripleTrialsV1(lane, trials);
  assert.ok(triples.length > 0);
  assert.ok(triples.every((row) => row.atoms.length === 3 && pair.atoms.every((id) => row.atoms.includes(id))));
});

test('Benjamini-Hochberg q-values are monotone and conservative', () => {
  const q = benjaminiHochbergV1([0.001, 0.01, 0.03, 0.5, 1]);
  assert.ok(Math.abs(q[0] - 0.005) < 1e-12);
  assert.ok(q.every((value, index) => index === 0 || value >= q[index - 1] - 1e-12));
  assert.ok(q.every((value) => value <= 1));
});

test('classification requires FDR, breadth, walk-forward and enough symbols', () => {
  const base = { status: 'WATCH', atoms: ['T_CLOSE_ABOVE_SMA50'], validation: { profitFactor: 1.5 }, symbolBreadth: 0.8, walkForward: { positiveWindows: 4 } };
  const trials = { a: { ...base, trialId: 'a', pValue: 0.0001 }, b: { ...base, trialId: 'b', pValue: 0.0001, symbolBreadth: 0.4 } };
  for (let k = 0; k < 20; k += 1) trials[`r${k}`] = { ...base, trialId: `r${k}`, status: 'REJECT', pValue: 1 };
  const baselines = { X1: { validation: { meanReturn: 0.001 } } };
  base.exitId = 'X1';
  for (const row of Object.values(trials)) { row.exitId = 'X1'; row.validation = { profitFactor: 1.5, meanReturn: 0.004 }; }
  const out = Object.fromEntries(classifyLaneTrialsV1(trials, { symbolCount: 5, baselines }).map((row) => [row.trialId, row.finalStatus]));
  assert.equal(out.a, 'SURVIVOR');
  assert.equal(out.b, 'WATCH');
  const few = Object.fromEntries(classifyLaneTrialsV1(trials, { symbolCount: 2, baselines }).map((row) => [row.trialId, row.finalStatus]));
  assert.equal(few.a, 'WATCH');
  // A bull market lifts every long entry: not beating "just be in the market" is not a pass.
  const bull = Object.fromEntries(classifyLaneTrialsV1(trials, { symbolCount: 5, baselines: { X1: { validation: { meanReturn: 0.01 } } } }).map((row) => [row.trialId, row.finalStatus]));
  assert.equal(bull.a, 'WATCH');
});

test('lane runner is bounded per tick, persists progress, seals 2026 and finds no survivor in pure noise', async (t) => {
  const root = await tempRoot(t);
  const lane = LANE('CRYPTO_FUTURES_LONG');
  let calls = 0;
  const datasetLoader = async ({ source, symbol }) => {
    calls += 1;
    const seed = 100 + calls;
    // Includes candles after 2026-01-01 that must be dropped.
    return { source, symbol, timeframe: '1h', candles: randomWalk(2_600, { seed, start: Date.UTC(2025, 9, 1) }) };
  };
  let fakeNow = 0;
  const clock = () => { fakeNow += 25; return fakeNow; };
  const first = await runCombinationSearchLaneV1({ stateRoot: root, lanes: [lane], datasetLoader, clock, budgetMs: 2_000,
    maximumFetchesPerTick: 5, now: () => '2026-10-15T00:00:00.000Z' });
  assert.equal(calls, 5);
  const summary = first.lanes[0];
  assert.equal(summary.status, 'SEARCHING');
  assert.ok(summary.trialsEvaluated > 0 && summary.trialsEvaluated < summary.trialsPlanned, 'budget stops part-way');
  assert.equal(first.aiProviderCalls, 0);
  assert.equal(first.safety.executionAuthority, 'NONE');
  const cached = JSON.parse(await readFile(join(root, 'combination-research', 'datasets', 'BITGET_1H', 'BTCUSDT.json'), 'utf8'));
  assert.ok(cached.candles.some((row) => row.timestamp >= Date.UTC(2026, 0, 1)), 'fixture really contained holdout candles');

  let last = first;
  for (let tick = 0; tick < 40 && !last.lanes[0].searchExhausted; tick += 1) {
    last = await runCombinationSearchLaneV1({ stateRoot: root, lanes: [lane], datasetLoader, budgetMs: 600_000,
      now: () => '2026-10-15T00:10:00.000Z' });
  }
  assert.equal(calls, 5, 'datasets are cached, not re-downloaded');
  assert.equal(last.lanes[0].searchExhausted, true);
  assert.equal(last.lanes[0].survivors, 0, 'pure noise must not produce a survivor');
  const state = JSON.parse(await readFile(join(root, 'combination-research', 'lanes', lane.id, 'state.json'), 'utf8'));
  for (const trial of Object.values(state.trials)) {
    for (const row of trial.walkForward.windows) assert.ok(row.trades >= 0);
  }
});

test('missing data keeps the lane waiting instead of testing on too few symbols', async (t) => {
  const root = await tempRoot(t);
  const lane = LANE('US_STOCK_LONG');
  const datasetLoader = async ({ source, symbol }) => {
    if (!['SPY', 'QQQ'].includes(symbol)) throw new Error('YAHOO_HTTP_404');
    return { source, symbol, timeframe: '1d', candles: randomWalk(800, { seed: symbol.length, step: 86_400_000, start: Date.UTC(2021, 0, 4) }) };
  };
  const result = await runCombinationSearchLaneV1({ stateRoot: root, lanes: [lane], datasetLoader, maximumFetchesPerTick: 10,
    now: () => '2026-10-15T00:00:00.000Z' });
  assert.equal(result.lanes[0].status, 'WAITING_FOR_DATA');
  assert.ok(result.datasetLog.some((line) => line.includes('FAILED:YAHOO_HTTP_404')));
  const again = await runCombinationSearchLaneV1({ stateRoot: root, lanes: [lane], datasetLoader, maximumFetchesPerTick: 10,
    now: () => '2026-10-15T00:10:00.000Z' });
  assert.ok(again.datasetLog.some((line) => line.endsWith('RETRY_LATER')), 'failed symbols back off for an hour');
});

test('Korean report explains progress, verdicts and data problems in plain words', async (t) => {
  const root = await tempRoot(t);
  const lane = LANE('KR_STOCK_LONG');
  const datasetLoader = async ({ source, symbol }) => {
    if (symbol === '035420') throw new Error('YAHOO_HTTP_404');
    return { source, symbol, timeframe: '1d', candles: randomWalk(900, { seed: Number(symbol) % 997 + 1, step: 86_400_000, start: Date.UTC(2021, 0, 4) }) };
  };
  const result = await runCombinationSearchLaneV1({ stateRoot: root, lanes: [lane], datasetLoader, maximumFetchesPerTick: 10,
    budgetMs: 600_000, now: () => '2026-10-15T00:00:00.000Z' });
  const text = formatCombinationReportKoV1(result);
  assert.match(text, /국내주식 매수 — 종목 4개/);
  assert.match(text, /합격 \d+ · 관찰 \d+ · 탈락 \d+/);
  assert.match(text, /035420: 실패 \(YAHOO_HTTP_404\)/);
  assert.match(text, /AI 사용 0회/);
  assert.match(text, /기준선\(조건 없이 아무 때나 진입\)/);
});

test('survivors get exactly one sealed-2026 holdout check, cached and reported in Korean', async (t) => {
  const root = await tempRoot(t);
  const lane = LANE('US_STOCK_LONG');
  const drift = (seed, start, n) => {
    let s = seed; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const out = []; let price = 100;
    for (let i = 0; i < n; i += 1) {
      const open = price; const close = Math.max(1, open * (1 + ((rnd() - 0.45) * 0.03)));
      out.push({ timestamp: start + (i * 86_400_000), open, close, high: Math.max(open, close) * 1.004, low: Math.min(open, close) * 0.996, volume: 100 + (rnd() * 100) });
      price = close;
    }
    return out;
  };
  let holdoutCalls = 0;
  const datasetLoader = async ({ source, symbol }) => ({ source, symbol, timeframe: '1d', candles: drift(symbol.length * 7 + 3, Date.UTC(2021, 0, 4), 1_700).filter((row) => row.timestamp < Date.UTC(2026, 0, 1)) });
  const holdoutLoader = async ({ source, symbol }) => { holdoutCalls += 1; return { source, symbol, timeframe: '1d', candles: drift(symbol.length * 11 + 5, Date.UTC(2026, 0, 1), 200) }; };
  // Loose policy so pure drift produces survivors; the holdout path is what is tested.
  const policy = { ...(await import('../src/combination-search-lane-v1.mjs')).COMBINATION_POLICY_V1,
    falseDiscoveryRate: 1, minimumProfitFactor: 0, minimumSymbolBreadth: 0, minimumPositiveWindows: 0 };
  const run = (at) => runCombinationSearchLaneV1({ stateRoot: root, lanes: [lane], datasetLoader, holdoutLoader, policy,
    maximumFetchesPerTick: 20, budgetMs: 600_000, now: () => at });
  const statePath = join(root, 'combination-research', 'lanes', lane.id, 'state.json');
  const first = await run('2026-10-15T00:00:00.000Z');
  const afterFirst = JSON.parse(await readFile(statePath, 'utf8')).holdout;
  assert.ok(Object.keys(afterFirst).length > 0);
  const second = await run('2026-10-15T00:10:00.000Z');
  assert.equal(holdoutCalls, 5, 'holdout candles fetched once per symbol');
  const afterSecond = JSON.parse(await readFile(statePath, 'utf8')).holdout;
  for (const [id, check] of Object.entries(afterFirst)) {
    assert.equal(check.oneTimeOnly, true);
    assert.equal(check.period.start, '2026-01-01');
    assert.deepEqual(afterSecond[id], check, 'a checked survivor is never re-evaluated');
  }
  const text = formatCombinationReportKoV1(second);
  assert.match(text, /2026 봉인 데이터 1회 확인/);
  assert.ok(first.lanes[0].holdoutChecked > 0);
});

test('futures backtests charge funding: heavy positive funding lowers long and raises short returns', () => {
  const candles = randomWalk(3_000, { seed: 7 });
  const atoms = computeCombinationAtomsV1(candles, { timeframe: '1h' });
  const first = candles[0].timestamp; const last = candles.at(-1).timestamp;
  const dataset = { symbol: 'BTCUSDT', candles, atoms, splitTime: first + Math.floor((last - first) * 0.6),
    windowEdges: [1, 2, 3].map((k) => first + Math.floor(((last - first) * k) / 4)) };
  const funding = [];
  for (let t = first; t <= last; t += 8 * 3_600_000) funding.push({ timestamp: t, rate: 0.003 });
  for (const [laneId, direction] of [['CRYPTO_FUTURES_LONG', 1], ['CRYPTO_FUTURES_SHORT', -1]]) {
    const lane = LANE(laneId);
    const trial = planBaseTrialsV1(lane).find((row) => {
      const r = evaluateCombinationTrialV1({ lane, trial: row, datasets: [dataset] });
      return r.discovery.trades >= 30;
    });
    assert.ok(trial, `${laneId}: a trial with enough trades exists on the synthetic series`);
    const without = evaluateCombinationTrialV1({ lane, trial, datasets: [dataset] });
    const withFunding = evaluateCombinationTrialV1({ lane, trial, datasets: [{ ...dataset, fundingRates: funding }] });
    assert.equal(withFunding.discovery.trades, without.discovery.trades);
    const delta = withFunding.discovery.meanReturn - without.discovery.meanReturn;
    assert.ok(direction * delta < 0, `${laneId}: funding must hurt the paying side and help the receiving side (delta ${delta})`);
  }
});
