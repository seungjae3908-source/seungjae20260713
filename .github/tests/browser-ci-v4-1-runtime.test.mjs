import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { buildRuntimeWeightedPlan, verifyPlan, IGNORED_SPECS } from '../scripts/browser-runtime-shard-plan.mjs';

test('runtime weight evidence is provenance-bound and non-authoritative', async () => {
  const weights = JSON.parse(await readFile('.github/fixtures/browser-runtime-weights-v1.json', 'utf8'));
  assert.equal(weights.schemaVersion, 1);
  assert.equal(weights.source.workflowRunId, 35371358470);
  assert.equal(weights.source.workflowJobId, 105685926245);
  assert.equal(weights.source.sourceSha, 'd6a5f78c1cbf8280370dfcd2d3bd0fe30204affe');
  assert.equal(weights.source.observedTests, 849);
  assert.equal(weights.source.observedRuntimeMinutes, 20.8);
  assert.match(weights.source.note, /grants no test pass credit/u);
  assert.ok(weights.defaultSeconds > 0);
  assert.ok(Object.keys(weights.weightsSeconds).length >= 190);
});

test('runtime-weighted plan covers every canonical Browser spec exactly once', async () => {
  const weights = JSON.parse(await readFile('.github/fixtures/browser-runtime-weights-v1.json', 'utf8'));
  const specs = (await readdir('stock-analyzer/e2e', { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts') && !IGNORED_SPECS.has(entry.name))
    .map((entry) => entry.name)
    .sort();

  const lanes = buildRuntimeWeightedPlan(specs, weights, 4);
  const verification = verifyPlan(specs, lanes);

  assert.equal(verification.specCount, specs.length);
  assert.equal(verification.laneCount, 4);
  assert.ok(specs.length >= 199);
  assert.ok(verification.imbalanceRatio <= 1.10, `imbalance ratio ${verification.imbalanceRatio}`);

  const assigned = lanes.flatMap((lane) => lane.files);
  assert.equal(assigned.length, specs.length);
  assert.equal(new Set(assigned).size, specs.length);
  assert.deepEqual([...IGNORED_SPECS], ['production-readonly-smoke.spec.ts']);
});

test('heavy historical specs are spread across distinct runtime-weighted lanes', async () => {
  const weights = JSON.parse(await readFile('.github/fixtures/browser-runtime-weights-v1.json', 'utf8'));
  const specs = (await readdir('stock-analyzer/e2e', { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts') && !IGNORED_SPECS.has(entry.name))
    .map((entry) => entry.name)
    .sort();

  const lanes = buildRuntimeWeightedPlan(specs, weights, 4);
  const owner = new Map(lanes.flatMap((lane) => lane.files.map((file) => [file, lane.lane])));
  const heavy = [
    'final-acceptance-responsive-account.spec.ts',
    'market-information-search-p0.spec.ts',
    'signal-scanner.spec.ts',
    'research-copilot.spec.ts',
  ];
  assert.equal(new Set(heavy.map((file) => owner.get(file))).size, 4);
});

test('workflow consumes planner-selected files and never falls back to Playwright count sharding', async () => {
  const workflow = await readFile('.github/workflows/futures-public-network-smoke.yml', 'utf8');
  assert.match(workflow, /Verify runtime-weighted browser shard plan/u);
  assert.match(workflow, /Select runtime-weighted browser shard/u);
  assert.match(workflow, /browser-runtime-shard-specs\.txt/u);
  assert.match(workflow, /browser_specs\[@\]/u);
  assert.match(workflow, /--retries=0/u);
  assert.doesNotMatch(workflow, /--shard=/u);
});
