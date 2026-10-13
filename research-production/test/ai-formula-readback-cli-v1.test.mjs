import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/research-ai-formula-readback.mjs', import.meta.url));
const SHA = 'a'.repeat(40);

test('CLI is explicitly read-only, gives a truthful missing-evidence report and does not change filesystem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-readonly-cli-'));
  try {
    const result = spawnSync(process.execPath, [cli, '--read-only', '--research-sha', SHA, '--state-root', root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.scanStatus, 'MISSING');
    assert.equal(report.storageMutationCount, 0);
    assert.equal(report.externalProviderCalls, 0);
    assert.equal(report.executionAuthority, 'NONE');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI refuses missing explicit read-only flag and never exposes a supplied private path', () => {
  const noFlag = spawnSync(process.execPath, [cli, '--research-sha', SHA, '--state-root', '/private/secret/location'], { encoding: 'utf8' });
  assert.equal(noFlag.status, 1);
  assert.equal(JSON.parse(noFlag.stderr).reason, 'READ_ONLY_RESEARCH_ARGUMENTS_REQUIRED');
  assert.doesNotMatch(noFlag.stderr, /\/private\/secret/u);
  const forbidden = spawnSync(process.execPath, [cli, '--read-only', '--research-sha', SHA, '--state-root', '/var/lib/stock-app/data'], { encoding: 'utf8' });
  assert.equal(forbidden.status, 1);
  assert.equal(JSON.parse(forbidden.stderr).reason, 'AI_FORMULA_READBACK_APP_STORAGE_FORBIDDEN');
});
