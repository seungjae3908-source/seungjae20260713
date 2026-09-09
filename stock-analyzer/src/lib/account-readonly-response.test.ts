import { describe, expect, it } from 'vitest';
import {
  INVALID_ACCOUNT_READONLY_RESPONSE,
  isAccountReadonlySnapshotPath,
  requireAccountReadonlySnapshotResponse,
} from './account-readonly-response';

const now = Date.parse('2026-09-10T00:00:00.000Z');

const canonicalConnected = {
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

const canonicalNotConfigured = {
  ...canonicalConnected,
  connected: false,
  status: 'NOT_CONFIGURED',
  accounts: null,
  balances: null,
  positions: null,
  openOrders: null,
  lastGoodAt: null,
  errorCode: 'ACCOUNT_NOT_CONFIGURED',
};

describe('account read-only snapshot response truth', () => {
  it('recognizes only canonical provider snapshot GET routes', () => {
    expect(isAccountReadonlySnapshotPath('/api/accounts/read-only/toss', 'GET')).toBe(true);
    expect(isAccountReadonlySnapshotPath('/api/accounts/read-only/upbit', 'GET')).toBe(true);
    expect(isAccountReadonlySnapshotPath('/api/accounts/read-only/bitget', 'GET')).toBe(true);
    expect(isAccountReadonlySnapshotPath('/api/accounts/read-only/credentials/toss', 'GET')).toBe(false);
    expect(isAccountReadonlySnapshotPath('/api/accounts/read-only/toss', 'PUT')).toBe(false);
  });

  it('rejects malformed HTTP 200 before connected or empty UI can render', () => {
    expect(() => requireAccountReadonlySnapshotResponse('/api/accounts/read-only/toss', 'GET', {}, now))
      .toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);
    expect(() => requireAccountReadonlySnapshotResponse('/api/accounts/read-only/toss', 'GET', { connected: true }, now))
      .toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);
    expect(() => requireAccountReadonlySnapshotResponse('/api/accounts/read-only/toss', 'GET', { ...canonicalConnected, provider: 'upbit' }, now))
      .toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);
  });

  it('requires coherent connection and stale state', () => {
    expect(() => requireAccountReadonlySnapshotResponse('/api/accounts/read-only/toss', 'GET', { ...canonicalConnected, status: 'CONNECTED', connected: false }, now))
      .toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);
    expect(() => requireAccountReadonlySnapshotResponse('/api/accounts/read-only/toss', 'GET', { ...canonicalConnected, status: 'STALE', stale: false }, now))
      .toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);
    expect(requireAccountReadonlySnapshotResponse('/api/accounts/read-only/toss', 'GET', canonicalNotConfigured, now))
      .toBe(canonicalNotConfigured);
  });

  it('locks zero financial authority invariants', () => {
    expect(() => requireAccountReadonlySnapshotResponse('/api/accounts/read-only/toss', 'GET', { ...canonicalConnected, orderRequests: 1 }, now))
      .toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);
    expect(() => requireAccountReadonlySnapshotResponse('/api/accounts/read-only/toss', 'GET', { ...canonicalConnected, withdrawalRequests: 1 }, now))
      .toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);
    expect(() => requireAccountReadonlySnapshotResponse('/api/accounts/read-only/toss', 'GET', { ...canonicalConnected, credentialsReturned: true }, now))
      .toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);
    expect(() => requireAccountReadonlySnapshotResponse('/api/accounts/read-only/toss', 'GET', { ...canonicalConnected, liveTradingEnabled: true }, now))
      .toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);
  });

  it('rejects future timestamps and malformed displayed investment facts', () => {
    expect(() => requireAccountReadonlySnapshotResponse('/api/accounts/read-only/toss', 'GET', { ...canonicalConnected, checkedAt: '2026-09-10T00:02:00.000Z' }, now))
      .toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);
    expect(() => requireAccountReadonlySnapshotResponse('/api/accounts/read-only/toss', 'GET', {
      ...canonicalConnected,
      positions: [{ market: 'KR', symbol: '005930', quantity: '10' }],
    }, now)).toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);
    expect(requireAccountReadonlySnapshotResponse('/api/accounts/read-only/toss', 'GET', canonicalConnected, now))
      .toBe(canonicalConnected);
  });
});
