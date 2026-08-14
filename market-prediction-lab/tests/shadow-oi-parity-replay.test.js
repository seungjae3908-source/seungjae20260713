import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const outputPath = resolve('docs/shadow-oi-parity-replay.json');

test('OI parity replay re-scores immutable Shadow records without network, tuning, or state mutation', async () => {
  await rm(outputPath, { force: true });
  const result = spawnSync(process.execPath, [
    'scripts/run-shadow-oi-parity-replay.js',
    'docs/shadow-state.json',
    'docs/shadow-oi-parity-replay.json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(`parity replay failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  const payload = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(payload.mode, 'counterfactual-replay-remove-open-interest-change');
  assert.equal(payload.selectionOrTuningUsed, false);
  assert.equal(payload.finalHoldoutUsed, false);
  assert.equal(payload.modelRetrained, false);
  assert.equal(payload.thresholdChanged, false);
  assert.equal(payload.classWeightChanged, false);
  assert.deepEqual(payload.safety, {
    publicNetworkRequests: 0,
    privateAccountRequests: 0,
    actualOrders: 0,
    writesSourceState: false,
    executionAuthority: 'NONE',
  });

  for (const groupName of ['crypto-futures-15m', 'crypto-futures-1h']) {
    const group = payload.groups[groupName];
    assert.ok(group, `${groupName} result is required`);
    assert.ok(group.totalCurrentModelRecords > 0, `${groupName} must contain current-model Shadow records`);
    assert.ok(group.settled > 0, `${groupName} must contain settled records`);
    assert.ok(group.originalOiKnownCount > 0, `${groupName} must prove OI was present in historical Shadow inference`);
    assert.equal(
      Object.values(group.originalPredicted).reduce((sum, value) => sum + value, 0),
      group.totalCurrentModelRecords,
    );
    assert.equal(
      Object.values(group.parityPredicted).reduce((sum, value) => sum + value, 0),
      group.totalCurrentModelRecords,
    );
    assert.ok(group.originalMetrics?.sampleCount > 0);
    assert.equal(group.originalMetrics.sampleCount, group.parityMetrics?.sampleCount);
  }

  console.log('SHADOW_OI_PARITY_REPLAY_RESULT');
  console.log(JSON.stringify(payload));
});
