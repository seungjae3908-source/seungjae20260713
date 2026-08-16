import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHistoricalPipelinePlan, HISTORICAL_PIPELINES, runHistoricalPipelines } from '../src/historical-pipelines.mjs';

const SHA = 'b'.repeat(40);

async function fakeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'historical-pipelines-'));
  const lab = join(root, 'market-prediction-lab');
  await mkdir(join(lab, 'scripts'), { recursive: true });
  await mkdir(join(lab, 'src'), { recursive: true });
  await writeFile(join(lab, 'package.json'), '{"type":"module"}\n');
  const scripts = new Set(HISTORICAL_PIPELINES.flatMap((p) => p.steps.map((s) => s.args[0])));
  for (const relative of scripts) {
    const target = join(lab, relative);
    let body = 'console.log("ok")\n';
    if (relative.endsWith('run-market-suite.js')) body = `import {mkdirSync,writeFileSync} from 'node:fs'; mkdirSync('docs/candidate-models',{recursive:true}); writeFileSync('docs/candidate-models/seed','ok');\n`;
    if (relative.endsWith('run-derivatives-suite.js')) body = `import {existsSync} from 'node:fs'; if(!existsSync('docs/candidate-models/seed')) process.exit(9);\n`;
    if (relative.endsWith('run-stock-market-suite.js')) body = `import {mkdirSync,writeFileSync} from 'node:fs'; mkdirSync('docs',{recursive:true}); writeFileSync('docs/stock-seed','ok');\n`;
    if (relative.endsWith('run-stock-pnl-suite.js')) body = `import {existsSync} from 'node:fs'; if(!existsSync('docs/stock-seed')) process.exit(8);\n`;
    await writeFile(target, body);
  }
  for (const name of ['run-long-history-v1-with-retry.js','run-v3-history.js','run-v4-history.js','run-v5-history.js','run-v6-history.js','run-paper-forward-schedule.js','run-shadow-cycle.js']) await writeFile(join(lab, 'scripts', name), 'console.log("ok")\n');
  await writeFile(join(lab, 'src/automated-research-orchestrator.js'), `export function buildAutomatedResearchContract({researchCodeSha}){return{researchCodeSha,candidateSearch:{method:'bounded_coarse_narrow_fine',cartesianProductAllowed:false},artifactSafety:{liveOrderAllowed:false,privateAccountRequestAllowed:false}}} export function generateParameterCandidates({maxCandidates}){return Array.from({length:Math.min(16,maxCandidates)},(_,i)=>({i}))}\n`);
  await writeFile(join(lab, 'src/automated-v1-research.js'), 'export function runAutomatedV1Research(){}\n');
  return root;
}

test('historical plan preserves validated multi-market dependency order', () => {
  const plan = buildHistoricalPipelinePlan();
  assert.equal(plan.length, 3);
  assert.equal(plan.reduce((sum, p) => sum + p.stepCount, 0), 14);
  assert.deepEqual(plan[0].steps.map((s) => s.id), ['market-dataset-candidates','futures-generalization','futures-pnl','futures-regime','funding-history','market-structure']);
});

test('historical pipelines share predecessor artifacts inside pipeline and isolate pipelines', async () => {
  const repoRoot = await fakeRepo(); const stateRoot = join(repoRoot, 'state');
  const result = await runHistoricalPipelines({ repoRoot, stateRoot, researchSha: SHA, concurrency: 3, env: { PATH: process.env.PATH, RESEARCH_MIN_FREE_BYTES: '0' }, verifyGitHead: false });
  assert.equal(result.status, 'complete');
  assert.equal(result.taskCount, 3);
  assert.equal(result.plannedStepCount, 14);
  assert.equal(result.executedStepCount, 14);
  assert.equal(new Set(result.results.map((r) => r.workspace)).size, 3);
  assert.ok(result.results.every((r) => r.status === 'success'));
});
