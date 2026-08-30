export const JOURNAL_SYNC_BATCH_SIZE = 500;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 160;
export const JOURNAL_SYNC_MAX_REQUEST_BYTES = 512 * 1024;

export function createBatchIdempotencyKey(base: string, index: number) {
  const suffix = `:batch-${index}`;
  if (suffix.length >= MAX_IDEMPOTENCY_KEY_LENGTH) throw new Error('배치 idempotency suffix가 너무 깁니다.');
  return `${base.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH - suffix.length)}${suffix}`;
}

export function createJournalSyncBatches<T>(input: { idempotencyKey: string; clientTime: string; records: readonly T[] }) {
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(input.idempotencyKey) || !validPaperTimestamp(input.clientTime) || !Array.isArray(input.records)) throw new Error('동기화 요청의 식별자·시각·기록 목록을 확인하세요.');
  const encoder = new TextEncoder();
  const batches: Array<{ idempotencyKey: string; clientTime: string; records: T[] }> = [];
  const create = (index: number) => ({ idempotencyKey: createBatchIdempotencyKey(input.idempotencyKey, index), clientTime: input.clientTime, records: [] as T[] });
  let batch = create(0);
  let bytes = encoder.encode(JSON.stringify(batch)).byteLength;
  for (const record of input.records) {
    const serialized = JSON.stringify(record);
    if (serialized === undefined) throw new Error('동기화 기록을 JSON으로 표현할 수 없습니다.');
    const recordBytes = encoder.encode(serialized).byteLength;
    if (batch.records.length && (batch.records.length >= JOURNAL_SYNC_BATCH_SIZE || bytes + recordBytes + 1 > JOURNAL_SYNC_MAX_REQUEST_BYTES)) {
      batches.push(batch);
      batch = create(batches.length);
      bytes = encoder.encode(JSON.stringify(batch)).byteLength;
    }
    const nextBytes = bytes + recordBytes + (batch.records.length ? 1 : 0);
    if (nextBytes > JOURNAL_SYNC_MAX_REQUEST_BYTES) throw new Error('단일 거래 기록이 동기화 크기 제한을 넘었습니다. 원본을 자동으로 자르거나 전송하지 않았습니다.');
    batch.records.push(record);
    bytes = nextBytes;
  }
  if (batch.records.length || batches.length === 0) batches.push(batch);
  if (batches.length === 1) batches[0].idempotencyKey = input.idempotencyKey;
  return batches;
}
import { validPaperTimestamp } from '../../../packages/api-zod/src/paper-state-evidence.js';
