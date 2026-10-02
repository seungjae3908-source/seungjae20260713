import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildValidationFreshnessPolicy,
  publishValidationFreshnessPolicy,
} from '../../ops/publish-paper-canonical-validation-freshness-policy.mjs';

test('publisher writes exactly one explicit immutable freshness policy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-freshness-'));
  try {
    const result = await publishValidationFreshnessPolicy({ stateRoot: root, maximumAgeMs: 14_400_000 });
    assert.equal(result.status, 'PUBLISHED');
    assert.equal(result.filesWritten, 1);
    assert.equal(result.environmentMutationPerformed, false);
    const value = JSON.parse(await readFile(path.join(root, 'validation-receipt-policy.json'), 'utf8'));
    assert.deepEqual(value, buildValidationFreshnessPolicy(14_400_000));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('same policy is idempotent but a silent value change is blocked', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-freshness-idempotent-'));
  try {
    await publishValidationFreshnessPolicy({ stateRoot: root, maximumAgeMs: 3_600_000 });
    const same = await publishValidationFreshnessPolicy({ stateRoot: root, maximumAgeMs: 3_600_000 });
    assert.equal(same.status, 'ALREADY_PRESENT');
    assert.equal(same.filesWritten, 0);
    await assert.rejects(
      () => publishValidationFreshnessPolicy({ stateRoot: root, maximumAgeMs: 7_200_000 }),
      (error) => error?.code === 'VALIDATION_FRESHNESS_POLICY_CHANGE_REQUIRES_NEW_VERSION',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid existing policy is never overwritten', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-freshness-invalid-'));
  try {
    await writeFile(path.join(root, 'validation-receipt-policy.json'), '{"schemaVersion":"bad"}\n');
    await assert.rejects(
      () => publishValidationFreshnessPolicy({ stateRoot: root, maximumAgeMs: 1 }),
      (error) => error?.code === 'VALIDATION_FRESHNESS_EXISTING_POLICY_INVALID',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('maximum age must be an explicit positive safe integer', () => {
  assert.throws(() => buildValidationFreshnessPolicy(0), /VALIDATION_FRESHNESS_MAXIMUM_AGE_INVALID/);
  assert.throws(() => buildValidationFreshnessPolicy(Number.NaN), /VALIDATION_FRESHNESS_MAXIMUM_AGE_INVALID/);
});
