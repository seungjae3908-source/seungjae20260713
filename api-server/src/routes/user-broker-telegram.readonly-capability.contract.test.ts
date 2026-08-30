import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { MEMBER_PERMISSION_MATRIX } from '../../../packages/member-access/src/index.js';

const routeSource = readFileSync(
  path.join(process.cwd(), 'api-server/src/routes/user-broker-telegram.ts'),
  'utf8',
);

test('approved read-only members can inspect sanitized integration metadata without order authority', () => {
  for (const tier of ['associate', 'regular'] as const) {
    assert.equal(MEMBER_PERMISSION_MATRIX[tier].canAccessBasicInfo, true);
    assert.equal(MEMBER_PERMISSION_MATRIX[tier].canPlaceOrders, false);
  }

  assert.match(
    routeSource,
    /const canReadBrokerConnections = hasCapability\(authenticated\.member, 'canAccessBasicInfo'\);/,
  );
  assert.doesNotMatch(
    routeSource,
    /const canReadBrokerConnections = hasCapability\(authenticated\.member, 'canPlaceOrders'\);/,
  );
});

test('user integrations metadata path remains sanitized and carries zero trading authority', () => {
  assert.match(routeSource, /brokerConnections: safeConnections\(connections\)/);
  assert.match(routeSource, /privateApiRequests:\s*0/);
  assert.match(routeSource, /ordersSubmitted:\s*0/);
  assert.match(routeSource, /ordersCancelled:\s*0/);
  assert.doesNotMatch(routeSource, /prepare(?:Kiwoom|Upbit|Bitget).*(?:Order|Cancel|Amend|Transfer|Withdraw)/);
});
