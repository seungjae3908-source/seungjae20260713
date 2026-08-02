import test from 'node:test';
import assert from 'node:assert/strict';
import { createBatchIdempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH } from './paper-journal-sync';

test('batch idempotency key preserves suffix for 160-character base', () => {
  const key = createBatchIdempotencyKey('x'.repeat(160), 12);
  assert.equal(key.length, MAX_IDEMPOTENCY_KEY_LENGTH);
  assert.match(key, /:batch-12$/);
});

test('different batches never collapse to the same truncated key', () => {
  const base = 'x'.repeat(160);
  const keys = Array.from({ length: 20 }, (_, index) => createBatchIdempotencyKey(base, index));
  assert.equal(new Set(keys).size, keys.length);
});

test('short base remains readable with batch suffix', () => {
  assert.equal(createBatchIdempotencyKey('phase8-sync-request', 3), 'phase8-sync-request:batch-3');
});

test('generated key never exceeds server limit', () => {
  for (let index = 0; index < 1_000; index += 1) {
    assert.equal(createBatchIdempotencyKey('a'.repeat(500), index).length <= MAX_IDEMPOTENCY_KEY_LENGTH, true);
  }
});
