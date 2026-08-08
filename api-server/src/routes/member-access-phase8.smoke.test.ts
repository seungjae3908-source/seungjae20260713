// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { requireCapability } from '../middleware/auth';
import { MEMBER_CAPABILITIES, MEMBER_PERMISSION_MATRIX } from '../../../packages/member-access/src/index.js';

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
