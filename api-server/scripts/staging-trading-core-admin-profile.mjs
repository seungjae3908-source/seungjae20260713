import { pathToFileURL } from 'node:url';
import { hasCapability } from '../../packages/member-access/src/index.js';
import { runStagingAdminAuthPreflight } from './verify-staging-admin-auth-preflight.mjs';

// Server authorization uses canonical DB member capabilities, not role alone.
export function classifyStagingTradingAdminProfile(profile, expectedId) {
  const row = profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {};
  const flags = Object.freeze({
    identityMatch: typeof expectedId === 'string' && expectedId.length > 0 && row.id === expectedId,
    statusApproved: row.status === 'approved',
    accountActive: row.is_active === true,
    adminTier: row.membership_level === 'admin',
    adminRole: row.role === 'admin' || row.role === 'master',
    canManageMembers: hasCapability(row, 'canManageMembers'),
    canAccessJournalSync: hasCapability(row, 'canAccessJournalSync'),
  });
  const code = !flags.identityMatch ? 'STAGING_CORE_ADMIN_PROFILE_IDENTITY_MISMATCH'
    : !flags.statusApproved ? 'STAGING_CORE_ADMIN_PROFILE_UNAPPROVED'
    : !flags.accountActive ? 'STAGING_CORE_ADMIN_PROFILE_INACTIVE'
    : !flags.canManageMembers || !flags.canAccessJournalSync
      ? 'STAGING_CORE_ADMIN_PROFILE_CAPABILITY_MISSING'
      : 'STAGING_CORE_ADMIN_PROFILE_READY';
  return Object.freeze({ ...flags, code, ready: code === 'STAGING_CORE_ADMIN_PROFILE_READY' });
}

function required(env, name) {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new Error('STAGING_CORE_ADMIN_PREFLIGHT_CONFIG_MISSING_' + name);
  return value;
}

export async function verifyStagingTradingAdminReadOnly({ env = process.env, fetchImpl = fetch } = {}) {
  const staging = new URL(required(env, 'STAGING_BASE_URL'));
  const auth = new URL(required(env, 'SUPABASE_URL'));
  if (staging.protocol !== 'https:' || staging.hostname === 'lsj119.com'
      || staging.hostname === 'www.lsj119.com' || staging.hostname.endsWith('.supabase.co')) {
    throw new Error('STAGING_CORE_ADMIN_PRODUCTION_ORIGIN_FORBIDDEN');
  }
  if (auth.protocol !== 'https:' || auth.hostname !== 'petlfbztqguuzkasfpug.supabase.co') {
    throw new Error('STAGING_CORE_ADMIN_ISOLATED_PROJECT_REQUIRED');
  }
  // Reuse helper that masks the authenticated user ID, bearer and digest.
  const { userId, accessToken } = await runStagingAdminAuthPreflight({ env, fetchImpl });
  const headers = { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' };
  const get = (pathname) => fetchImpl(new URL(pathname, staging), {
    method: 'GET', headers, signal: AbortSignal.timeout(15_000),
  });
  const profileResponse = await get('/api/auth/profile');
  if (profileResponse.status !== 200) throw new Error('STAGING_CORE_ADMIN_PROFILE_HTTP_' + profileResponse.status);
  const profile = await profileResponse.json().catch(() => null);
  const verdict = classifyStagingTradingAdminProfile(profile, userId);
  // Never output identity, raw profile, role string, token, email or password.
  console.log('STAGING_CORE_ADMIN_PROFILE_FLAGS ' +
    ['identityMatch', 'statusApproved', 'accountActive', 'adminTier',
     'adminRole', 'canManageMembers', 'canAccessJournalSync']
      .map(key => key + '=' + verdict[key]).join(' '));
  if (!verdict.ready) throw new Error(verdict.code);
  // Prove the real server-side admin and Journal capabilities and no mutation.
  const paperResponse = await get('/api/paper-journal/admin-four-market/status');
  if (paperResponse.status !== 200) throw new Error('STAGING_CORE_ADMIN_PAPER_READ_HTTP_' + paperResponse.status);
  const paper = await paperResponse.json().catch(() => null);
  if (paper?.ok !== true || paper?.readOnlyProbe !== true
      || paper?.financialMutationCount !== 0 || paper?.privateProviderRequests !== 0
      || paper?.orderSubmitted !== false || paper?.exchangeRequestSent !== false
      || paper?.liveTradingAuthorityGranted !== false) {
    throw new Error('STAGING_CORE_ADMIN_PAPER_READONLY_CONTRACT_INVALID');
  }
  console.log('STAGING_CORE_ADMIN_PAPER_READONLY_PASS');
  return Object.freeze({ ...verdict, paperReadOnly: true });
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  verifyStagingTradingAdminReadOnly().catch((error) => {
    const code = typeof error?.message === 'string' && /^[A-Z][A-Z0-9_]{3,120}$/.test(error.message)
      ? error.message : 'STAGING_CORE_ADMIN_PREFLIGHT_UNEXPECTED_FAILURE';
    console.error(code);
    process.exitCode = 1;
  });
}
