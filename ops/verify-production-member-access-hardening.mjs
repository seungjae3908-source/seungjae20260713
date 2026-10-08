import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const staticMode = args.includes('--static');
const artifactFlag = args.find((value) => value.startsWith('--artifact='));
const artifactPath = artifactFlag?.slice('--artifact='.length)
  || (args.includes('--artifact') ? args[args.indexOf('--artifact') + 1] : '');

function fail(message) {
  throw new Error('[production-member-access-hardening] ' + message);
}

function requireText(source, needle, label) {
  if (!source.includes(needle)) fail(label + ' missing');
}

if (staticMode) {
  const apply = readFileSync(path.join(root, 'ops/apply-production-member-access-hardening.mjs'), 'utf8');
  const migration = readFileSync(
    path.join(root, 'api-server/supabase/migrations/2026100601_member_access_s_ai_hardening.sql'),
    'utf8',
  );
  const securityMigration = readFileSync(
    path.join(root, 'api-server/supabase/migrations/2026100801_member_security_definer_lockdown.sql'),
    'utf8',
  );

  for (const marker of [
    "const SCHEMA_VERSION = 'production-member-access-hardening-v2'",
    "const PRODUCTION_PROJECT_REF = 'bawcbkoyovbeajkrnduq'",
    'approved_target_sha_invalid',
    'production_database_project_mismatch',
    'atomic_member_access_migration_failed',
    'MEMBER_PROFILE_ROWS_CHANGED',
    'MEMBER_JOURNAL_ROWS_CHANGED',
    'MEMBER_AUDIT_ROWS_CHANGED',
    'MEMBER_HISTORICAL_STATUS_COUNTS_CHANGED',
    'MEMBER_PENDING_STATE_NOT_NORMALIZED',
    'order_submitted: false',
    'cancel_submitted: false',
    'amend_submitted: false',
    'transfer_submitted: false',
    'withdrawal_submitted: false',
    'live_trading_authority_granted: false',
    'auto_trading_authority_granted: false',
  ]) requireText(apply, marker, marker);

  for (const marker of [
    'membership_expires_at',
    "public.current_membership_level()",
    "public.is_approved_member()",
    "member.password.reset",
    "member.membership.expiry.change",
    "MEMBER_EXPIRY_INVALID",
    "public.current_membership_level() in ('associate', 'regular', 'admin')",
  ]) requireText(migration, marker, marker);

  for (const marker of [
    'MEMBER_TRIGGER_SECURITY_DEFINER_DIRECT_EXECUTE_PRESENT',
    'MEMBER_RLS_HELPER_PUBLIC_EXECUTE_PRESENT',
    'MEMBER_RLS_HELPER_AUTHENTICATED_EXECUTE_MISSING',
    'MEMBER_PERMISSION_RPC_EXECUTE_PRIVILEGE_INVALID',
    'MEMBER_PROFILE_PUBLIC_OR_ANON_PRIVILEGE_PRESENT',
    'MEMBER_PROFILE_AUTHENTICATED_PRIVILEGE_INVALID',
    'revoke all privileges on table public.profiles from public, anon, authenticated',
    'grant select on table public.profiles to authenticated',
    'revoke all on function %s from public, anon, authenticated',
    "grant execute on function %s to authenticated",
  ]) requireText(securityMigration, marker, marker);

  if (/(?:placeOrder|cancelOrder|amendOrder|transfer\(|withdraw\()/i.test(apply)) {
    fail('production member DB gate must not import or call trading mutations');
  }
  console.log('[production-member-access-hardening] static contract verified');
  process.exit(0);
}

if (!artifactPath) fail('artifact path required');
const artifact = JSON.parse(readFileSync(path.resolve(artifactPath), 'utf8'));
for (const [key, value] of Object.entries({
  schemaVersion: 'production-member-access-hardening-v2',
  status: 'passed',
  production_project_match: true,
  atomic_transaction: true,
  migration_applied: 2,
  security_definer_privileges_locked: true,
  permission_rpc_least_access: true,
  profile_api_privileges_least_access: true,
  membership_expiry_ready: true,
  associate_s_ai_policy_ready: true,
  associate_journal_read_only: true,
  historical_statuses_preserved: true,
  profile_row_count_preserved: true,
  journal_row_count_preserved: true,
  audit_row_count_preserved: true,
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
})) {
  if (artifact?.[key] !== value) fail('artifact contract mismatch: ' + key);
}
if (!/^[0-9a-f]{40}$/.test(String(artifact?.approved_target_sha ?? ''))) {
  fail('approved target SHA invalid');
}
if (!['direct', 'pooler'].includes(String(artifact?.database_endpoint_type ?? ''))) {
  fail('database endpoint type invalid');
}
console.log('[production-member-access-hardening] artifact verified');
