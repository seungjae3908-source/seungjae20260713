import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAPER_STATE_READONLY_TRANSPORT_VERSION,
  preparePaperStateReadonlyTransport,
} from '../deploy/prepare-paper-state-readonly-transport.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const DIGEST = 'a'.repeat(64);

function safetyEnvelope(value) {
  return {
    ...value,
    immutable: true,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
  };
}

test('forward transport copies canonical binding and snapshot bytes losslessly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-paper-transport-'));
  const sourceRoot = join(root, 'canonical');
  const runtimeDirectory = join(root, 'runtime');
  const snapshotSourcePath = join(sourceRoot, 'publisher', 'paper-state-v2.json');
  const bindingSourcePath = join(sourceRoot, 'publisher-binding.json');
  await mkdir(join(sourceRoot, 'publisher'), { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  const bindingContent = `${JSON.stringify(safetyEnvelope({
    schemaVersion: 'paper-state-publisher-runtime-binding-v1',
    paperRuntimeSourceSha: SHA,
    snapshotPath: snapshotSourcePath,
    publisherAccountIdSha256: DIGEST,
  }), null, 2)}\n`;
  const snapshotContent = `${JSON.stringify(safetyEnvelope({
    schemaVersion: 'paper-trading-state-snapshot-v2',
    sourceSha: SHA,
    publisherAccountIdSha256: DIGEST,
    observedAtMs: 100,
    maximumAgeMs: 1000,
    state: { schemaVersion: 1 },
  }), null, 2)}\n`;
  await writeFile(bindingSourcePath, bindingContent);
  await writeFile(snapshotSourcePath, snapshotContent);

  try {
    const result = await preparePaperStateReadonlyTransport({
      profile: 'forward',
      runtimeDirectory,
      sourceRoot,
    });
    assert.equal(result.schemaVersion, PAPER_STATE_READONLY_TRANSPORT_VERSION);
    assert.equal(result.status, 'PRESENT');
    assert.equal(result.copiedFileCount, 2);
    assert.equal(result.sensitiveValuesEmitted, false);
    assert.equal(
      await readFile(join(runtimeDirectory, 'paper-state', 'publisher-binding.json'), 'utf8'),
      bindingContent,
    );
    assert.equal(
      await readFile(join(runtimeDirectory, 'paper-state', 'paper-state-v2.json'), 'utf8'),
      snapshotContent,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing canonical transport remains MISSING and never creates a default state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-paper-transport-missing-'));
  const sourceRoot = join(root, 'canonical');
  const runtimeDirectory = join(root, 'runtime');
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(join(runtimeDirectory, 'paper-state'), { recursive: true });
  await writeFile(
    join(runtimeDirectory, 'paper-state', 'publisher-binding.json'),
    '{"stale":true}\n',
  );
  await writeFile(
    join(runtimeDirectory, 'paper-state', 'paper-state-v2.json'),
    '{"stale":true}\n',
  );
  try {
    const result = await preparePaperStateReadonlyTransport({
      profile: 'forward',
      runtimeDirectory,
      sourceRoot,
    });
    assert.equal(result.status, 'MISSING');
    assert.equal(result.copiedFileCount, 0);
    await assert.rejects(
      readFile(join(runtimeDirectory, 'paper-state', 'paper-state-v2.json')),
      (error) => error?.code === 'ENOENT',
    );
    await assert.rejects(
      readFile(join(runtimeDirectory, 'paper-state', 'publisher-binding.json')),
      (error) => error?.code === 'ENOENT',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed source fails with a controlled code and no raw content leakage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-paper-transport-invalid-'));
  const sourceRoot = join(root, 'canonical');
  const runtimeDirectory = join(root, 'runtime');
  await mkdir(join(sourceRoot, 'publisher'), { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(join(sourceRoot, 'publisher-binding.json'), '{"secret":"do-not-leak"');
  await writeFile(join(sourceRoot, 'publisher', 'paper-state-v2.json'), '{}');
  try {
    await assert.rejects(
      preparePaperStateReadonlyTransport({ profile: 'forward', runtimeDirectory, sourceRoot }),
      (error) => error?.code === 'PAPER_STATE_READONLY_BINDING_INVALID'
        && !String(error?.message).includes('do-not-leak'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('systemd forward worker stages only the read-only canonical Paper transport', async () => {
  const unit = await readFile(
    new URL('../deploy/research-production@.service', import.meta.url),
    'utf8',
  );
  assert.match(unit, /^RuntimeDirectory=investment-research-%i$/mu);
  assert.match(
    unit,
    /^ExecStartPre=\+\/usr\/bin\/env node research-production\/deploy\/prepare-paper-state-readonly-transport\.mjs --profile %i$/mu,
  );
  assert.match(unit, /^ReadOnlyPaths=-\/opt\/stock-app-data\/paper-forward-v1$/mu);
  assert.doesNotMatch(unit, /^ReadWritePaths=.*paper-forward-v1/mu);
});
