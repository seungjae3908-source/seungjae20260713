import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertResearchSafety,
  buildTaskPlan,
  preflightResearchProduction,
  PROFILES,
  runResearchCycle,
  sanitizeChildEnv,
} from '../src/engine.mjs';

const SHA = 'a'.repeat(40);

async function fakeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'research-production-test-'));
  const lab = join(root, 'market-prediction-lab');
  await mkdir(join(lab, 'scripts'), { recursive: true });
  const required = new Set();
  for (const tasks of Object.values(PROFILES)) for (const task of tasks) for (const arg of task.args) required.add(arg);
  required.add('package.json');
  for (const relative of required) {
    const target = join(lab, relative);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, relative.endsWith('.json') ? '{}\n' : 'console.log("ok")\n');
  }
  return root;
}

test('safety refuses live/private activation', () => {
  assert.throws(() => assertResearchSafety({ env: { LIVE_TRADING: 'true' }, stateRoot: '/var/lib/investment-research-production', repoRoot: '/tmp/repo' }), /refuses live\/private/);
  assert.throws(() => assertResearchSafety({ env: {}, stateRoot: '/opt/stock-app-data/research', repoRoot: '/tmp/repo' }), /overlaps protected/);
});

test('child environment strips secrets and private credentials', () => {
  const env = sanitizeChildEnv({
    PATH: '/usr/bin',
    LANG: 'C.UTF-8',
    GITHUB_TOKEN: 'secret-token',
    GEMINI_API_KEY: 'secret-key',
    DATABASE_URL: 'postgres://secret',
    TOSS_ACCESS_TOKEN: 'secret-toss',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.LANG, 'C.UTF-8');
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.TOSS_ACCESS_TOKEN, undefined);
});

test('forward plan isolates Paper and Shadow state', () => {
  const stateRoot = '/var/lib/investment-research-production';
  const plan = buildTaskPlan({ profile: 'forward', stateRoot, researchSha: SHA, activationAtMs: 12345 });
  const paper = plan.find((task) => task.id === 'paper-forward');
  const shadow = plan.find((task) => task.id === 'shadow-forward');
  assert.equal(paper.env.PAPER_FORWARD_ROOT, `${stateRoot}/forward/paper`);
  assert.equal(paper.env.PAPER_FORWARD_RESEARCH_SHA, SHA);
  assert.equal(paper.env.PAPER_FORWARD_ACTIVATION_AT_MS, '12345');
  assert.equal(paper.env.LIVE_TRADING, 'false');
  assert.equal(shadow.args.at(-2), `${stateRoot}/forward/shadow-state.json`);
  assert.equal(shadow.args.at(-1), `${stateRoot}/forward/shadow-summary.json`);
});

test('historical plan is parallelizable and contains no live authority', () => {
  const plan = buildTaskPlan({ profile: 'fast-historical', stateRoot: '/var/lib/investment-research-production', researchSha: SHA });
  assert.ok(plan.length >= 8);
  for (const task of plan) {
    assert.equal(task.env.LIVE_TRADING, 'false');
    assert.equal(task.env.PRIVATE_API_ENABLED, 'false');
    assert.equal(task.env.ORDER_AUTHORITY, 'false');
  }
});

test('preflight requires exact SHA and validates lab layout', async () => {
  const repoRoot = await fakeRepo();
  const stateRoot = join(repoRoot, 'research-state');
  const result = await preflightResearchProduction({ repoRoot, stateRoot, researchSha: SHA, env: {}, verifyGitHead: false });
  assert.equal(result.status, 'ready');
  assert.equal(result.researchSha, SHA);
  assert.equal(result.checkoutSha, null);
  assert.equal(result.safety.liveTrading, false);
  await assert.rejects(() => preflightResearchProduction({ repoRoot, stateRoot, researchSha: 'main', env: {}, verifyGitHead: false }), /exact 40-character/);
});

test('parallel cycle uses isolated per-task workspaces', async () => {
  const repoRoot = await fakeRepo();
  const stateRoot = join(repoRoot, 'research-state');
  const result = await runResearchCycle({
    repoRoot,
    stateRoot,
    researchSha: SHA,
    profile: 'fast-historical',
    concurrency: 4,
    env: { PATH: process.env.PATH, GITHUB_TOKEN: 'must-not-propagate' },
    verifyGitHead: false,
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.taskCount, PROFILES['fast-historical'].length);
  assert.equal(result.failedCount, 0);
  const workspaces = new Set(result.results.map((row) => row.workspaceRoot));
  assert.equal(workspaces.size, result.taskCount);
  for (const row of result.results) {
    await access(join(row.workspaceRoot, 'package.json'));
  }
});

test('Paper activation timestamp is persisted and immutable across forward cycles', async () => {
  const repoRoot = await fakeRepo();
  const stateRoot = join(repoRoot, 'research-state');
  const first = await runResearchCycle({
    repoRoot,
    stateRoot,
    researchSha: SHA,
    profile: 'forward',
    concurrency: 2,
    env: { PATH: process.env.PATH },
    activationAtMs: 123456789,
    verifyGitHead: false,
  });
  assert.equal(first.status, 'complete');
  const activation = JSON.parse(await readFile(join(stateRoot, 'forward', 'activation.json'), 'utf8'));
  assert.equal(activation.activationAtMs, 123456789);
  await new Promise((resolve) => setTimeout(resolve, 3));
  const second = await runResearchCycle({
    repoRoot,
    stateRoot,
    researchSha: SHA,
    profile: 'forward',
    concurrency: 2,
    env: { PATH: process.env.PATH },
    activationAtMs: 123456789,
    verifyGitHead: false,
  });
  assert.equal(second.status, 'complete');
  await assert.rejects(() => runResearchCycle({
    repoRoot,
    stateRoot,
    researchSha: SHA,
    profile: 'forward',
    concurrency: 1,
    env: { PATH: process.env.PATH },
    activationAtMs: 999,
    verifyGitHead: false,
  }), /activation timestamp is immutable/);
});

test('dead stale lock is recovered instead of blocking research forever', async () => {
  const repoRoot = await fakeRepo();
  const stateRoot = join(repoRoot, 'research-state');
  await mkdir(join(stateRoot, 'locks'), { recursive: true });
  await writeFile(join(stateRoot, 'locks', 'fast-historical.lock'), JSON.stringify({ pid: 99999999, startedAt: 1 }) + '\n');
  const result = await runResearchCycle({
    repoRoot,
    stateRoot,
    researchSha: SHA,
    profile: 'fast-historical',
    concurrency: 4,
    env: { PATH: process.env.PATH },
    verifyGitHead: false,
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.failedCount, 0);
});
