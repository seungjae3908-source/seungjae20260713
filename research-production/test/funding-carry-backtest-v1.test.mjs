import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FUNDING_CARRY_VARIANTS_V1,
  evaluateFundingCarryV1,
  formatFundingCarryReportKoV1,
  roundTripCostV1,
  runFundingCarryBacktestV1,
  simulateFundingCarryV1,
} from '../src/funding-carry-backtest-v1.mjs';

const H8 = 8 * 3_600_000;
const START = Date.UTC(2024, 0, 1);
const rows = (rates) => rates.map((rate, i) => ({ timestamp: START + (i * H8), rate }));
const v = (id) => FUNDING_CARRY_VARIANTS_V1.find((row) => row.id === id);

test('round trip charges four legs of fee and slippage', () => {
  assert.ok(Math.abs(roundTripCostV1() - (0.002 + 0.0012 + 0.002)) < 1e-12);
});

test('always-on collects every print minus one round trip', () => {
  const { events, trades } = simulateFundingCarryV1(rows(Array(30).fill(0.0001)), v('ALWAYS'));
  const total = events.reduce((s, e) => s + e.pnl, 0);
  assert.equal(trades, 1);
  assert.ok(Math.abs(total - ((30 * 0.0001) - roundTripCostV1())) < 1e-12);
});

test('threshold variant decides on past prints only and leaves when funding turns negative', () => {
  const rates = [...Array(9).fill(0.0003), ...Array(20).fill(0.0003), ...Array(15).fill(-0.0004), ...Array(10).fill(-0.0004)];
  const { events, trades } = simulateFundingCarryV1(rows(rates), v('AVG3D_1BP'));
  assert.equal(events[8].inPosition, false, 'needs 9 prior prints');
  assert.equal(events[9].inPosition, true);
  assert.equal(trades, 1);
  const negativeHeld = events.filter((e, i) => e.inPosition && rates[i] < 0).length;
  assert.ok(negativeHeld <= 9, `held through ${negativeHeld} negative prints`);
  assert.equal(events.at(-1).inPosition, false);
});

test('evaluation splits by time and only calls a threshold variant viable when it pays after costs', () => {
  const good = Array.from({ length: 6 }, (_, k) => ({ symbol: `S${k}`, source: 'BITGET',
    rows: rows(Array.from({ length: 900 }, (_, i) => (Math.floor(i / 60) % 3 === 2 ? -0.0001 : 0.0003))) }));
  const r = evaluateFundingCarryV1({ datasets: good });
  assert.equal(r.verdict.status, 'VIABLE');
  assert.ok(r.verdict.validationAnnualizedMean > 0);
  const flat = Array.from({ length: 6 }, (_, k) => ({ symbol: `F${k}`, source: 'BITGET', rows: rows(Array(900).fill(0.00002)) }));
  assert.equal(evaluateFundingCarryV1({ datasets: flat }).verdict.status, 'NOT_VIABLE');
});

test('runner reads cached funding, ignores 2026 prints and reports in Korean', async () => {
  const root = await mkdtemp(join(tmpdir(), 'carry-'));
  try {
    for (let k = 0; k < 4; k += 1) {
      const funding = rows(Array(700).fill(0.00025));
      funding.push({ timestamp: Date.UTC(2026, 0, 2), rate: 5 });
      const path = join(root, 'combination-research', 'datasets', 'BITGET_1H', `C${k}USDT.json`);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, JSON.stringify({ symbol: `C${k}USDT`, fundingSource: 'BINANCE_PROXY', fundingRates: funding }));
    }
    const result = await runFundingCarryBacktestV1({ stateRoot: root, now: () => '2026-10-18T00:00:00.000Z' });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.holdoutRead, false);
    assert.ok(result.variants.every((v) => Math.abs(v.validationAnnualizedMean) < 2), 'a 2026 print of 500% would explode returns');
    assert.match(formatFundingCarryReportKoV1(result), /펀딩비 차익/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
