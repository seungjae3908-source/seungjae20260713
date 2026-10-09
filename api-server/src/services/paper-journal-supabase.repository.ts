import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase, getUserSupabase, hasSupabaseServerKey } from '../lib/supabase';
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

type StorageRow = {
  id: string; payload: Record<string, unknown>; version: number;
  deleted_at: string | null; created_at: string; updated_at: string;
};

function databaseFailure() {
  return new PaperJournalError('JOURNAL_STORAGE_UNAVAILABLE', '거래일지 저장소를 처리하지 못했습니다.', 503);
}

function toRecord(kind: PaperJournalRecordKind, row: StorageRow): StoredPaperJournalRecord {
  return {
    kind, id: row.id, payload: row.payload ?? {}, version: Number(row.version),
    updatedAt: row.updated_at, deletedAt: row.deleted_at,
    createdAt: row.created_at, serverUpdatedAt: row.updated_at,
  };
}

async function deleteRows(client: SupabaseClient, table: string, userId: string) {
  const { data, error } = await client.from(table).delete().eq('user_id', userId).select('id');
  if (error) throw databaseFailure();
  return Array.isArray(data) ? data.length : 0;
}

async function readAllRows(client: SupabaseClient, table: string, userId: string) {
  const rows: StorageRow[] = [];
  for (let offset = 0; ; offset += DATABASE_READ_PAGE_SIZE) {
    const { data, error } = await client
      .from(table)
      .select('id,payload,version,deleted_at,created_at,updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + DATABASE_READ_PAGE_SIZE - 1);
    if (error) throw databaseFailure();
    const page = (data ?? []) as StorageRow[];
    rows.push(...page);
    if (page.length < DATABASE_READ_PAGE_SIZE) break;
  }
  return rows;
}

function createScopedPaperJournalRepository(
  client: SupabaseClient,
  authenticatedUserId: string,
): PaperJournalRepository {
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

    async upsertRecord(userId, record, serverTime) {
      assertOwner(userId);
      const row = {
        user_id: authenticatedUserId, id: record.id, payload: record.payload,
        version: record.version, deleted_at: record.deletedAt, updated_at: serverTime,
      };
      if (record.kind === 'account' && record.id.startsWith('automatic-paper-admin-v2:')) {
        throw new PaperJournalError('ADMIN_MARKET_WALLET_SERVER_ONLY',
          '관리자 시장별 모의계좌는 일반 동기화로 변경할 수 없습니다.', 403);
      }
      const isAutoWallet = record.kind === 'account'
        && record.id === 'automatic-paper-account-v1';
      if (isAutoWallet && (record.version !== 1 || record.deletedAt !== null)) {
        throw new PaperJournalError('AUTOMATIC_PAPER_WALLET_REWRITE_FORBIDDEN',
          '자동모의매매 기준자본 재설정은 허용되지 않습니다.', 409);
      }
      // The DB unique (user_id,id) constraint makes wallet initialization
      // insert-once, not an upsert that silently overwrites a concurrent epoch.
      const query = isAutoWallet
        ? client.from(TABLES[record.kind]).insert(row)
        : client.from(TABLES[record.kind]).upsert(row, { onConflict: 'user_id,id' });
      const { data, error } = await query
        .select('id,payload,version,deleted_at,created_at,updated_at').single();
      if (isAutoWallet && error?.code === '23505') {
        throw new PaperJournalError('AUTOMATIC_PAPER_WALLET_ALREADY_EXISTS',
          '자동모의매매 가상계좌가 이미 존재합니다.', 409);
      }
      if (error || !data) throw databaseFailure();
      return toRecord(record.kind, data as StorageRow);
    },

    async listSnapshot(userId) {
      assertOwner(userId);
      const records: StoredPaperJournalRecord[] = [];
      for (const kind of Object.keys(TABLES) as PaperJournalRecordKind[]) {
        for (const row of await readAllRows(client, TABLES[kind], authenticatedUserId)) records.push(toRecord(kind, row));
      }
      return records;
    },

    async getIdempotentResponse(userId, idempotencyKey) {
      assertOwner(userId);
      const { data, error } = await client.from('paper_sync_state').select('payload')
        .eq('user_id', authenticatedUserId).eq('id', `request:${idempotencyKey}`)
        .eq('state_type', 'request').maybeSingle();
      if (error) throw databaseFailure();
      return data?.payload ? data.payload as PaperJournalSyncResult : null;
    },

    async saveIdempotentResponse(userId, idempotencyKey, result, serverTime) {
      assertOwner(userId);
      const { error } = await client.from('paper_sync_state').upsert({
        user_id: authenticatedUserId, id: `request:${idempotencyKey}`,
        state_type: 'request', status: 'completed', payload: result,
        version: 1, updated_at: serverTime,
      }, { onConflict: 'user_id,id' });
      if (error) throw databaseFailure();
    },

    async saveConflict(userId, conflict) {
      assertOwner(userId);
      const { error } = await client.from('paper_sync_state').upsert({
        user_id: authenticatedUserId, id: conflict.id, state_type: 'conflict',
        status: 'open', payload: conflict, version: conflict.version,
        updated_at: conflict.createdAt,
      }, { onConflict: 'user_id,id' });
      if (error) throw databaseFailure();
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
      const { error } = await client.from('paper_sync_state')
        .update({ status: 'resolved', updated_at: serverTime })
        .eq('user_id', authenticatedUserId).eq('id', conflictId).eq('state_type', 'conflict');
      if (error) throw databaseFailure();
    },

    async listJournalPayloads(userId) {
      assertOwner(userId);
      const rows = await readAllRows(client, 'paper_journal_entries', authenticatedUserId);
      return rows.filter((row) => row.deleted_at == null).map((row) => row.payload as Record<string, unknown>);
    },

    async deleteAll(userId) {
      assertOwner(userId);
      const { data: reserved, error: checkError } = await client.from('paper_accounts')
        .select('id').eq('user_id', authenticatedUserId)
        .like('id', 'automatic-paper-admin-v2:%').limit(1);
      if (checkError) throw databaseFailure();
      if (reserved?.length) {
        throw new PaperJournalError('ADMIN_PAPER_CAMPAIGN_DELETE_FORBIDDEN',
          '시장별 독립 모의계좌와 보존 이력을 일괄 삭제할 수 없습니다.', 409);
      }
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

export function createSupabasePaperJournalRepository(
  accessToken: string,
  authenticatedUserId: string,
): PaperJournalRepository {
  if (!accessToken || !authenticatedUserId) {
    throw new PaperJournalError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);
  }
  return createScopedPaperJournalRepository(getUserSupabase(accessToken), authenticatedUserId);
}

export function createServiceRolePaperJournalRepository(
  authenticatedUserId: string,
  injectedClient?: SupabaseClient,
): PaperJournalRepository {
  if (!authenticatedUserId) throw new PaperJournalError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);
  if (!injectedClient && !hasSupabaseServerKey()) {
    throw new PaperJournalError(
      'PAPER_JOURNAL_SERVICE_ROLE_REQUIRED',
      '서버 거래일지 권한이 필요합니다.',
      503,
    );
  }
  return createScopedPaperJournalRepository(injectedClient ?? getSupabase(), authenticatedUserId);
}

export type { PaperJournalSyncRecord };
