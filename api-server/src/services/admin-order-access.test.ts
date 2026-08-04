import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  hasCapability,
  permissionsFor,
} from '../../../packages/member-access/src/index.js';

const repositoryRoot = path.basename(process.cwd()) === 'api-server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());

async function source(relativePath: string) {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8');
}

test('only active administrators receive the order capability', () => {
  const regular = permissionsFor('regular');
  assert.equal(regular.canAccessBasicInfo, true);
  assert.equal(regular.canAccessSpot, true);
  assert.equal(regular.canAccessFutures, true);
  assert.equal(regular.canAccessPaperTrading, true);
  assert.equal(regular.canPlaceOrders, false);

  const admin = permissionsFor('admin');
  assert.equal(admin.canPlaceOrders, true);
  assert.equal(admin.canManageMembers, true);

  assert.equal(hasCapability({ role: 'admin', status: 'approved', is_active: true }, 'canPlaceOrders'), true);
  assert.equal(hasCapability({ role: 'regular', status: 'approved', is_active: true }, 'canPlaceOrders'), false);
  assert.equal(hasCapability({ role: 'admin', status: 'suspended', is_active: false }, 'canPlaceOrders'), false);
});

test('all stock and crypto order-capable server paths require administrator order access', async () => {
  const routes = await source('api-server/src/routes/index.ts');

  for (const contract of [
    "router.use('/stocks/auto-trade', requireCapability('canPlaceOrders'));",
    "router.use('/crypto/futures/auto', requireCapability('canPlaceOrders'));",
    "router.use('/crypto/spot/accounts', requireCapability('canPlaceOrders'));",
    "router.use('/crypto/futures/account', requireCapability('canPlaceOrders'));",
    "router.use('/crypto/futures/positions', requireCapability('canPlaceOrders'));",
    "router.use('/paper-trading', requireCapability('canPlaceOrders'));",
    "router.use('/trade-automation', requireCapability('canPlaceOrders'));",
  ]) {
    assert.ok(routes.includes(contract), `missing administrator order route guard: ${contract}`);
  }

  const automation = await source('api-server/src/routes/trade-automation.ts');
  assert.match(automation, /\['bitget', 'upbit', 'kiwoom'\]/);
  assert.match(automation, /router\.post\('\/plans'/);
  assert.match(automation, /router\.post\('\/plans\/:id\/approve'/);
  assert.match(automation, /router\.post\('\/orders\/:id\/cancel'/);
});

test('real user order screens and navigation are administrator-only', async () => {
  const [autoTrading, paperTrading, bottomNav, capabilityGate] = await Promise.all([
    source('stock-analyzer/src/pages/auto-trading.tsx'),
    source('stock-analyzer/src/pages/paper-trading.tsx'),
    source('stock-analyzer/src/components/bottom-nav.tsx'),
    source('stock-analyzer/src/components/capability-gate.tsx'),
  ]);

  assert.match(autoTrading, /CapabilityGate capability="canPlaceOrders"/);
  assert.match(paperTrading, /CapabilityGate capability="canPlaceOrders"/);
  assert.match(bottomNav, /href: '\/auto-trading'.*capability: 'canPlaceOrders'/s);
  assert.match(capabilityGate, /canPlaceOrders: '관리자 주문'/);
});
