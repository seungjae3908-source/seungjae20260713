import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { gridDcaForPeriodV1, runGridDcaResearchV1 } from '../src/grid-dca-research-v1.mjs';

function hourly(start, end, f) {
  const out = []; let prev = f(start);
  for (let t = start; t < end; t += 3_600_000) {
    const close = f(t); const open = prev;
    out.push({ timestamp: t, open, close, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, volume: 1 });
    prev = close;
  }
  return out;
}

test('grid bounds come from the previous quarter; a crash shows up as tail loss', () => {
  const start = Date.UTC(2024, 9, 1); const end = Date.UTC(2026, 0, 1);
  const candles = hourly(start, end, (t) => (t < Date.UTC(2025, 9, 1) ? 100 + (10 * Math.sin(t / 3e8)) : 100 * (0.9995 ** ((t - Date.UTC(2025, 9, 1)) / 3_600_000))));
  const result = gridDcaForPeriodV1(candles, { start: Date.UTC(2025, 0, 1), end });
  assert.equal(result.status, 'OK');
  assert.ok(result.grid.quarters.length >= 3);
  assert.ok(result.grid.worstQuarterReturn < 0, 'the trend-down quarter loses');
  assert.ok(result.dca.worstUnrealizedLoss < 0);
});

test('research job runs at most once a day and never touches the 2026 holdout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'grid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'combination-research', 'datasets', 'UPBIT_1H'), { recursive: true });
  const candles = hourly(Date.UTC(2024, 9, 1), Date.UTC(2026, 2, 1), (ts) => 100 + (5 * Math.sin(ts / 2e8)));
  await writeFile(join(root, 'combination-research', 'datasets', 'UPBIT_1H', 'KRW-BTC.json'), JSON.stringify({ candles }));
  const first = await runGridDcaResearchV1({ stateRoot: root, now: () => '2026-10-17T00:00:00.000Z', policy: { ...(await import('../src/grid-dca-research-v1.mjs')).GRID_DCA_POLICY_V1, symbols: ['KRW-BTC'] } });
  assert.equal(first.results[0].validation2025.status, 'OK');
  assert.equal(first.results[0].forward.status, 'NO_DATA');
  const again = await runGridDcaResearchV1({ stateRoot: root, now: () => '2026-10-17T05:00:00.000Z' });
  assert.equal(again.status, 'NOT_DUE');
});
