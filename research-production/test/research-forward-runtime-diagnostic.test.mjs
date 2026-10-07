import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const DIGEST = 'c'.repeat(64);
const cli = fileURLToPath(new URL('../bin/research-forward-runtime-diagnostic.mjs', import.meta.url));

async function privateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function json(path, value) {
  await writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600 });
}

function safety(value = {}) {
  return {
    ...value,
    immutable: true,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
  };
}

async function baseFixture() {
  const root = await mkdtemp(join(tmpdir(), 'research-forward-diagnostic-'));
  await chmod(root, 0o700);
  const stateRoot = join(root, 'state');
  const paperRoot = join(root, 'paper');
  const envFile = join(root, 'research-production.env');
  await privateDir(join(stateRoot, 'latest'));
  await privateDir(join(stateRoot, 'forward'));
  await privateDir(join(paperRoot, 'publisher'));
  return { root, stateRoot, paperRoot, envFile };
}

test('diagnostic exposes old Paper SHA and blocked forward tasks without publisher digest leakage', async () => {
  const x = await baseFixture();
  try {
    await json(join(x.stateRoot, 'latest', 'forward.json'), {
      schemaVersion: 'research-production-cycle-v1',
      profile: 'forward',
      researchSha: SHA,
      status: 'complete',
      taskCount: 2,
      successCount: 0,
      blockedDataCount: 2,
      failedCount: 0,
      results: [
        { id: 'shadow-forward', status: 'blocked_data', exitCode: 2, timedOut: false },
        { id: 'paper-forward', status: 'blocked_data', exitCode: 2, timedOut: false },
      ],
    });
    const snapshotPath = join(x.paperRoot, 'publisher', 'paper-state-v2.json');
    await json(join(x.paperRoot, 'publisher-binding.json'), safety({
      schemaVersion: 'paper-state-publisher-runtime-binding-v1',
      paperRuntimeSourceSha: OLD,
      snapshotPath,
      publisherAccountIdSha256: DIGEST,
    }));
    await json(snapshotPath, safety({
      schemaVersion: 'paper-trading-state-snapshot-v2',
      sourceSha: OLD,
      publisherAccountIdSha256: DIGEST,
      observedAtMs: Date.now() - 60_000,
      maximumAgeMs: 120_000,
    }));
    await json(join(x.stateRoot, 'forward', 'shadow-summary.json'), {
      schemaVersion: 3,
      groups: {
        'crypto-futures-15m': {
          status: 'blocked_data',
          blocker: 'SHADOW_INFERENCE_NOT_EVALUABLE',
          reason: 'MISSING_REQUIRED_INFERENCE_EVIDENCE',
          missingRequiredFeatures: ['benchmarkReturn', 'sentimentScore'],
        },
      },
    });
    await writeFile(x.envFile, 'LIVE_TRADING=false\n', { mode: 0o600 });

    const run = spawnSync(process.execPath, [
      cli, '--state-root', x.stateRoot, '--research-sha', SHA,
      '--paper-root', x.paperRoot, '--env-file', x.envFile,
    ], { encoding: 'utf8' });
    assert.equal(run.status, 2, run.stderr);
    const value = JSON.parse(run.stdout);
    assert.equal(value.status, 'BLOCKED');
    assert.ok(value.blockers.includes('FORWARD_TASKS_NOT_ALL_SUCCESS'));
    assert.ok(value.blockers.includes('PAPER_BINDING_SHA_MISMATCH'));
    assert.ok(value.blockers.includes('PAPER_SNAPSHOT_SHA_MISMATCH'));
    assert.ok(value.blockers.includes('PAPER_SUPPLEMENTAL_COST_MISSING_CONFIG'));
    assert.ok(value.blockers.includes('SHADOW_RUNTIME_NOT_PASS'));
    assert.equal(value.paper.bindingSourceSha, OLD);
    assert.equal(value.paper.snapshotSourceSha, OLD);
    assert.doesNotMatch(run.stdout, new RegExp(DIGEST));
    assert.equal(value.publisherAccountDigestExposed, false);
    assert.equal(value.executionAuthority, 'NONE');
  } finally {
    await rm(x.root, { recursive: true, force: true });
  }
});

test('diagnostic is READY only for current-sha successful forward, fresh Paper state, cost input and passing Shadow', async () => {
  const x = await baseFixture();
  try {
    await json(join(x.stateRoot, 'latest', 'forward.json'), {
      schemaVersion: 'research-production-cycle-v1',
      profile: 'forward',
      researchSha: SHA,
      status: 'complete',
      taskCount: 2,
      successCount: 2,
      blockedDataCount: 0,
      failedCount: 0,
      results: [
        { id: 'shadow-forward', status: 'success', exitCode: 0, timedOut: false },
        { id: 'paper-forward', status: 'success', exitCode: 0, timedOut: false },
      ],
    });
    const snapshotPath = join(x.paperRoot, 'publisher', 'paper-state-v2.json');
    await json(join(x.paperRoot, 'publisher-binding.json'), safety({
      schemaVersion: 'paper-state-publisher-runtime-binding-v1',
      paperRuntimeSourceSha: SHA,
      snapshotPath,
      publisherAccountIdSha256: DIGEST,
    }));
    await json(snapshotPath, safety({
      schemaVersion: 'paper-trading-state-snapshot-v2',
      sourceSha: SHA,
      publisherAccountIdSha256: DIGEST,
      observedAtMs: Date.now(),
      maximumAgeMs: 300_000,
    }));
    await json(join(x.stateRoot, 'forward', 'shadow-summary.json'), {
      schemaVersion: 3,
      groups: {
        'crypto-futures-15m': { status: 'pass' },
        'crypto-futures-1h': { status: 'pass' },
      },
    });
    const costPath = join(x.root, 'cost.json');
    await json(costPath, { schemaVersion: 'test-only-cost-fixture-v1' });
    await writeFile(
      x.envFile,
      'LIVE_TRADING=false\nPAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH=' + costPath + '\n',
      { mode: 0o600 },
    );

    const run = spawnSync(process.execPath, [
      cli, '--state-root', x.stateRoot, '--research-sha', SHA,
      '--paper-root', x.paperRoot, '--env-file', x.envFile,
    ], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const value = JSON.parse(run.stdout);
    assert.equal(value.status, 'READY');
    assert.deepEqual(value.blockers, []);
    assert.equal(value.forward.successCount, 2);
    assert.equal(value.paper.bindingMatchesResearchSha, true);
    assert.equal(value.paper.snapshotMatchesResearchSha, true);
    assert.equal(value.paper.snapshotFresh, true);
    assert.equal(value.supplementalCost.status, 'READABLE_JSON');
    assert.equal(value.executionAuthority, 'NONE');
    assert.equal(value.liveTrading, false);
  } finally {
    await rm(x.root, { recursive: true, force: true });
  }
});
