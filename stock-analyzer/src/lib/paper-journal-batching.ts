export const JOURNAL_SYNC_BATCH_SIZE = 500;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 160;

export function createBatchIdempotencyKey(base: string, index: number) {
  const suffix = `:batch-${index}`;
  if (suffix.length >= MAX_IDEMPOTENCY_KEY_LENGTH) throw new Error('배치 idempotency suffix가 너무 깁니다.');
  return `${base.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH - suffix.length)}${suffix}`;
}
