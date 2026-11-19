import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { benjaminiHochbergV1 } from '../src/combination-search-lane-v1.mjs';
import {
  benjaminiHochbergCumulativeV1,
  cumulativeTrialsV1,
  deflatedSharpeFromStatsV1,
  deflatedSharpeProbabilityV1,
  expectedMaxSharpeV1,
  holdoutAllowedV1,
  normalCdfV1,
  normalQuantileV1,
  priorTrialsExcludingV1,
  readTrialLedgerV1,
  recordExperimentTrialsV1,
  recordHoldoutUseV1,
  trialLedgerPathV1,
  writeTrialLedgerV1,
} from '../src/trial-ledger-v1.mjs';

test('cumulative BH equals plain BH when no earlier experiments exist', () => {
  const p = [0.001, 0.02, 0.5, 0.04, 1, 0.003];
  assert.deepEqual(benjaminiHochbergCumulativeV1(p, p.length), benjaminiHochbergV1(p));
});

test('earlier experiments on the same data make every q-value stricter, never looser', () => {
  const p = [0.0004, 0.002, 0.01, 0.2];
  const plain = benjaminiHochbergCumulativeV1(p);
  const cumulative = benjaminiHochbergCumulativeV1(p, 4000);
  cumulative.forEach((q, i) => assert.ok(q >= plain[i]));
  // A rule that passes alone (q <= 0.10) fails once 4,000 earlier tries are counted.
  assert.ok(plain[0] <= 0.10);
  assert.ok(cumulative[0] > 0.10);
});

test('ledger counts never decrease and are summed per data source', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'trial-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = await readTrialLedgerV1(root);
  recordExperimentTrialsV1(ledger, { source: 'BITGET_1H', laneId: 'L', experimentKey: 'a', trials: 100, observedAt: 't1' });
  recordExperimentTrialsV1(ledger, { source: 'BITGET_1H', laneId: 'S', experimentKey: 'b', trials: 50, observedAt: 't1' });
  recordExperimentTrialsV1(ledger, { source: 'UPBIT_1H', laneId: 'U', experimentKey: 'c', trials: 7, observedAt: 't1' });
  recordExperimentTrialsV1(ledger, { source: 'BITGET_1H', laneId: 'L', experimentKey: 'a', trials: 10, observedAt: 't2' });
  assert.equal(cumulativeTrialsV1(ledger, 'BITGET_1H'), 150);
  assert.equal(priorTrialsExcludingV1(ledger, 'BITGET_1H', 'a'), 50);
  await writeTrialLedgerV1(root, ledger);
  const again = await readTrialLedgerV1(root);
  assert.equal(cumulativeTrialsV1(again, 'BITGET_1H'), 150);
  assert.equal(cumulativeTrialsV1(again, 'UPBIT_1H'), 7);
});

test('a corrupt ledger fails closed instead of silently resetting to zero', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'trial-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'combination-research'), { recursive: true });
  await writeFile(trialLedgerPathV1(root), '{not json');
  await assert.rejects(() => readTrialLedgerV1(root), /TRIAL_LEDGER_CORRUPT/u);
});

test('holdout budget is per source, never refilled, and a trial is charged once', () => {
  const ledger = { contract: 'combination-trial-ledger/v1', sources: {}, holdoutUses: [] };
  const policy = { holdoutChecksPerSource: 2 };
  assert.equal(holdoutAllowedV1(ledger, { source: 'S', trialId: 'x', policy }).allowed, true);
  recordHoldoutUseV1(ledger, { source: 'S', laneId: 'L', trialId: 'x', observedAt: 't', pass: false });
  recordHoldoutUseV1(ledger, { source: 'S', laneId: 'L', trialId: 'x', observedAt: 't', pass: false });
  recordHoldoutUseV1(ledger, { source: 'S', laneId: 'L', trialId: 'y', observedAt: 't', pass: true });
  assert.equal(ledger.holdoutUses.length, 2);
  assert.equal(holdoutAllowedV1(ledger, { source: 'S', trialId: 'z', policy }).allowed, false);
  assert.equal(holdoutAllowedV1(ledger, { source: 'S', trialId: 'x', policy }).reused, true);
  assert.equal(holdoutAllowedV1(ledger, { source: 'OTHER', trialId: 'z', policy }).allowed, true);
});

test('normal helpers are accurate', () => {
  assert.ok(Math.abs(normalCdfV1(1.959964) - 0.975) < 1e-6);
  assert.ok(Math.abs(normalQuantileV1(0.975) - 1.959964) < 1e-5);
  assert.ok(Math.abs(normalQuantileV1(0.001) + 3.090232) < 1e-5);
});

test('deflated Sharpe: more trials raise the luck benchmark and lower the probability', () => {
  const few = expectedMaxSharpeV1(10, 0.01);
  const many = expectedMaxSharpeV1(10_000, 0.01);
  assert.ok(many > few && few > 0);
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const returns = Array.from({ length: 300 }, () => 0.002 + ((rnd() - 0.5) * 0.04));
  const a = deflatedSharpeProbabilityV1({ returns, trials: 5, sharpeVariance: 1 / 300 });
  const b = deflatedSharpeProbabilityV1({ returns, trials: 5000, sharpeVariance: 1 / 300 });
  assert.ok(a.probability > b.probability);
  const stats = deflatedSharpeFromStatsV1({ sharpe: a.sharpe, n: 300, trials: 5000, sharpeVariance: 1 / 300 });
  assert.ok(Math.abs(stats.probability - b.probability) < 0.1);
});
