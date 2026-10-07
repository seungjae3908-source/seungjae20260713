import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function symlinkedRepo(t) {
  const root = await mkdtemp(join(tmpdir(), 'research-symlink-cli-'));
  await chmod(root, 0o700);
  const alias = join(root, 'current');
  await symlink(repoRoot, alias, 'dir');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, alias };
}

test('workspace worker CLI executes through a symlinked current release path', async (t) => {
  const { root, alias } = await symlinkedRepo(t);
  const stateRoot = join(root, 'workspace-worker');
  const cli = join(alias, 'packages', 'external-research', 'scripts', 'run-research-worker-v9.mjs');
  const run = spawnSync(process.execPath, [cli, '--root', stateRoot, '--status'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.notEqual(run.stdout.trim(), '');
  const output = JSON.parse(run.stdout);
  assert.equal(output.schemaVersion, 'research-worker-status-v9');
  assert.equal(output.available, false);
  assert.equal(output.reason, 'WORKER_STORE_NOT_INSTALLED');
});

test('approved-job intake CLI executes through a symlinked current release path', async (t) => {
  const { root, alias } = await symlinkedRepo(t);
  const stateRoot = join(root, 'state');
  await mkdir(stateRoot, { mode: 0o700 });
  const cli = join(alias, 'research-production', 'bin', 'research-approved-job-intake.mjs');
  const run = spawnSync(process.execPath, [cli], {
    encoding: 'utf8',
    env: { ...process.env, RESEARCH_STATE_ROOT: stateRoot },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.notEqual(run.stdout.trim(), '');
  const output = JSON.parse(run.stdout);
  assert.equal(output.schemaVersion, 'research-approved-job-intake-v1');
  assert.equal(output.status, 'COMPLETE');
  assert.equal(output.queued, 0);
  assert.equal(output.existing, 0);
  assert.equal(output.executionAuthority, 'NONE');
});

test('video approval bridge CLI does not silently no-op through a symlinked path', async (t) => {
  const { alias } = await symlinkedRepo(t);
  const cli = join(alias, 'research-production', 'bin', 'research-video-approved-job.mjs');
  const run = spawnSync(process.execPath, [cli, '--bad'], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.equal(run.stdout.trim(), '');
  assert.notEqual(run.stderr.trim(), '');
  const output = JSON.parse(run.stderr);
  assert.equal(output.status, 'FAILED_CLOSED');
  assert.equal(output.reason, 'VIDEO_APPROVAL_BRIDGE_ARGUMENTS_INVALID');
  assert.equal(output.automaticApproval, false);
  assert.equal(output.executionAuthority, 'NONE');
});
