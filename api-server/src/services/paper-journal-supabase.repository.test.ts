import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { createSupabasePaperJournalRepository } from './paper-journal-supabase.repository';
import { PaperJournalError, type PaperJournalSyncRecord, type PaperJournalConflict } from './paper-journal.types';
import { syncPaperJournal } from './paper-journal-sync.service';
import { paperJournalFixture } from './paper-journal-test-fixture';

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const NOW = new Date('2026-08-02T05:00:00.000Z');
const stamp = NOW.toISOString();
const code = (expected: string) => (error: unknown) => error instanceof PaperJournalError && error.code === expected;
const record = (note = '', version = 1): PaperJournalSyncRecord => ({
  kind: 'journal', id: 'trade-1', payload: { ...paperJournalFixture('trade-1', stamp), note }, version, deletedAt: null, updatedAt: stamp,
});
type Row = Record<string, unknown> & { user_id: string; id: string; payload: Record<string, unknown>; version: number };

// The real Supabase/PostgREST request builder runs against this isolated transport.
// It models unique insertion and atomic conditional updates, never contacts a DB.
function fixture() {
  const tables = new Map<string, Map<string, Row>>();
  const calls: Array<{ method: string; url: URL }> = [];
  let beforeWrite: ((table: string, row: Row) => void) | undefined;
  let beforeRead: ((table: string) => void) | undefined;
  let corruptReads = false;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, 'paper-repository.invalid');
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const tableName = url.pathname.split('/').at(-1)!;
    const table = tables.get(tableName) ?? new Map<string, Row>();
    tables.set(tableName, table);
    const headers = new Headers(init?.headers);
    const result = (value: unknown, status = 200, total?: number) => new Response(JSON.stringify(value), { status, headers: {
      'content-type': 'application/json', ...(total === undefined ? {} : { 'content-range': `0-499/${total}` }),
    } });
    const single = headers.get('accept')?.includes('vnd.pgrst.object');
    const matches = (row: Row) => [...url.searchParams].every(([key, value]) => {
      if (['select', 'order', 'offset', 'limit'].includes(key)) return true;
      const field = key === 'payload->>requestFingerprint' ? row.payload.requestFingerprint : row[key];
      if (value.startsWith('gt.')) return typeof field === 'string' && field > value.slice(3);
      return value === `eq.${String(field)}`;
    });
    if (method === 'POST') {
      const row = JSON.parse(String(init?.body)) as Row;
      beforeWrite?.(tableName, row);
      const key = `${row.user_id}:${row.id}`;
      if (table.has(key)) return result({ code: '23505', message: 'duplicate' }, 409);
      const stored = { created_at: stamp, deleted_at: null, ...row };
      table.set(key, stored);
      return result(single ? stored : [stored], 201);
    }
    if (method === 'PATCH') {
      const update = JSON.parse(String(init?.body)) as Row;
      beforeWrite?.(tableName, update);
      const modified: Row[] = [];
      for (const [key, row] of table) if (matches(row)) {
        const changed = { ...row, ...update };
        table.set(key, changed); modified.push(changed);
      }
      return result(single ? modified[0] ?? null : modified);
    }
    assert.equal(method, 'GET');
    beforeRead?.(tableName);
    if (corruptReads) return result(null);
    const rows = [...table.values()].filter(matches).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const limit = Number(url.searchParams.get('limit') ?? rows.length);
    return result(single ? rows[0] ?? null : rows.slice(0, limit), 200, rows.length);
  };
  const client = createClient('https://paper-repository.invalid', 'synthetic-publishable-key', {
    global: { fetch: transport }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return { tables, calls, repository: createSupabasePaperJournalRepository('synthetic-user-token', USER, client),
    onWrite(fn: typeof beforeWrite) { beforeWrite = fn; }, onRead(fn: typeof beforeRead) { beforeRead = fn; },
    corruptReads() { corruptReads = true; } };
}

test('repository insert race preserves one winner; no overwrite upsert is sent', async () => {
  const { repository, calls } = fixture();
  const results = await Promise.allSettled([
    repository.upsertRecord(USER, record('first'), stamp, null),
    repository.upsertRecord(USER, record('second'), stamp, null),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const failure = results.find((r) => r.status === 'rejected');
  assert.ok(failure?.status === 'rejected' && code('JOURNAL_VERSION_CHANGED')(failure.reason));
  assert.equal((await repository.getRecord(USER, 'journal', 'trade-1'))?.payload.note, 'first');
  assert.equal(calls.some((c) => c.url.searchParams.has('on_conflict')), false);
});

test('repository competing updates require the observed version and retain the winner', async () => {
  const { repository, calls } = fixture();
  await repository.upsertRecord(USER, record('initial'), stamp);
  const results = await Promise.allSettled([
    repository.upsertRecord(USER, record('first', 2), stamp, 1),
    repository.upsertRecord(USER, record('second', 2), stamp, 1),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await repository.getRecord(USER, 'journal', 'trade-1'))?.payload.note, 'first');
  for (const call of calls.filter((c) => c.method === 'PATCH')) {
    assert.equal(call.url.searchParams.get('version'), 'eq.1');
    assert.equal(call.url.searchParams.get('user_id'), `eq.${USER}`);
    assert.equal(call.url.searchParams.get('id'), 'eq.trade-1');
  }
});

test('service does not acknowledge an update that lost its version race', async () => {
  const f = fixture();
  await f.repository.upsertRecord(USER, record('initial'), stamp);
  f.onWrite((table) => {
    if (table !== 'paper_journal_entries') return;
    const current = f.tables.get(table)!.get(`${USER}:trade-1`)!;
    current.version = 2;
    current.payload.note = 'another-device';
    f.onWrite(undefined);
  });
  const result = await syncPaperJournal(f.repository, USER, { idempotencyKey: 'version-race-test', clientTime: stamp, records: [record('lost', 2)] }, NOW);
  assert.equal(result.uploaded.length, 0);
  assert.equal(result.failed[0]?.code, 'JOURNAL_VERSION_CHANGED');
  assert.equal((await f.repository.getRecord(USER, 'journal', 'trade-1'))?.payload.note, 'another-device');
});

test('durable request claim blocks other process and different payload before ledger writes', async () => {
  const { repository, calls } = fixture();
  const fingerprint = 'a'.repeat(64);
  assert.equal(await repository.claimSyncRequest!(USER, 'durable-claim-test', fingerprint, stamp), null);
  await assert.rejects(repository.claimSyncRequest!(USER, 'durable-claim-test', fingerprint, stamp), code('SYNC_REQUEST_IN_PROGRESS'));
  await assert.rejects(repository.claimSyncRequest!(USER, 'durable-claim-test', 'b'.repeat(64), stamp), code('IDEMPOTENCY_CONTEXT_MISMATCH'));
  assert.equal(calls.some((c) => c.url.pathname.endsWith('/paper_journal_entries')), false);
});

test('completed request is immutable and bound to the claiming fingerprint', async () => {
  const { repository, tables } = fixture();
  const input = { idempotencyKey: 'completed-claim-test', clientTime: stamp, records: [record('original')] };
  const first = await syncPaperJournal(repository, USER, input, NOW);
  assert.equal(first.uploaded.length, 1);
  const second = await syncPaperJournal(repository, USER, input, NOW);
  assert.deepEqual(second, first);
  await assert.rejects(repository.saveIdempotentResponse(USER, input.idempotencyKey, { ...first, requestFingerprint: 'b'.repeat(64) }, stamp), code('JOURNAL_STORAGE_UNAVAILABLE'));
  assert.equal(tables.get('paper_sync_state')!.get(`${USER}:request:${input.idempotencyKey}`)!.payload.requestFingerprint, first.requestFingerprint);
});

test('repository rejects another owner before any transport call', async () => {
  const { repository, calls } = fixture();
  await assert.rejects(repository.upsertRecord(OTHER, record(), stamp), code('USER_SCOPE_MISMATCH'));
  await assert.rejects(repository.claimSyncRequest!(OTHER, 'other-owner-test', 'a'.repeat(64), stamp), code('USER_SCOPE_MISMATCH'));
  assert.equal(calls.length, 0);
});

test('stable database read pages by immutable identity and verifies completeness', async () => {
  const f = fixture();
  const table = new Map<string, Row>();
  for (let index = 0; index < 501; index += 1) {
    const id = `trade-${String(index).padStart(4, '0')}`;
    table.set(`${USER}:${id}`, { user_id: USER, id, payload: {}, version: 1, created_at: stamp, updated_at: stamp, deleted_at: null });
  }
  f.tables.set('paper_journal_entries', table);
  const rows = await f.repository.listSnapshot(USER);
  assert.equal(rows.length, 501);
  assert.equal(new Set(rows.map((r) => r.id)).size, 501);
  const pages = f.calls.filter((call) => call.url.pathname.endsWith('/paper_journal_entries'));
  assert.equal(pages.length, 4, 'two complete passes, each with two pages');
  assert.equal(pages[1].url.searchParams.get('id'), 'gt.trade-0499');
  assert.equal(pages.some((p) => p.url.searchParams.has('offset')), false);
});

test('mutation during snapshot collection is rejected rather than returning mixed versions', async () => {
  const f = fixture();
  await f.repository.upsertRecord(USER, record(), stamp);
  let reads = 0;
  f.onRead((table) => {
    if (table === 'paper_accounts' && ++reads === 2) {
      const row = f.tables.get('paper_journal_entries')!.get(`${USER}:trade-1`)!;
      row.version = 2; row.payload.note = 'concurrent update';
    }
  });
  await assert.rejects(f.repository.listSnapshot(USER), code('SNAPSHOT_CHANGED'));
});

test('null or count-less storage response cannot become an empty snapshot', async () => {
  const f = fixture();
  f.corruptReads();
  await assert.rejects(f.repository.listSnapshot(USER), code('JOURNAL_STORAGE_UNAVAILABLE'));
});

test('database version strings are rejected without numeric coercion', async () => {
  const f = fixture();
  await f.repository.upsertRecord(USER, record(), stamp);
  const row = f.tables.get('paper_journal_entries')!.get(`${USER}:trade-1`)!;
  Object.assign(row, { version: '1' });
  await assert.rejects(f.repository.getRecord(USER, 'journal', 'trade-1'), code('JOURNAL_STORAGE_UNAVAILABLE'));
});

test('resolved conflicts cannot be reopened or resolved a second time', async () => {
  const { repository } = fixture();
  const server = await repository.upsertRecord(USER, record('server'), stamp);
  const conflict: PaperJournalConflict = {
    id: 'conflict:repository-test', kind: 'journal', recordId: 'trade-1', version: 1,
    serverRecord: server, deviceRecord: record('device'), differenceSummary: ['note changed'], createdAt: stamp, status: 'open',
  };
  await repository.saveConflict(USER, conflict);
  await repository.saveConflict(USER, conflict);
  await repository.markConflictResolved(USER, conflict.id, stamp);
  await assert.rejects(repository.saveConflict(USER, conflict), code('CONFLICT_STALE'));
  await assert.rejects(repository.markConflictResolved(USER, conflict.id, stamp), code('CONFLICT_STALE'));
  assert.equal((await repository.getConflict(USER, conflict.id))?.status, 'resolved');
});

test('database clock defaults cannot place creation after server publication time', async () => {
  const f = fixture();
  f.onWrite((table, row) => {
    if (table === 'paper_journal_entries') assert.equal(row.created_at, stamp);
  });
  const stored = await f.repository.upsertRecord(USER, record(), stamp);
  assert.equal(stored.createdAt, stored.serverUpdatedAt);
});
