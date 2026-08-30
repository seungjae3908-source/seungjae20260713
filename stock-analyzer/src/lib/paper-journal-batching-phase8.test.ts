import test from 'node:test';
import assert from 'node:assert/strict';
import { createBatchIdempotencyKey, createJournalSyncBatches, JOURNAL_SYNC_MAX_REQUEST_BYTES, MAX_IDEMPOTENCY_KEY_LENGTH } from './paper-journal-batching';

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

test('UTF-8 byte limits split full journal records without trimming or duplication', () => {
  const records = Array.from({ length: 550 }, (_, index) => ({ id: `entry-${index}`, note: '한글 메모'.repeat(500) }));
  const input = { idempotencyKey: 'x'.repeat(160), clientTime: '2026-08-02T00:00:00.000Z', records };
  const batches = createJournalSyncBatches(input);
  assert.ok(batches.length > 2);
  assert.deepEqual(batches.flatMap((batch) => batch.records), records);
  assert.equal(new Set(batches.map((batch) => batch.idempotencyKey)).size, batches.length);
  for (const batch of batches) {
    assert.ok(new TextEncoder().encode(JSON.stringify(batch)).byteLength <= JOURNAL_SYNC_MAX_REQUEST_BYTES);
    assert.ok(batch.records.length <= 500);
  }
});

test('oversized single record fails before returning any partial batches', () => {
  assert.throws(() => createJournalSyncBatches({ idempotencyKey: 'phase8-big-record', clientTime: '2026-08-02T00:00:00.000Z',
    records: [{ id: 'small', note: '' }, { id: 'big', note: '한'.repeat(JOURNAL_SYNC_MAX_REQUEST_BYTES) }] }), /단일 거래 기록/);
});

test('empty and small batches retain the caller request key', () => {
  const input = { idempotencyKey: 'phase8-small-request', clientTime: '2026-08-02T00:00:00.000Z', records: [] };
  assert.deepEqual(createJournalSyncBatches(input), [input]);
});
