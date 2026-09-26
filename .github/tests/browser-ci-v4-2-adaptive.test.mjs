import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectRuntimeLine } from '../scripts/browser-runtime-lane-runner.mjs';
import { adaptWeights } from '../scripts/browser-adaptive-weights.mjs';

test('runtime lane parser captures file durations and summary counts', () => {
  const state = {
    discoveredTests: null,
    observedTestLines: 0,
    passed: null,
    skipped: null,
    files: {},
  };
  collectRuntimeLine(state, 'Running 2 tests using 1 worker');
  collectRuntimeLine(state, '  ✓  1 e2e/a.spec.ts:10:1 › alpha (1.2s)');
  collectRuntimeLine(state, '  ✓  2 e2e/a.spec.ts:20:1 › beta (45ms)');
  collectRuntimeLine(state, '  2 passed (1.3s)');
  assert.equal(state.discoveredTests, 2);
  assert.equal(state.observedTestLines, 2);
  assert.equal(state.passed, 2);
  assert.equal(state.files['a.spec.ts'].observedTests, 2);
  assert.equal(state.files['a.spec.ts'].durationSeconds, 1.245);
});

test('adaptive weights use bounded EWMA and reject failed telemetry', () => {
  const base = {
    defaultSeconds: 5,
    weightsSeconds: { 'a.spec.ts': 10, 'b.spec.ts': 20, 'c.spec.ts': 5 },
  };
  const common = { schemaVersion: 1, runId: 123, sourceSha: 'a'.repeat(40), exitCode: 0 };
  const telemetry = [
    { ...common, lane: 1, files: { 'a.spec.ts': { durationSeconds: 100 } } },
    { ...common, lane: 2, files: { 'b.spec.ts': { durationSeconds: 2 } } },
    { ...common, lane: 3, files: { 'c.spec.ts': { durationSeconds: 8 } } },
    { ...common, lane: 4, files: {} },
  ];
  const next = adaptWeights(base, telemetry, ['a.spec.ts', 'b.spec.ts', 'c.spec.ts'], 0.5);
  assert.equal(next.schemaVersion, 2);
  assert.equal(next.strategy, 'EWMA_CLAMPED_V1');
  assert.equal(next.weightsSeconds['a.spec.ts'], 15);
  assert.equal(next.weightsSeconds['b.spec.ts'], 15);
  assert.equal(next.weightsSeconds['c.spec.ts'], 6.5);
  assert.equal(next.source.updatedSpecCount, 3);

  const failed = telemetry.map((entry) => ({ ...entry }));
  failed[0] = { ...failed[0], exitCode: 1 };
  assert.throws(() => adaptWeights(base, failed, ['a.spec.ts', 'b.spec.ts', 'c.spec.ts'], 0.5), /FAILED_BROWSER_TELEMETRY_NOT_CREDITABLE/u);
});

test('workflow consumes adaptive weights only from successful main push runs', async () => {
  const workflow = await readFile('.github/workflows/futures-public-network-smoke.yml', 'utf8');
  assert.match(workflow, /^  browser-ui-weights:/mu);
  assert.match(workflow, /branch:\s*'main'/u);
  assert.match(workflow, /event:\s*'push'/u);
  assert.match(workflow, /status:\s*'success'/u);
  assert.match(workflow, /browser-runtime-weights-next-/u);
  assert.match(workflow, /No prior successful main adaptive Browser weights/u);
  assert.match(workflow, /REPOSITORY_BASELINE/u);
  assert.match(workflow, /ADAPTIVE_MAIN_ARTIFACT/u);
});

test('adaptive telemetry is credited only after all Browser shards succeed', async () => {
  const workflow = await readFile('.github/workflows/futures-public-network-smoke.yml', 'utf8');
  assert.match(workflow, /^  browser-runtime-adapt:/mu);
  assert.match(workflow, /needs\.browser-ui-shard\.result == 'success'/u);
  assert.match(workflow, /needs\.browser-ui-result\.result == 'success'/u);
  assert.match(workflow, /browser-runtime-telemetry-\$\{\{ github\.run_id \}\}-lane-\*/u);
  assert.match(workflow, /browser-adaptive-weights\.mjs/u);
  assert.match(workflow, /--alpha 0\.5/u);
  assert.match(workflow, /retention-days:\s*30/u);
});

test('adaptive Browser system never mutates repository state or weakens Required CI', async () => {
  const workflow = await readFile('.github/workflows/futures-public-network-smoke.yml', 'utf8');
  const fast = await readFile('.github/workflows/application-fast-ci.yml', 'utf8');
  assert.match(workflow, /contents:\s*read/u);
  assert.doesNotMatch(workflow, /contents:\s*write/u);
  assert.doesNotMatch(workflow, /git\s+push/u);
  assert.doesNotMatch(workflow, /createOrUpdateFileContents/u);
  assert.match(workflow, /browser-ui\/verified/u);
  assert.match(fast, /node --test \.github\/tests\/browser-ci-v4\*\.test\.mjs/u);
  assert.doesNotMatch(workflow, /REAL_ORDER_ENABLED\s*:\s*true/u);
  assert.doesNotMatch(workflow, /AUTO_TRADING\s*:\s*true/u);
});
