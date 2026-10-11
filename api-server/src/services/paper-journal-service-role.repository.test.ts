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

test('generic Paper sync rejects forged manual four-market reserved IDs before touching DB',async()=>{
  let databaseCalls=0;
  const rejectedClient={from:(_table:string)=>{
    databaseCalls+=1;
    throw new Error('DB SHOULD NEVER BE CALLED FOR PROTECTED PAPER WALLET');
  }} as never;
  const repository=createServiceRolePaperJournalRepository(USER_A,rejectedClient);
  for(const id of [
    'manual-paper-member-v1:crypto_spot',
    'manual-paper-admin-v1:crypto_futures',
    'manual-paper-member-v1:fake-market',
    'manual-paper-admin-v1:future-added-market',
  ]) {
    await assert.rejects(()=>repository.upsertRecord(USER_A,{
      kind:'account',id,version:1,updatedAt:new Date().toISOString(),
      deletedAt:null,payload:{id,initialBalance:1_000_000},
    },new Date().toISOString()),(error:unknown)=>
      error instanceof Error && error.message.includes('일반 동기화로 변경할 수 없습니다.'));
  }
  assert.equal(databaseCalls,0);
});
