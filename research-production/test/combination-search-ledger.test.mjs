import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RESEARCH_LANES_V2 } from '../src/autonomous-research-discovery-v2.mjs';
import {
  COMBINATION_EXIT_PROFILES_V1,
  COMBINATION_UNIVERSE_V1,
  combinationSymbolCostV1,
  formatCombinationReportKoV1,
  planBaseTrialsV1,
  runCombinationSearchLaneV1,
} from '../src/combination-search-lane-v1.mjs';
import { cumulativeTrialsV1, readTrialLedgerV1 } from '../src/trial-ledger-v1.mjs';

const LANE = (id) => RESEARCH_LANES_V2.find((lane) => lane.id === id);
const smallUniverse = (symbols) => Object.freeze(Object.fromEntries(Object.entries(COMBINATION_UNIVERSE_V1)
  .map(([key, spec]) => [key, Object.freeze({ ...spec, symbols: Object.freeze(symbols ?? spec.symbols.slice(0, 5)) })])));

function daily(n, seed, start = Date.UTC(2021, 0, 4)) {
  let s = seed; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out = []; let price = 100;
  for (let i = 0; i < n; i += 1) {
    const open = price; const close = Math.max(1, open * (1 + ((rnd() - 0.5) * 0.03)));
    out.push({ timestamp: start + (i * 86_400_000), open, close, high: Math.max(open, close) * 1.004, low: Math.min(open, close) * 0.996, volume: 1000 + (rnd() * 100) });
    price = close;
  }
  return out;
}

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'combination-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('every exit profile is planned: plain X1/X2 plus trailing X3 and scale-out X4', () => {
  const plan = planBaseTrialsV1(LANE('CRYPTO_FUTURES_LONG'));
  const ids = new Set(plan.map((row) => row.exitId));
  assert.deepEqual([...ids].sort(), COMBINATION_EXIT_PROFILES_V1.map((row) => row.id).sort());
  assert.equal(plan.length % COMBINATION_EXIT_PROFILES_V1.length, 0);
});

test('liquidity impact raises the cost of thin names only', () => {
  const lane = LANE('KR_STOCK_LONG');
  const base = combinationSymbolCostV1(lane, '005930');
  const deep = combinationSymbolCostV1(lane, '005930', { medianDailyValue: 1e12, dailyVolatility: 0.02 });
  const thin = combinationSymbolCostV1(lane, '005930', { medianDailyValue: 2e8, dailyVolatility: 0.04 });
  assert.ok(deep.slippageRate - base.slippageRate < 0.0001);
  assert.ok(thin.slippageRate - base.slippageRate > 0.005);
  assert.equal(thin.taxRate, base.taxRate);
});

test('a new experiment on the same data inherits the earlier trial count; integrity failures are excluded', async (t) => {
  const root = await tempRoot(t);
  const lane = LANE('KR_STOCK_LONG');
  const datasetLoader = async ({ source, symbol }) => {
    const candles = daily(900, (Number(symbol) % 997) + 3);
    // One symbol has duplicated rows: it must never reach a backtest.
    if (symbol === '000660') candles.splice(300, 0, candles[300]);
    return { source, symbol, timeframe: '1d', candles };
  };
  const firstUniverse = smallUniverse(['069500', '229200', '005930', '000660', '035420', '005380']);
  let first;
  for (let tick = 0; tick < 30; tick += 1) {
    first = await runCombinationSearchLaneV1({ stateRoot: root, universe: firstUniverse, lanes: [lane], datasetLoader,
      maximumFetchesPerTick: 10, budgetMs: 600_000, now: () => `2026-10-15T00:${String(tick).padStart(2, '0')}:00.000Z` });
    if (first.lanes[0].searchExhausted) break;
  }
  assert.ok(first.datasetLog.some((line) => line.includes('000660:INTEGRITY_FAIL')) || (await readFile(join(root, 'combination-research', 'lanes', lane.id, 'state.json'), 'utf8')).includes('"integrity"'));
  const state = JSON.parse(await readFile(join(root, 'combination-research', 'lanes', lane.id, 'state.json'), 'utf8'));
  assert.ok(!Object.keys(state.integrity).includes('000660'));
  const ledger1 = await readTrialLedgerV1(root);
  const trialsFirst = cumulativeTrialsV1(ledger1, 'YAHOO_KR_1D');
  assert.equal(trialsFirst, Object.keys(state.trials).length);
  assert.equal(first.lanes[0].priorTrials, 0);

  // Different symbol set = a different experiment on the same source.
  const secondUniverse = smallUniverse(['069500', '229200', '005930', '035420', '005380', '000270']);
  const second = await runCombinationSearchLaneV1({ stateRoot: root, universe: secondUniverse, lanes: [lane], datasetLoader,
    maximumFetchesPerTick: 10, budgetMs: 600_000, now: () => '2026-10-15T01:00:00.000Z' });
  assert.equal(second.lanes[0].priorTrials, trialsFirst, 'earlier experiment counted in the FDR denominator');
  assert.ok(second.lanes[0].cumulativeTrials > trialsFirst);
  const text = formatCombinationReportKoV1(second);
  assert.match(text, /누적 시도\(같은 데이터, 이전 실험 포함\)/u);
  const ledger2 = await readTrialLedgerV1(root);
  assert.equal(Object.keys(ledger2.sources.YAHOO_KR_1D.experiments).length, 2);
});
