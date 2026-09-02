// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { requireAuthenticated, requireCapability } from '../middleware/auth';
import { MEMBER_CAPABILITIES, MEMBER_PERMISSION_MATRIX } from '../../../packages/member-access/src/index.js';
import { classifyAdminReadFailure } from './admin';

async function startServer() {
  const app = express();
  app.use((req: any, _res, next) => {
    const tier = req.header('x-test-tier');
    if (tier) {
      req.member = {
        id: `${tier}-user`,
        login_name: tier,
        display_name: tier,
        membership_level: tier,
        role: tier === 'admin' ? 'admin' : 'user',
        status: tier === 'pending' ? 'pending' : 'approved',
        is_active: true,
      };
      req.membershipLevel = tier;
    }
    next();
  });
  for (const capability of MEMBER_CAPABILITIES) {
    app.get(`/capability/${capability}`, requireCapability(capability), (_req, res) => {
      res.json({ ok: true, capability, orderSubmitted: false, exchangeRequestSent: false });
    });
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function memberProfile(overrides = {}) {
  return {
    id: 'member-1',
    login_name: 'member-1',
    display_name: 'Member One',
    role: 'user',
    status: 'approved',
    membership_level: 'associate',
    is_active: true,
    ...overrides,
  };
}

function authRuntime({ authUser = { id: 'member-1' }, authError = null, profile = memberProfile(), profileError = null } = {}) {
  const calls = { getUser: 0, profile: 0 };
  return {
    calls,
    dependencies: {
      isSupabaseConfigured: () => true,
      getSupabase: () => ({
        auth: {
          getUser: async (token) => {
            calls.getUser += 1;
            assert.equal(token, 'valid-token');
            return { data: { user: authUser }, error: authError };
          },
        },
      }),
      getUserSupabase: (token) => {
        assert.equal(token, 'valid-token');
        return {
          from: (table) => {
            assert.equal(table, 'profiles');
            return {
              select: (columns) => {
                assert.equal(columns, '*');
                return {
                  eq: (column, value) => {
                    assert.equal(column, 'id');
                    assert.equal(value, 'member-1');
                    return {
                      single: async () => {
                        calls.profile += 1;
                        return { data: profile, error: profileError };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    },
  };
}

function authRequest() {
  return {
    header: (name) => name.toLowerCase() === 'authorization' ? 'Bearer valid-token' : undefined,
  };
}

function responseRecorder() {
  const state = { statusCode: 200, body: undefined };
  const response = {
    status(code) {
      state.statusCode = code;
      return response;
    },
    json(body) {
      state.body = body;
      return response;
    },
  };
  return { response, state };
}

async function runRequireAuthenticated(runtimeOptions = {}) {
  const req = authRequest();
  const { response, state } = responseRecorder();
  const { dependencies, calls } = authRuntime(runtimeOptions);
  let nextCalls = 0;
  await requireAuthenticated(req, response, () => {
    nextCalls += 1;
  }, dependencies);
  return { req, state, calls, nextCalls };
}

test('requireAuthenticated accepts an approved active member after valid Supabase identity and fresh profile reload', async () => {
  const result = await runRequireAuthenticated();
  assert.equal(result.nextCalls, 1);
  assert.equal(result.calls.getUser, 1);
  assert.equal(result.calls.profile, 1);
  assert.equal(result.req.member.status, 'approved');
  assert.equal(result.req.member.is_active, true);
  assert.equal(result.req.accessToken, 'valid-token');
});

test('requireAuthenticated denies approved inactive member after valid Supabase identity and fresh profile reload', async () => {
  const result = await runRequireAuthenticated({ profile: memberProfile({ is_active: false }) });
  assert.equal(result.nextCalls, 0);
  assert.equal(result.calls.getUser, 1);
  assert.equal(result.calls.profile, 1);
  assert.equal(result.state.statusCode, 403);
  assert.deepEqual(result.state.body, { error: 'MEMBER_SESSION_DISABLED' });
  assert.equal(result.req.member, undefined);
  assert.equal(result.req.accessToken, undefined);
});

for (const status of ['suspended', 'withdrawn']) {
  test(`requireAuthenticated denies ${status} member after valid Supabase identity and fresh profile reload`, async () => {
    const result = await runRequireAuthenticated({ profile: memberProfile({ status }) });
    assert.equal(result.nextCalls, 0);
    assert.equal(result.calls.getUser, 1);
    assert.equal(result.calls.profile, 1);
    assert.equal(result.state.statusCode, 403);
    assert.deepEqual(result.state.body, { error: 'MEMBER_SESSION_DISABLED' });
    assert.equal(result.req.member, undefined);
    assert.equal(result.req.accessToken, undefined);
  });
}

test('requireAuthenticated preserves INVALID_SESSION behavior and does not query profile', async () => {
  const result = await runRequireAuthenticated({
    authUser: null,
    authError: { message: 'invalid token' },
  });
  assert.equal(result.nextCalls, 0);
  assert.equal(result.calls.getUser, 1);
  assert.equal(result.calls.profile, 0);
  assert.equal(result.state.statusCode, 401);
  assert.deepEqual(result.state.body, { error: 'INVALID_SESSION' });
});

test('requireAuthenticated preserves PROFILE_NOT_FOUND behavior after valid Supabase identity', async () => {
  const result = await runRequireAuthenticated({ profile: null });
  assert.equal(result.nextCalls, 0);
  assert.equal(result.calls.getUser, 1);
  assert.equal(result.calls.profile, 1);
  assert.equal(result.state.statusCode, 403);
  assert.deepEqual(result.state.body, { error: 'PROFILE_NOT_FOUND' });
});

test('requireAuthenticated does not broaden pending onboarding into disabled-session denial', async () => {
  const result = await runRequireAuthenticated({
    profile: memberProfile({ status: 'pending', membership_level: 'pending', is_active: false }),
  });
  assert.equal(result.nextCalls, 1);
  assert.equal(result.calls.getUser, 1);
  assert.equal(result.calls.profile, 1);
  assert.equal(result.req.member.status, 'pending');
  assert.equal(result.req.membershipLevel, 'pending');
  assert.equal(result.req.accessToken, 'valid-token');
});

for (const tier of ['pending', 'associate', 'regular', 'admin']) {
  for (const capability of MEMBER_CAPABILITIES) {
    test(`${tier} HTTP access for ${capability} matches shared permission source`, async () => {
      const { server, baseUrl } = await startServer();
      try {
        const response = await fetch(`${baseUrl}/capability/${capability}`, { headers: { 'x-test-tier': tier } });
        const allowed = MEMBER_PERMISSION_MATRIX[tier][capability];
        assert.equal(response.status, allowed ? 200 : 403);
        const body = await response.json();
        if (allowed) {
          assert.equal(body.ok, true);
          assert.equal(body.orderSubmitted, false);
          assert.equal(body.exchangeRequestSent, false);
        } else {
          assert.equal(body.error, 'CAPABILITY_REQUIRED');
          assert.equal(body.capability, capability);
          assert.equal(body.membershipLevel, tier);
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
}

test('capability route blocks unauthenticated request', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/capability/canAccessBasicInfo`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'LOGIN_REQUIRED');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('admin member read storage failure is unavailable, never an empty result or generic 500', () => {
  assert.deepEqual(classifyAdminReadFailure('MEMBER_LIST_FAILED'), {
    statusCode: 503,
    error: 'ADMIN_MEMBER_STORAGE_UNAVAILABLE',
    message: '회원 목록 저장소를 확인할 수 없습니다.',
  });
});

test('admin audit read storage failure is unavailable, never an empty result or generic 500', () => {
  assert.deepEqual(classifyAdminReadFailure('AUDIT_LIST_FAILED'), {
    statusCode: 503,
    error: 'ADMIN_AUDIT_STORAGE_UNAVAILABLE',
    message: '권한 변경 감사 저장소를 확인할 수 없습니다.',
  });
});
