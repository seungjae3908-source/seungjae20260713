'use strict';

const EXACT_SHA = /^[0-9a-f]{40}$/;

function normalizeSha(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return EXACT_SHA.test(normalized) ? normalized : null;
}

function result(ok, reason) {
  return { ok, reason };
}

function validateStagingPostgresEvidence(value, targetSha) {
  const target = normalizeSha(targetSha);
  if (!target) return result(false, 'target_sha_invalid');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return result(false, 'artifact_invalid');
  }
  if (value.status !== 'passed') return result(false, 'status_not_passed');
  if (value.classification !== 'authenticated') return result(false, 'not_authenticated');
  if (value.project_match !== true) return result(false, 'project_mismatch');
  if (value.read_only_probe !== true) return result(false, 'read_only_probe_missing');
  if (value.transaction_rolled_back !== true) return result(false, 'rollback_missing');
  if (value.database_changed !== false) return result(false, 'database_changed');
  if (value.credentials_recorded !== false) return result(false, 'credentials_recorded');
  return result(true, 'accepted');
}

function validateProductionDatabaseEvidence(value, targetSha) {
  const target = normalizeSha(targetSha);
  if (!target) return result(false, 'target_sha_invalid');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return result(false, 'artifact_invalid');
  }
  const checks = [
    [value.schemaVersion === 'production-paper-journal-storage-v2', 'schema_version_mismatch'],
    [value.status === 'passed', 'status_not_passed'],
    [normalizeSha(value.approved_target_sha) === target, 'target_sha_mismatch'],
    [value.production_project_match === true, 'project_mismatch'],
    [value.atomic_transaction === true, 'atomic_transaction_missing'],
    [value.table_contract_verified === true, 'table_contract_unverified'],
    [value.policy_contract_verified === true, 'policy_contract_unverified'],
    [value.rls_preserved === true, 'rls_not_preserved'],
    [value.journal_rows_mutated === false, 'journal_rows_mutated'],
    [value.database_changed === false, 'database_changed'],
    [value.credentials_read === false, 'credentials_read'],
    [value.raw_credentials_exposed === false, 'raw_credentials_exposed'],
    [value.order_submitted === false, 'order_submitted'],
    [value.cancel_submitted === false, 'cancel_submitted'],
    [value.amend_submitted === false, 'amend_submitted'],
    [value.transfer_submitted === false, 'transfer_submitted'],
    [value.withdrawal_submitted === false, 'withdrawal_submitted'],
    [value.private_trading_api_count === 0, 'private_trading_api_used'],
    [value.live_trading_authority_granted === false, 'live_authority_granted'],
    [value.auto_trading_authority_granted === false, 'auto_authority_granted'],
  ];
  const failed = checks.find(([ok]) => !ok);
  return failed ? result(false, failed[1]) : result(true, 'accepted');
}

module.exports = {
  normalizeSha,
  validateProductionDatabaseEvidence,
  validateStagingPostgresEvidence,
};
