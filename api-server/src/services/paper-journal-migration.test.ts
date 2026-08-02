import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const migrationPath = path.join(process.cwd(), 'api-server/supabase/migrations/2026080201_journal_sync_analytics_phase7.sql');
const sql = readFileSync(migrationPath, 'utf8');
const tables = ['paper_accounts', 'paper_orders', 'paper_positions', 'paper_fills', 'paper_journal_entries', 'paper_sync_state'];

test('migration is explicitly review only', () => {
  assert.match(sql, /Do not apply it to the production database/i);
});

for (const table of tables) {
  test(`${table} table is created`, () => {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}\\s*\\(`, 'i'));
  });

  test(`${table} has user_id ownership`, () => {
    const block = sql.slice(sql.indexOf(`create table if not exists public.${table}`));
    assert.match(block.slice(0, block.indexOf(');') + 2), /user_id uuid not null references auth\.users\(id\) on delete cascade/i);
  });

  test(`${table} has required timestamps and version`, () => {
    const block = sql.slice(sql.indexOf(`create table if not exists public.${table}`));
    const definition = block.slice(0, block.indexOf(');') + 2);
    assert.match(definition, /created_at timestamptz not null/i);
    assert.match(definition, /updated_at timestamptz not null/i);
    assert.match(definition, /version bigint not null/i);
  });

  test(`${table} uses user scoped unique primary key`, () => {
    const block = sql.slice(sql.indexOf(`create table if not exists public.${table}`));
    assert.match(block.slice(0, block.indexOf(');') + 2), /primary key \(user_id, id\)/i);
  });

  test(`${table} enables row level security`, () => {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  });
}

test('RLS loop includes every Phase 7 table', () => {
  for (const table of tables) assert.match(sql, new RegExp(`'${table}'`));
});

test('select policy uses auth.uid ownership', () => {
  assert.match(sql, /for select using \(auth\.uid\(\) = user_id\)/i);
});

test('insert policy uses auth.uid ownership check', () => {
  assert.match(sql, /for insert with check \(auth\.uid\(\) = user_id\)/i);
});

test('update policy checks old and new ownership', () => {
  assert.match(sql, /for update using \(auth\.uid\(\) = user_id\) with check \(auth\.uid\(\) = user_id\)/i);
});

test('delete policy uses auth.uid ownership', () => {
  assert.match(sql, /for delete using \(auth\.uid\(\) = user_id\)/i);
});

test('migration does not add admin browsing policy', () => {
  assert.doesNotMatch(sql, /admin.*policy|role.*admin/i);
});

test('migration does not contain service role key', () => {
  assert.doesNotMatch(sql, /service_role|SUPABASE_SECRET|API_KEY|AUTHORIZATION/i);
});

test('migration keeps deletion tombstone column', () => {
  assert.equal((sql.match(/deleted_at timestamptz/g) ?? []).length, 6);
});

test('sync state separates request conflict and device rows', () => {
  assert.match(sql, /state_type in \('request', 'conflict', 'device'\)/i);
});

test('migration is transactional', () => {
  assert.match(sql, /^--[\s\S]*\nbegin;/i);
  assert.match(sql, /commit;\s*$/i);
});
