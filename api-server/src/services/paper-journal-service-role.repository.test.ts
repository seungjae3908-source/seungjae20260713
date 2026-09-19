import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceRolePaperJournalRepository } from './paper-journal-supabase.repository';

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

test('service-role Paper Journal repository rejects cross-user scope before database access', async () => {
  const repository = createServiceRolePaperJournalRepository(USER_A, {} as never);

  await assert.rejects(() => repository.listSnapshot(USER_B), (error: unknown) => (
    error instanceof Error && error.message === '사용자 범위가 일치하지 않습니다.'
  ));
  await assert.rejects(() => repository.listJournalPayloads(USER_B), (error: unknown) => (
    error instanceof Error && error.message === '사용자 범위가 일치하지 않습니다.'
  ));
  await assert.rejects(() => repository.getRecord(USER_B, 'account', 'paper-account'), (error: unknown) => (
    error instanceof Error && error.message === '사용자 범위가 일치하지 않습니다.'
  ));
});
