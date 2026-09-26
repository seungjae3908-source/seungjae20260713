import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  evaluateDeploymentIdentity,
  normalizeDeploymentSha,
  readRuntimeDeploymentIdentity,
} from './deployment-identity';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('exact 40-character SHA is normalized', () => {
  assert.equal(normalizeDeploymentSha(SHA_A.toUpperCase()), SHA_A);
});

test('missing and malformed process SHAs fail closed', () => {
  assert.equal(evaluateDeploymentIdentity('', SHA_A).identityStatus, 'process_missing_or_malformed');
  assert.equal(evaluateDeploymentIdentity('abc123', SHA_A).identityStatus, 'process_missing_or_malformed');
  assert.equal(evaluateDeploymentIdentity('', SHA_A).identityMatch, false);
});

test('process and marker mismatch fails closed as stale process', () => {
  const identity = evaluateDeploymentIdentity(SHA_A, SHA_B);
  assert.equal(identity.processDeploySha, SHA_A);
  assert.equal(identity.deployMarkerSha, SHA_B);
  assert.equal(identity.identityStatus, 'mismatch');
  assert.equal(identity.identityMatch, false);
});

test('missing marker fails closed', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'deployment-identity-'));
  try {
    const identity = readRuntimeDeploymentIdentity(SHA_A, path.join(temp, 'missing-current-sha'));
    assert.equal(identity.identityStatus, 'marker_missing_or_malformed');
    assert.equal(identity.identityMatch, false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('malformed marker fails closed', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'deployment-identity-'));
  try {
    const marker = path.join(temp, 'current-sha');
    await writeFile(marker, 'not-a-sha\n', 'utf8');
    const identity = readRuntimeDeploymentIdentity(SHA_A, marker);
    assert.equal(identity.identityStatus, 'marker_missing_or_malformed');
    assert.equal(identity.identityMatch, false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('matching immutable process SHA and marker passes', () => {
  const identity = evaluateDeploymentIdentity(SHA_A, SHA_A);
  assert.deepEqual(identity, {
    processDeploySha: SHA_A,
    deployMarkerSha: SHA_A,
    identityMatch: true,
    identityStatus: 'match',
  });
});
