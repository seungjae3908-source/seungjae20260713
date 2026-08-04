import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import router, { setTradeAutomationRepositoryFactoryForTests } from './trade-automation';
import { requireAdmin } from '../middleware/auth';
import { InMemoryTradingRepository } from '../services/trade-automation.repository';

const USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function start(role: 'regular' | 'admin') {
  const repository = new InMemoryTradingRepository();
  setTradeAutomationRepositoryFactoryForTests(() => repository);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.member = {
      id: USER,
      login_name: 'admin-contract',
      display_name: 'Admin Contract',
      role,
      membership_level: role,
      status: 'approved',
      is_active: true,
    };
    req.membershipLevel = role;
    req.accessToken = 'test-token';
    next();
  });
  app.use('/api/trade-automation', requireAdmin, router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

async function close(server: import('node:http').Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setTradeAutomationRepositoryFactoryForTests(null);
}

test('regular member receives ADMIN_REQUIRED for every auto-trading surface despite body role forgery', async () => {
  const { server, baseUrl } = await start('regular');
  try {
    for (const request of [
      { path: '/status', init: undefined },
      {
        path: '/policy',
        init: {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'admin', membership_level: 'admin' }),
        },
      },
      {
        path: '/recovery/scan',
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'admin' }),
        },
      },
    ]) {
      const response = await fetch(`${baseUrl}/api/trade-automation${request.path}`, request.init);
      assert.equal(response.status, 403, request.path);
      assert.equal((await response.json()).error, 'ADMIN_REQUIRED', request.path);
    }
  } finally {
    await close(server);
  }
});

test('administrator can reach status through the same production guard chain', async () => {
  const { server, baseUrl } = await start('admin');
  try {
    const response = await fetch(`${baseUrl}/api/trade-automation/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.actualOrderSubmittedByStatusRequest, false);
  } finally {
    await close(server);
  }
});
