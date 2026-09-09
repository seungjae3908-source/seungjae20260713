import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  INVALID_ACCOUNT_READONLY_RESPONSE,
  isAccountReadonlySnapshotPath,
  requireAccountReadonlySnapshotResponse,
} from '../src/lib/account-readonly-response';

const authFetchPath = fileURLToPath(new URL('../src/lib/auth-fetch.ts', import.meta.url));
const componentPath = fileURLToPath(new URL('../src/components/brokerage-account-connections.tsx', import.meta.url));
const backendContractPath = fileURLToPath(new URL('../../api-server/src/features/account-readonly/account-readonly.contract.ts', import.meta.url));

const now = Date.parse('2026-09-10T00:00:00.000Z');
const canonical = {
  provider: 'toss',
  readOnly: true,
  connected: true,
  status: 'CONNECTED',
  accounts: [],
  balances: [],
  positions: [],
  openOrders: [],
  checkedAt: '2026-09-10T00:00:00.000Z',
  lastGoodAt: '2026-09-10T00:00:00.000Z',
  stale: false,
  errorCode: null,
  orderRequests: 0,
  cancelRequests: 0,
  amendRequests: 0,
  transferRequests: 0,
  withdrawalRequests: 0,
  credentialsReturned: false,
  liveTradingEnabled: false,
  autoTradingEnabled: false,
};

test('malformed account HTTP 200 cannot become connected UI truth', () => {
  expect(() => requireAccountReadonlySnapshotResponse(
    '/api/accounts/read-only/toss',
    'GET',
    { connected: true },
    now,
  )).toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);

  expect(requireAccountReadonlySnapshotResponse(
    '/api/accounts/read-only/toss',
    'GET',
    canonical,
    now,
  )).toBe(canonical);
});

test('central authenticated transport guards every read-only provider snapshot', async () => {
  const [authFetch, component, backendContract] = await Promise.all([
    readFile(authFetchPath, 'utf8'),
    readFile(componentPath, 'utf8'),
    readFile(backendContractPath, 'utf8'),
  ]);

  expect(isAccountReadonlySnapshotPath('/api/accounts/read-only/toss', 'GET')).toBe(true);
  expect(isAccountReadonlySnapshotPath('/api/accounts/read-only/upbit', 'GET')).toBe(true);
  expect(isAccountReadonlySnapshotPath('/api/accounts/read-only/bitget', 'GET')).toBe(true);
  expect(isAccountReadonlySnapshotPath('/api/accounts/read-only/credentials/toss', 'PUT')).toBe(false);

  expect(authFetch).toContain('isAccountReadonlySnapshotPath(path, method)');
  expect(authFetch).toContain('requireAccountReadonlySnapshotResponse(path, method, await response.clone().json())');
  expect(authFetch).toContain('throw new Error(INVALID_ACCOUNT_READONLY_RESPONSE)');

  expect(component).toContain("if (snapshot.connected) return snapshot.stale ? '이전 정상값' : '연결됨';");
  expect(component).toContain('jsonRequest<CanonicalAccountSnapshot>(`/api/accounts/read-only/${provider}`');

  expect(backendContract).toContain('provider: AccountProvider; readOnly: true; connected: boolean; status: AccountReadStatus;');
  expect(backendContract).toContain('orderRequests: 0; cancelRequests: 0; amendRequests: 0; transferRequests: 0; withdrawalRequests: 0;');
  expect(backendContract).toContain('credentialsReturned: false; liveTradingEnabled: false; autoTradingEnabled: false;');
});
