import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { createMemberInvestmentRouter } from './member-investment.route';
import type { AuthenticatedRequest, MemberProfile } from '../../middleware/auth';

const USER = '11111111-1111-1111-1111-111111111111';
function member(overrides: Partial<MemberProfile> = {}): MemberProfile {
  return { id: USER, login_name: 'member', display_name: 'Member', role: 'user', status: 'approved', membership_level: 'regular', is_active: true, ...overrides };
}

async function serverFor(profile: MemberProfile) {
  const calls: Array<{ operation: string; userId: string }> = [];
  const service: any = {
    async overview(userId: string) { calls.push({ operation: 'overview', userId }); return { safety: { executionAuthority: 'NONE' } }; },
    async listIntents(userId: string) { calls.push({ operation: 'intents', userId }); return { intents: [] }; },
    async savePolicy(userId: string) { calls.push({ operation: 'policy', userId }); return { policy: { userId } }; },
    async createIntentPreview(userId: string) { calls.push({ operation: 'preview', userId }); return { duplicate: false, intent: { userId }, preview: null }; },
    async rejectRealExecution(userId: string) { calls.push({ operation: 'execute', userId }); throw new Error('REAL_ORDER_EXECUTION_DISABLED'); },
  };
  const app = express();
  app.use(express.json());
  app.use((req: AuthenticatedRequest, _res, next) => { req.member = profile; req.accessToken = 'test-token'; next(); });
  app.use('/api/account-connections/platform', createMemberInvestmentRouter(() => service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address() as AddressInfo;
  return { server, calls, url: `http://127.0.0.1:${address.port}/api/account-connections/platform` };
}

test('route derives identity from authenticated member and rejects forged userId', async () => {
  const context = await serverFor(member());
  try {
    const good = await fetch(`${context.url}/overview`);
    assert.equal(good.status, 200);
    assert.deepEqual(context.calls, [{ operation: 'overview', userId: USER }]);
    const forged = await fetch(`${context.url}/intents/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: '22222222-2222-2222-2222-222222222222' }),
    });
    assert.equal(forged.status, 403);
    assert.equal((await forged.json()).error, 'FORGED_USER_ID_REJECTED');
    assert.equal(context.calls.length, 1);
  } finally { await new Promise<void>((resolve) => context.server.close(() => resolve())); }
});

test('inactive, suspended, withdrawn and pending profiles fail closed before repository access', async () => {
  for (const profile of [
    member({ is_active: false }), member({ status: 'suspended' }), member({ status: 'withdrawn' }), member({ status: 'pending' }),
  ]) {
    const context = await serverFor(profile);
    try {
      const response = await fetch(`${context.url}/overview`);
      assert.equal(response.status, 403, `${profile.status}/${profile.is_active}`);
      assert.equal(context.calls.length, 0);
    } finally { await new Promise<void>((resolve) => context.server.close(() => resolve())); }
  }
});

test('every real execution route is locked and never returns order authority', async () => {
  const context = await serverFor(member({ role: 'admin', membership_level: 'admin' }));
  try {
    for (const action of ['place-order', 'cancel-order', 'amend-order', 'transfer', 'withdraw']) {
      const response = await fetch(`${context.url}/execution/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const body = await response.json() as Record<string, unknown>;
      assert.equal(response.status, 423);
      assert.equal(body.error, 'REAL_ORDER_EXECUTION_DISABLED');
      assert.equal(body.executionAuthority, 'NONE');
      assert.equal(body.realOrderAllowed, false);
      assert.equal(body.orderSubmitted, false);
    }
  } finally { await new Promise<void>((resolve) => context.server.close(() => resolve())); }
});
