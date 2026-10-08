import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve('ops/verify-paper-forward-genuine-cost-window.mjs');
const runAt = (iso) => spawnSync(
  process.execPath,
  [script, `--now-ms=${Date.parse(iso)}`],
  { encoding: 'utf8' },
);

test('fails before protected Production approval while the frozen cohort is TRAIN-only', () => {
  const result = runAt('2026-10-07T00:00:00.000Z');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PAPER_FORWARD_GENUINE_COST_WINDOW_NOT_ELIGIBLE:TRAIN/u);
  assert.match(result.stderr, /OOS_START=2026-10-26T15:17:00.000Z/u);
});

test('still fails during Validation because genuine OOS cost evidence is impossible', () => {
  const result = runAt('2026-10-20T00:00:00.000Z');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PAPER_FORWARD_GENUINE_COST_WINDOW_NOT_ELIGIBLE:VALIDATION/u);
});

test('allows evidence preparation checks only after OOS collection begins', () => {
  const result = runAt('2026-10-27T00:00:00.000Z');
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.phase, 'OOS_COLLECTING');
  assert.equal(value.actualCostEvidenceStillRequired, true);
  assert.equal(value.inventedCostAllowed, false);
  assert.equal(value.executionAuthority, 'NONE');
});
