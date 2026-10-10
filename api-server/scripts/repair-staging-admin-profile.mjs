import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const APPROVAL_TOKEN = 'STAGING_ADMIN_PROFILE_REPAIR_V1';
const EXPECTED_STAGING_REF = 'petlfbztqguuzkasfpug';
const KNOWN_PRODUCTION_REF = 'bawcbkoyovbeajkrnduq';
const PROFILE_FIELDS = 'id,status,is_active,membership_level,role,membership_expires_at,approved_at,approved_by,permissions_updated_at,updated_at';

function fail(code) {
  throw new Error(code);
}

function required(env, name) {
  const value = String(env[name] ?? '').trim();
  if (!value) fail(`STAGING_ADMIN_PROFILE_REPAIR_CONFIG_MISSING_${name}`);
  return value;
}

function projectRef(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail('STAGING_ADMIN_PROFILE_REPAIR_URL_INVALID');
  }
  if (parsed.protocol !== 'https:') fail('STAGING_ADMIN_PROFILE_REPAIR_HTTPS_REQUIRED');
  const match = /^([a-z0-9]+)\.supabase\.co$/u.exec(parsed.hostname);
  if (!match) fail('STAGING_ADMIN_PROFILE_REPAIR_PROJECT_HOST_INVALID');
  return match[1];
}

function client(url, key) {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export function classifyStagingAdminProfileRepair(profile, expectedId) {
  const row = profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {};
  if (!expectedId || row.id !== expectedId) return 'STAGING_ADMIN_PROFILE_REPAIR_IDENTITY_MISMATCH';
  const ready = row.status === 'approved' && row.is_active === true
    && row.membership_level === 'admin' && row.role === 'admin'
    && (row.membership_expires_at == null || row.membership_expires_at === '');
  if (ready) return 'STAGING_ADMIN_PROFILE_ALREADY_READY';
  const boundedPendingState = row.status === 'pending' && row.is_active === false
    && row.membership_level === 'pending' && row.role === 'user';
  return boundedPendingState
    ? 'STAGING_ADMIN_PROFILE_REPAIRABLE'
    : 'STAGING_ADMIN_PROFILE_REPAIR_UNSAFE_CURRENT_STATE';
}

export function buildStagingAdminProfileRepair(profile, expectedId, now) {
  const verdict = classifyStagingAdminProfileRepair(profile, expectedId);
  if (verdict !== 'STAGING_ADMIN_PROFILE_REPAIRABLE') fail(verdict);
  if (!Number.isFinite(Date.parse(now))) fail('STAGING_ADMIN_PROFILE_REPAIR_TIMESTAMP_INVALID');
  return Object.freeze({
    status: 'approved',
    is_active: true,
    membership_level: 'admin',
    role: 'admin',
    membership_expires_at: null,
    approved_at: now,
    approved_by: null,
    permissions_updated_at: now,
    updated_at: now,
  });
}

function safeFailure(error, prefix) {
  const code = String(error?.code ?? 'unknown').replace(/[^a-z0-9_-]/giu, '').slice(0, 48) || 'unknown';
  const status = Number.isFinite(Number(error?.status)) ? Number(error.status) : 0;
  fail(`${prefix}_${code}_${status || 'NOHTTP'}`.toUpperCase());
}

export async function repairStagingAdminProfile({ env = process.env } = {}) {
  if (required(env, 'REPAIR_APPROVED') !== APPROVAL_TOKEN) {
    fail('STAGING_ADMIN_PROFILE_REPAIR_APPROVAL_REQUIRED');
  }
  const url = required(env, 'SUPABASE_URL');
  const anonKey = required(env, 'SUPABASE_ANON_KEY');
  const secretKey = required(env, 'SUPABASE_SECRET_KEY');
  const email = required(env, 'ADMIN_EMAIL');
  const password = required(env, 'ADMIN_PASSWORD');
  const actualRef = projectRef(url);
  if (actualRef === KNOWN_PRODUCTION_REF) fail('STAGING_ADMIN_PROFILE_REPAIR_PRODUCTION_FORBIDDEN');
  if (actualRef !== EXPECTED_STAGING_REF) fail('STAGING_ADMIN_PROFILE_REPAIR_PROJECT_MISMATCH');
  if (anonKey === secretKey) fail('STAGING_ADMIN_PROFILE_REPAIR_KEYS_MUST_DIFFER');
  if (!email.includes('@') || /\s/u.test(email) || password.length < 8) {
    fail('STAGING_ADMIN_PROFILE_REPAIR_IDENTITY_CONFIG_INVALID');
  }

  const publicClient = client(url, anonKey);
  const login = await publicClient.auth.signInWithPassword({ email, password });
  if (login.error || !login.data?.user?.id) safeFailure(login.error, 'STAGING_ADMIN_PROFILE_REPAIR_LOGIN_FAILED');
  const userId = login.data.user.id;
  const service = client(url, secretKey);
  const before = await service.from('profiles').select(PROFILE_FIELDS).eq('id', userId).maybeSingle();
  if (before.error) safeFailure(before.error, 'STAGING_ADMIN_PROFILE_REPAIR_READ_FAILED');
  if (!before.data) fail('STAGING_ADMIN_PROFILE_REPAIR_PROFILE_MISSING');

  const classification = classifyStagingAdminProfileRepair(before.data, userId);
  if (classification === 'STAGING_ADMIN_PROFILE_ALREADY_READY') {
    console.log('[staging-admin-profile-repair] already_ready; profile_mutation=false; production_touched=false');
    return Object.freeze({ changed: false, userId });
  }
  const now = new Date().toISOString();
  const changes = buildStagingAdminProfileRepair(before.data, userId, now);
  const updated = await service.from('profiles')
    .update(changes)
    .eq('id', userId)
    .eq('status', 'pending')
    .eq('is_active', false)
    .eq('membership_level', 'pending')
    .eq('role', 'user')
    .select(PROFILE_FIELDS)
    .single();
  if (updated.error || !updated.data) safeFailure(updated.error, 'STAGING_ADMIN_PROFILE_REPAIR_UPDATE_FAILED');
  if (classifyStagingAdminProfileRepair(updated.data, userId) !== 'STAGING_ADMIN_PROFILE_ALREADY_READY') {
    fail('STAGING_ADMIN_PROFILE_REPAIR_READBACK_MISMATCH');
  }
  console.log('[staging-admin-profile-repair] repaired_one_configured_profile; production_touched=false; auth_user_mutation=false');
  return Object.freeze({ changed: true, userId });
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  repairStagingAdminProfile().catch((error) => {
    const message = String(error?.message ?? 'STAGING_ADMIN_PROFILE_REPAIR_UNEXPECTED_FAILURE')
      .replace(String(process.env.ADMIN_EMAIL ?? ''), '[REDACTED_EMAIL]')
      .replace(String(process.env.ADMIN_PASSWORD ?? ''), '[REDACTED_PASSWORD]')
      .replace(String(process.env.SUPABASE_ANON_KEY ?? ''), '[REDACTED_ANON_KEY]')
      .replace(String(process.env.SUPABASE_SECRET_KEY ?? ''), '[REDACTED_SECRET_KEY]');
    console.error(message);
    process.exitCode = 1;
  });
}
