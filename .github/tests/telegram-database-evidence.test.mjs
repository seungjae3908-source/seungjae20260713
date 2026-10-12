import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  validateProductionDatabaseEvidence,
  validateStagingPostgresEvidence,
} = require('../../api-server/scripts/telegram-database-evidence.cjs');

const sha = 'e2b0dc554120aeffa739c951b68c93e4834508b0';

const productionEvidence = {
  schemaVersion: 'production-paper-journal-storage-v2',
  status: 'passed',
  approved_target_sha: sha,
  production_project_match: true,
  atomic_transaction: true,
  table_contract_verified: true,
  policy_contract_verified: true,
  rls_preserved: true,
  journal_rows_mutated: false,
  database_changed: false,
  credentials_read: false,
  raw_credentials_exposed: false,
  order_submitted: false,
  cancel_submitted: false,
  amend_submitted: false,
  transfer_submitted: false,
  withdrawal_submitted: false,
  private_trading_api_count: 0,
  live_trading_authority_granted: false,
  auto_trading_authority_granted: false,
};

test('accepts exact-SHA successful Production DB safety evidence', () => {
  assert.deepEqual(validateProductionDatabaseEvidence(productionEvidence, sha), {
    ok: true,
    reason: 'accepted',
  });
});

for (const [name, patch, reason] of [
  ['stale SHA', { approved_target_sha: 'a'.repeat(40) }, 'target_sha_mismatch'],
  ['database mutation', { database_changed: true }, 'database_changed'],
  ['order mutation', { order_submitted: true }, 'order_submitted'],
  ['credential exposure', { raw_credentials_exposed: true }, 'raw_credentials_exposed'],
  ['trading authority', { auto_trading_authority_granted: true }, 'auto_authority_granted'],
]) {
  test(`rejects Production evidence with ${name}`, () => {
    assert.deepEqual(validateProductionDatabaseEvidence({ ...productionEvidence, ...patch }, sha), {
      ok: false,
      reason,
    });
  });
}

test('keeps exact-SHA staging read-only authentication as an accepted source', () => {
  const result = validateStagingPostgresEvidence({
    status: 'passed',
    classification: 'authenticated',
    project_match: true,
    read_only_probe: true,
    transaction_rolled_back: true,
    database_changed: false,
    credentials_recorded: false,
  }, sha);
  assert.deepEqual(result, { ok: true, reason: 'accepted' });
});

test('rejects staging authentication without rollback proof', () => {
  const result = validateStagingPostgresEvidence({
    status: 'passed',
    classification: 'authenticated',
    project_match: true,
    read_only_probe: true,
    transaction_rolled_back: false,
    database_changed: false,
    credentials_recorded: false,
  }, sha);
  assert.deepEqual(result, { ok: false, reason: 'rollback_missing' });
});
