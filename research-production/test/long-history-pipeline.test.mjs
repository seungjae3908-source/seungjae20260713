import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROFILES } from '../src/engine.mjs';
import { runLongHistoryPipeline } from '../src/long-history-pipeline.mjs';

const SHA = 'c'.repeat(40);

async function fakeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'long-history-pipeline-'));
  const lab = join(root, 'market-prediction-lab');
  await mkdir(join(lab, 'scripts'), { recursive: true });

  const required = new Set();
  for (const tasks of Object.values(PROFILES)) {
    for (const task of tasks) {
      for (const arg of task.args) required.add(arg);
    }
  }
  required.add('package.json');

  for (const relative of required) {
    const target = join(lab, relative);
    await mkdir(join(target, '..'), { recursive: true });
    let body = relative === 'package.json' ? '{"type":"module"}\n' : 'console.log("ok")\n';
    if (relative.endsWith('run-long-history-v1-with-retry.js')) {
      body = `import {mkdirSync,writeFileSync} from 'node:fs'; mkdirSync('long-history-v1',{recursive:true}); writeFileSync('long-history-v1/seed.txt','ready'); console.log('v1-ready');\n`;
    } else if (/run-v[3-6]-history[.]js$/.test(relative)) {
      body = `import {existsSync,writeFileSync} from 'node:fs'; if(!existsSync('long-history-v1/seed.txt')) process.exit(9); writeFileSync('long-history-v1/${relative.match(/run-(v[3-6])-history/)[1]}.txt','ok'); console.log('variant-ready');\n`;
    }
    await writeFile(target, body);
  }
  return root;
}

test('long-history keeps V1 artifacts in one shared workspace for V3-V6', async () => {
  const repoRoot = await fakeRepo();
  const stateRoot = join(repoRoot, 'research-state');
  const result = await runLongHistoryPipeline({
    repoRoot,
    stateRoot,
    researchSha: SHA,
    env: { PATH: process.env.PATH, RESEARCH_MIN_FREE_BYTES: '0' },
    verifyGitHead: false,
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.concurrency, 1);
  assert.equal(result.taskCount, 5);
  assert.equal(result.successCount, 5);
  assert.equal(result.failedCount, 0);
  assert.equal(new Set(result.results.map((row) => row.workspaceRoot)).size, 1);
  for (const variant of ['v3', 'v4', 'v5', 'v6']) {
    await access(join(result.sharedWorkspace, 'long-history-v1', `${variant}.txt`));
  }
  const latest = JSON.parse(await readFile(join(stateRoot, 'latest', 'long-history.json'), 'utf8'));
  assert.equal(latest.status, 'complete');
  assert.equal(latest.researchSha, SHA);
  assert.equal(latest.safety.liveTrading, false);
});

test('V3-V6 fail closed when V1 dependency creation fails', async () => {
  const repoRoot = await fakeRepo();
  const stateRoot = join(repoRoot, 'research-state');
  await writeFile(
    join(repoRoot, 'market-prediction-lab', 'scripts', 'run-long-history-v1-with-retry.js'),
    'process.exit(7)\n',
  );
  const result = await runLongHistoryPipeline({
    repoRoot,
    stateRoot,
    researchSha: SHA,
    env: { PATH: process.env.PATH, RESEARCH_MIN_FREE_BYTES: '0' },
    verifyGitHead: false,
  });

  assert.equal(result.status, 'partial_failure');
  assert.equal(result.failedCount, 5);
  assert.equal(result.results[0].exitCode, 7);
  assert.ok(result.results.slice(1).every((row) => String(row.error).startsWith('DEPENDENCY_FAILED:long-v1')));
});
