import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyStagingTradingAdminProfile as classify, verifyStagingTradingAdminReadOnly as verify } from '../../api-server/scripts/staging-trading-core-admin-profile.mjs';

const uid = '00000000-0000-4000-8000-000000000111';
const profile = (v = {}) => ({
  id: uid, status: 'approved', is_active: true, role: 'user', membership_level: 'admin',
  permissions_updated_at: '2026-01-01T00:00:00.000Z', membership_expires_at: null, ...v,
});
test('member-tier admin with ordinary role has real admin capability', () => {
  const v = classify(profile(), uid);
  assert.equal(v.ready, true);
  assert.equal(v.adminRole, false);
  assert.equal(v.adminTier, true);
});
test('unapproved, inactive, regular, expired and wrong identity all fail closed', () => {
  for (const [p, code] of [
    [profile({ status: 'pending' }), 'STAGING_CORE_ADMIN_PROFILE_UNAPPROVED'],
    [profile({ is_active: false }), 'STAGING_CORE_ADMIN_PROFILE_INACTIVE'],
    [profile({ membership_level: 'regular', role: 'admin' }), 'STAGING_CORE_ADMIN_PROFILE_CAPABILITY_MISSING'],
    [profile({ membership_expires_at: '2020-01-01T00:00:00.000Z' }), 'STAGING_CORE_ADMIN_PROFILE_CAPABILITY_MISSING'],
    [profile({ id: 'other' }), 'STAGING_CORE_ADMIN_PROFILE_IDENTITY_MISMATCH'],
  ]) assert.equal(classify(p, uid).code, code);
});
const env = {
  STAGING_BASE_URL: 'https://staging.example.test',
  SUPABASE_URL: 'https://petlfbztqguuzkasfpug.supabase.co',
  SUPABASE_ANON_KEY: 'mock-anon',
  ADMIN_EMAIL: 'mock-admin@example.test',
  ADMIN_PASSWORD: 'mock-password',
};
const fakeRequests = (overrides = {}, paperStatus = 200) => {
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, method: options.method });
    if (url.pathname === '/auth/v1/token') return new Response(JSON.stringify({
      user: { id: uid }, access_token: 'mock-25-char-access-token-that-is-safe',
    }), { status: 200 });
    if (url.pathname === '/api/auth/profile') return new Response(JSON.stringify(profile(overrides)), { status: 200 });
    if (url.pathname === '/api/paper-journal/admin-four-market/status') return new Response(JSON.stringify({
      ok: true, readOnlyProbe: true, financialMutationCount: 0, privateProviderRequests: 0,
      orderSubmitted: false, exchangeRequestSent: false, liveTradingAuthorityGranted: false,
    }), { status: paperStatus });
    throw new Error('UNEXPECTED_TEST_ROUTE');
  };
  return { fetchImpl, calls };
};
test('protected preflight authenticates once and performs two read-only owner-scoped GETs', async () => {
  const { fetchImpl, calls } = fakeRequests();
  const result = await verify({ env, fetchImpl });
  assert.equal(result.ready, true);
  assert.equal(result.paperReadOnly, true);
  assert.deepEqual(calls, [
    { path: '/auth/v1/token', method: 'POST' },
    { path: '/api/auth/profile', method: 'GET' },
    { path: '/api/paper-journal/admin-four-market/status', method: 'GET' },
  ]);
});
test('pending fixture halts before Paper API read or any staging deploy', async () => {
  const { fetchImpl, calls } = fakeRequests({ status: 'pending' });
  await assert.rejects(verify({ env, fetchImpl }), /STAGING_CORE_ADMIN_PROFILE_UNAPPROVED/);
  assert.equal(calls.some(x => x.path.includes('paper-journal')), false);
});
test('canonical admin route 403 remains fatal even with approved profile', async () => {
  const { fetchImpl } = fakeRequests({}, 403);
  await assert.rejects(verify({ env, fetchImpl }), /STAGING_CORE_ADMIN_PAPER_READ_HTTP_403/);
});
test('Production and unexpected Supabase projects rejected before network', async () => {
  let networkTouched = false;
  const fetchImpl = async () => { networkTouched = true; throw new Error('NETWORK_NOT_ALLOWED'); };
  await assert.rejects(verify({ env: { ...env, SUPABASE_URL: 'https://bawcbkoyovbeajkrnduq.supabase.co' }, fetchImpl }), /STAGING_CORE_ADMIN_ISOLATED_PROJECT_REQUIRED/);
  await assert.rejects(verify({ env: { ...env, STAGING_BASE_URL: 'https://lsj119.com' }, fetchImpl }), /STAGING_CORE_ADMIN_PRODUCTION_ORIGIN_FORBIDDEN/);
  assert.equal(networkTouched, false);
});
