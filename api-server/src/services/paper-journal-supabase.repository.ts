import type { SupabaseClient } from '@supabase/supabase-js';
import { isDeepStrictEqual } from 'node:util';
import { validPaperTimestamp } from '../../../packages/api-zod/src/paper-state-evidence.js';
import { getUserSupabase } from '../lib/supabase';
import {
  PaperJournalError,
  type PaperJournalConflict,
  type PaperJournalRecordKind,
  type PaperJournalRepository,
  type PaperJournalSyncRecord,
  type PaperJournalSyncResult,
  type StoredPaperJournalRecord,
} from './paper-journal.types';

const TABLES: Record<PaperJournalRecordKind, string> = {
  account: 'paper_accounts', order: 'paper_orders', position: 'paper_positions',
  fill: 'paper_fills', journal: 'paper_journal_entries',
};
const DATABASE_READ_PAGE_SIZE = 500;
const MAX_DATABASE_SNAPSHOT_RECORDS = 10000;

type StorageRow = {
  id: string; payload: Record<string, unknown>; version: number;
  deleted_at: string | null; created_at: string; updated_at: string;
};

function databaseFailure() {
  return new PaperJournalError('JOURNAL_STORAGE_UNAVAILABLE', '거래일지 저장소를 처리하지 못했습니다.', 503);
}

function concurrentWrite() {
  return new PaperJournalError('JOURNAL_VERSION_CHANGED', '다른 요청이 원장을 변경했습니다. 최신 기록을 확인한 뒤 다시 동기화하세요.', 409);
}

function toRecord(kind: PaperJournalRecordKind, row: StorageRow): StoredPaperJournalRecord {
  if (!row || typeof row.id !== 'string' || !row.id || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)
    || !Number.isSafeInteger(row.version) || row.version < 1 || !validPaperTimestamp(row.created_at) || !validPaperTimestamp(row.updated_at)
    || Date.parse(row.created_at) > Date.parse(row.updated_at) || row.deleted_at !== null && !validPaperTimestamp(row.deleted_at)) throw databaseFailure();
  return {
    kind, id: row.id, payload: row.payload, version: row.version,
    updatedAt: row.updated_at, deletedAt: row.deleted_at,
    createdAt: row.created_at, serverUpdatedAt: row.updated_at,
  };
}

async function deleteRows(client: SupabaseClient, table: string, userId: string) {
  const { data, error } = await client.from(table).delete().eq('user_id', userId).select('id');
  if (error || !Array.isArray(data)) throw databaseFailure();
  return data.length;
}

async function readAllRows(client: SupabaseClient, table: string, userId: string) {
  const rows: StorageRow[] = [];
  let lastId: string | null = null;
  for (let pageNumber = 0; pageNumber <= MAX_DATABASE_SNAPSHOT_RECORDS / DATABASE_READ_PAGE_SIZE; pageNumber += 1) {
    let query = client
      .from(table)
      .select('id,payload,version,deleted_at,created_at,updated_at', { count: 'exact' })
      .eq('user_id', userId)
      .order('id', { ascending: true })
      .limit(DATABASE_READ_PAGE_SIZE);
    if (lastId !== null) query = query.gt('id', lastId);
    const { data, error, count } = await query;
    if (error || !Array.isArray(data) || !Number.isSafeInteger(count) || count! < 0
      || data.length !== Math.min(count!, DATABASE_READ_PAGE_SIZE)) throw databaseFailure();
    const page = data as StorageRow[];
    if (page.some((row) => !row || typeof row.id !== 'string' || !row.id)
      || new Set([...rows, ...page].map((row) => row.id)).size !== rows.length + page.length) throw databaseFailure();
    rows.push(...page);
    if (rows.length > MAX_DATABASE_SNAPSHOT_RECORDS) throw new PaperJournalError('SNAPSHOT_TOO_LARGE', '원장이 안전한 단일 조회 한도를 초과했습니다. 분할 복구가 필요합니다.', 413);
    if (page.length < DATABASE_READ_PAGE_SIZE) return rows;
    lastId = page.at(-1)!.id;
  }
  throw databaseFailure();
}

export function createSupabasePaperJournalRepository(accessToken: string, authenticatedUserId: string, scopedClient?: SupabaseClient): PaperJournalRepository {
  if (!accessToken || !authenticatedUserId) throw new PaperJournalError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);
  const client = scopedClient ?? getUserSupabase(accessToken);
  const assertOwner = (userId: string) => {
    if (userId !== authenticatedUserId) throw new PaperJournalError('USER_SCOPE_MISMATCH', '사용자 범위가 일치하지 않습니다.', 403);
  };

  return {
    async getRecord(userId, kind, id) {
      assertOwner(userId);
      const { data, error } = await client.from(TABLES[kind])
        .select('id,payload,version,deleted_at,created_at,updated_at')
        .eq('user_id', authenticatedUserId).eq('id', id).maybeSingle();
      if (error) throw databaseFailure();
      return data ? toRecord(kind, data as StorageRow) : null;
    },

    async upsertRecord(userId, record, serverTime, expectedVersion = null) {
      assertOwner(userId);
      if (!Number.isSafeInteger(record.version) || record.version < 1 || expectedVersion !== null
        && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || record.version <= expectedVersion)) throw concurrentWrite();
      const row = {
        user_id: authenticatedUserId, id: record.id, payload: record.payload,
        version: record.version, deleted_at: record.deletedAt, updated_at: serverTime,
      };
      const query = expectedVersion === null ? client.from(TABLES[record.kind]).insert({ ...row, created_at: serverTime })
        : client.from(TABLES[record.kind]).update(row).eq('user_id', authenticatedUserId).eq('id', record.id).eq('version', expectedVersion);
      const { data, error } = await query.select('id,payload,version,deleted_at,created_at,updated_at').maybeSingle();
      if (error?.code === '23505' || !error && !data) throw concurrentWrite();
      if (error) throw databaseFailure();
      return toRecord(record.kind, data as StorageRow);
    },

    async listSnapshot(userId) {
      assertOwner(userId);
      const read = async () => {
        const records: StoredPaperJournalRecord[] = [];
        for (const kind of Object.keys(TABLES) as PaperJournalRecordKind[]) {
          for (const row of await readAllRows(client, TABLES[kind], authenticatedUserId)) records.push(toRecord(kind, row));
          if (records.length > MAX_DATABASE_SNAPSHOT_RECORDS) throw new PaperJournalError('SNAPSHOT_TOO_LARGE', '원장이 안전한 단일 조회 한도를 초과했습니다.', 413);
        }
        return records;
      };
      const first = await read();
      const second = await read();
      if (!isDeepStrictEqual(first, second)) throw new PaperJournalError('SNAPSHOT_CHANGED', '조회 도중 서버 원장이 변경되었습니다. 다시 조회하세요.', 409);
      return second;
    },

    async getIdempotentResponse(userId, idempotencyKey) {
      assertOwner(userId);
      const { data, error } = await client.from('paper_sync_state').select('payload,status')
        .eq('user_id', authenticatedUserId).eq('id', `request:${idempotencyKey}`)
        .eq('state_type', 'request').maybeSingle();
      if (error) throw databaseFailure();
      return data?.status === 'completed' && data.payload ? data.payload as PaperJournalSyncResult : null;
    },

    async claimSyncRequest(userId, idempotencyKey, fingerprint, serverTime) {
      assertOwner(userId);
      const id = `request:${idempotencyKey}`;
      const { error } = await client.from('paper_sync_state').insert({
        user_id: authenticatedUserId, id, state_type: 'request', status: 'open',
        payload: { requestFingerprint: fingerprint }, version: 1, updated_at: serverTime,
      });
      if (!error) return null;
      if (error.code !== '23505') throw databaseFailure();
      const { data, error: readError } = await client.from('paper_sync_state').select('payload,status')
        .eq('user_id', authenticatedUserId).eq('id', id).eq('state_type', 'request').maybeSingle();
      if (readError || !data) throw databaseFailure();
      if (data.payload?.requestFingerprint !== fingerprint) throw new PaperJournalError('IDEMPOTENCY_CONTEXT_MISMATCH', '같은 동기화 키가 다른 요청에 사용되었습니다.', 409);
      if (data.status === 'completed') return data.payload as PaperJournalSyncResult;
      // A crashed or concurrent writer is uncertain; never steal its claim or fabricate an acknowledgement.
      throw new PaperJournalError('SYNC_REQUEST_IN_PROGRESS', '이 요청의 완료 여부를 아직 확인할 수 없습니다. 최신 원장을 조회한 후 다시 동기화하세요.', 409);
    },

    async saveIdempotentResponse(userId, idempotencyKey, result, serverTime) {
      assertOwner(userId);
      if (!result.requestFingerprint || !/^[a-f0-9]{64}$/.test(result.requestFingerprint)) throw databaseFailure();
      const { data, error } = await client.from('paper_sync_state').update({
        status: 'completed', payload: result, version: 2, updated_at: serverTime,
      }).eq('user_id', authenticatedUserId).eq('id', `request:${idempotencyKey}`).eq('state_type', 'request')
        .eq('status', 'open').eq('payload->>requestFingerprint', result.requestFingerprint).select('id').maybeSingle();
      if (error || !data) throw databaseFailure();
    },

    async saveConflict(userId, conflict) {
      assertOwner(userId);
      const { error } = await client.from('paper_sync_state').insert({
        user_id: authenticatedUserId, id: conflict.id, state_type: 'conflict',
        status: 'open', payload: conflict, version: conflict.version,
        updated_at: conflict.createdAt,
      });
      if (error && error.code !== '23505') throw databaseFailure();
      if (error) {
        const { data, error: readError } = await client.from('paper_sync_state').select('payload,status')
          .eq('user_id', authenticatedUserId).eq('id', conflict.id).eq('state_type', 'conflict').maybeSingle();
        if (readError || !data) throw databaseFailure();
        if (data.status !== 'open' || !isDeepStrictEqual(data.payload?.serverRecord, conflict.serverRecord)
          || !isDeepStrictEqual(data.payload?.deviceRecord, conflict.deviceRecord)) throw new PaperJournalError('CONFLICT_STALE', '이미 해결되었거나 변경된 충돌입니다. 다시 동기화하세요.', 409);
      }
    },

    async getConflict(userId, conflictId) {
      assertOwner(userId);
      const { data, error } = await client.from('paper_sync_state').select('payload,status')
        .eq('user_id', authenticatedUserId).eq('id', conflictId)
        .eq('state_type', 'conflict').maybeSingle();
      if (error) throw databaseFailure();
      if (!data?.payload) return null;
      return { ...(data.payload as PaperJournalConflict), status: data.status === 'resolved' ? 'resolved' : 'open' };
    },

    async markConflictResolved(userId, conflictId, serverTime) {
      assertOwner(userId);
      const { data, error } = await client.from('paper_sync_state')
        .update({ status: 'resolved', updated_at: serverTime })
        .eq('user_id', authenticatedUserId).eq('id', conflictId).eq('state_type', 'conflict').eq('status', 'open').select('id').maybeSingle();
      if (error) throw databaseFailure();
      if (!data) throw new PaperJournalError('CONFLICT_STALE', '충돌 상태가 변경되었습니다. 최신 원장을 다시 확인하세요.', 409);
    },

    async listJournalPayloads(userId) {
      assertOwner(userId);
      const rows = await readAllRows(client, 'paper_journal_entries', authenticatedUserId);
      const repeated = await readAllRows(client, 'paper_journal_entries', authenticatedUserId);
      if (!isDeepStrictEqual(rows, repeated)) throw new PaperJournalError('SNAPSHOT_CHANGED', '조회 도중 거래 기록이 변경되었습니다. 다시 조회하세요.', 409);
      for (const row of rows) toRecord('journal', row);
      return rows.filter((row) => row.deleted_at == null).map((row) => row.payload as Record<string, unknown>);
    },

    async deleteAll(userId) {
      assertOwner(userId);
      return {
        account: await deleteRows(client, TABLES.account, authenticatedUserId),
        order: await deleteRows(client, TABLES.order, authenticatedUserId),
        position: await deleteRows(client, TABLES.position, authenticatedUserId),
        fill: await deleteRows(client, TABLES.fill, authenticatedUserId),
        journal: await deleteRows(client, TABLES.journal, authenticatedUserId),
        syncState: await deleteRows(client, 'paper_sync_state', authenticatedUserId),
      };
    },
  };
}

export type { PaperJournalSyncRecord };
