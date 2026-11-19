import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  materializeForwardObserverArtifact,
  validateForwardObserverArtifact,
} from '../../ops/materialize-paper-canonical-forward-observer.mjs';

const SHA = 'a'.repeat(40);
const SAFETY = {
  publicDataOnly: true,
  artifactOnly: true,
  executionAuthority: 'NONE',
  financialMutationAllowed: false,
  liveOrderAllowed: false,
  privateTradingApiAllowed: false,
  profitabilityClaimAllowed: false,
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function writeArtifact(root, { researchSha = SHA, tamperDigest = false } = {}) {
  await mkdir(root, { recursive: true });
  const stateText = `${JSON.stringify({
    schemaVersion: 1,
    researchCodeSha: researchSha,
    createdAt: '2026-09-25T00:00:00.000Z',
    updatedAt: '2026-09-25T00:00:00.000Z',
    cursors: { KR_SWING_60M: 0, US_SWING_60M: 0, SPOT_SWING_60M: 0, FUTURES_SWING_60M: 0 },
    observations: [],
    safety: SAFETY,
  }, null, 2)}\n`;
  const summaryText = `${JSON.stringify({
    schemaVersion: 1,
    researchCodeSha: researchSha,
    counts: { total: 0, pending: 0, settled: 0 },
    coverage: { fullStrategyCoverage: false, strategies: ['SWING'] },
    safety: SAFETY,
  }, null, 2)}\n`;
  const manifestText = `${JSON.stringify({
    schemaVersion: 1,
    kind: 'forward-recommendation-observer-state',
    researchCodeSha: researchSha,
    stateSha256: tamperDigest ? '0'.repeat(64) : sha256(stateText),
    summarySha256: sha256(summaryText),
    safety: SAFETY,
  }, null, 2)}\n`;
  await Promise.all([
    writeFile(path.join(root, 'state.json'), stateText),
    writeFile(path.join(root, 'summary.json'), summaryText),
    writeFile(path.join(root, 'manifest.json'), manifestText),
  ]);
  return { stateText, summaryText, manifestText };
}

test('validated artifact is copied byte-for-byte into canonical forward-observer directory', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'paper-observer-materialize-'));
  try {
    const source = path.join(temp, 'source');
    const stateRoot = path.join(temp, 'state-root');
    const original = await writeArtifact(source);
    const result = await materializeForwardObserverArtifact({ sourceRoot: source, stateRoot, expectedSha: SHA });
    assert.equal(result.status, 'MATERIALIZED');
    assert.equal(result.filesWritten, 3);
    assert.equal(result.executionAuthority, 'NONE');
    assert.equal(await readFile(path.join(stateRoot, 'forward-observer', 'state.json'), 'utf8'), original.stateText);
    assert.equal(await readFile(path.join(stateRoot, 'forward-observer', 'summary.json'), 'utf8'), original.summaryText);
    assert.equal(await readFile(path.join(stateRoot, 'forward-observer', 'manifest.json'), 'utf8'), original.manifestText);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('wrong immutable research SHA fails closed', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'paper-observer-sha-'));
  try {
    await writeArtifact(temp, { researchSha: 'b'.repeat(40) });
    await assert.rejects(
      () => validateForwardObserverArtifact({ sourceRoot: temp, expectedSha: SHA }),
      (error) => error?.code === 'FORWARD_OBSERVER_MATERIALIZE_STATE_IDENTITY_INVALID',
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('manifest digest mismatch is never materialized', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'paper-observer-digest-'));
  try {
    await writeArtifact(temp, { tamperDigest: true });
    await assert.rejects(
      () => validateForwardObserverArtifact({ sourceRoot: temp, expectedSha: SHA }),
      (error) => error?.code === 'FORWARD_OBSERVER_MATERIALIZE_MANIFEST_INVALID',
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('dry-run validates without writing server files', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'paper-observer-dry-'));
  try {
    const source = path.join(temp, 'source');
    const stateRoot = path.join(temp, 'state-root');
    await writeArtifact(source);
    const result = await materializeForwardObserverArtifact({
      sourceRoot: source,
      stateRoot,
      expectedSha: SHA,
      dryRun: true,
    });
    assert.equal(result.status, 'VALIDATED_ONLY');
    assert.equal(result.filesWritten, 0);
    await assert.rejects(() => readFile(path.join(stateRoot, 'forward-observer', 'state.json')));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
