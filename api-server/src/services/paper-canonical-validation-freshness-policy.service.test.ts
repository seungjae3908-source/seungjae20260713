import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPaperCanonicalValidationFreshnessPolicy,
  parsePaperCanonicalValidationFreshnessPolicy,
  resolvePaperCanonicalValidationReceiptMaximumAgeMs,
} from './paper-canonical-validation-freshness-policy.service';

const ROOT = '/opt/stock-app-data/paper-forward-v1';

test('explicit env freshness policy wins when valid', async () => {
  let reads = 0;
  const result = await resolvePaperCanonicalValidationReceiptMaximumAgeMs({
    env: { PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_MS: '3600000' },
    stateRoot: ROOT,
    async readText() { reads += 1; throw new Error('must not read policy file'); },
  });
  assert.equal(result.maximumAgeMs, 3_600_000);
  assert.equal(result.source, 'ENV');
  assert.equal(reads, 0);
});

test('durable policy file is accepted when env is absent', async () => {
  const policy = buildPaperCanonicalValidationFreshnessPolicy(14_400_000);
  const result = await resolvePaperCanonicalValidationReceiptMaximumAgeMs({
    env: {},
    stateRoot: ROOT,
    async readText(path) {
      assert.equal(path, `${ROOT}/validation-receipt-policy.json`);
      return JSON.stringify(policy);
    },
  });
  assert.equal(result.maximumAgeMs, 14_400_000);
  assert.equal(result.source, 'POLICY_FILE');
});

test('explicit malformed env value fails closed and is never hidden by file fallback', async () => {
  await assert.rejects(
    () => resolvePaperCanonicalValidationReceiptMaximumAgeMs({
      env: { PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_MS: 'bad' },
      stateRoot: ROOT,
      async readText() { return JSON.stringify(buildPaperCanonicalValidationFreshnessPolicy(14_400_000)); },
    }),
    (error: unknown) => (error as { code?: string })?.code === 'PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_INVALID',
  );
});

test('missing policy stays explicitly unconfigured', async () => {
  await assert.rejects(
    () => resolvePaperCanonicalValidationReceiptMaximumAgeMs({
      env: {},
      stateRoot: ROOT,
      async readText() {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
    }),
    (error: unknown) => (error as { code?: string })?.code === 'PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_UNCONFIGURED',
  );
});

test('policy safety envelope cannot be weakened', () => {
  const valid = buildPaperCanonicalValidationFreshnessPolicy(1);
  assert.equal(parsePaperCanonicalValidationFreshnessPolicy(valid).maximumAgeMs, 1);
  assert.throws(
    () => parsePaperCanonicalValidationFreshnessPolicy({ ...valid, executionAuthority: 'LIVE' }),
    (error: unknown) => (error as { code?: string })?.code === 'PAPER_CANONICAL_VALIDATION_RECEIPT_POLICY_INVALID',
  );
});
