import { expect, test } from '@playwright/test';
import {
  SAFE_DISABLE_PROVIDER_ORDER,
  providerDiagnostic,
  providerDiagnosticHealthy,
  providerDiagnosticRetryable,
  type ReadonlyProbeObservation,
} from './support/production-live-disable-provider-audit';

function healthyObservation(): ReadonlyProbeObservation {
  return {
    responseReceived: true,
    httpStatus: 200,
    transportClassification: 'NONE',
    payload: {
      provider: 'toss',
      readOnly: true,
      connected: true,
      status: 'CONNECTED',
      checkedAt: '2026-10-05T00:00:00.000Z',
      lastGoodAt: '2026-10-05T00:00:00.000Z',
      stale: false,
      errorCode: null,
      openOrders: [],
      orderRequests: 0,
      cancelRequests: 0,
      amendRequests: 0,
      transferRequests: 0,
      withdrawalRequests: 0,
      credentialsReturned: false,
      liveTradingEnabled: false,
      autoTradingEnabled: false,
    },
  };
}

test('safe-disable provider order is credential-safe and rate-limit aware', () => {
  expect(SAFE_DISABLE_PROVIDER_ORDER).toEqual(['toss', 'kiwoom', 'upbit', 'bitget']);
});

test('strict connected, fresh, reconciled snapshot is healthy', () => {
  const diagnostic = providerDiagnostic('toss', healthyObservation());
  expect(diagnostic).toEqual({
    provider: 'toss',
    responseReceived: true,
    httpStatus: 200,
    configured: true,
    verified: true,
    connected: true,
    status: 'CONNECTED',
    stale: false,
    errorCode: null,
    openOrdersIsArray: true,
    openOrdersKnown: true,
    lastVerifiedAtPresent: true,
    diagnosticClassification: 'PASS',
  });
  expect(providerDiagnosticHealthy(diagnostic)).toBe(true);
});

test('stale snapshot remains fail-closed but retryable', () => {
  const observation = healthyObservation();
  observation.payload = { ...observation.payload, stale: true };
  const diagnostic = providerDiagnostic('toss', observation);
  expect(diagnostic.diagnosticClassification).toBe('STALE_SNAPSHOT');
  expect(providerDiagnosticHealthy(diagnostic)).toBe(false);
  expect(providerDiagnosticRetryable(diagnostic)).toBe(true);
});

test('auth, permission, unknown orders, and unsafe error text stay fail-closed and sanitized', () => {
  const permission = providerDiagnostic('bitget', {
    responseReceived: true,
    httpStatus: 403,
    payload: null,
    transportClassification: 'NONE',
  });
  expect(permission.diagnosticClassification).toBe('PERMISSION_OR_IP_ALLOWLIST_REJECTED');
  expect(providerDiagnosticRetryable(permission)).toBe(false);

  const observation = healthyObservation();
  observation.payload = {
    ...observation.payload,
    provider: 'upbit',
    openOrders: null,
    errorCode: 'secret=value',
  };
  const sanitized = providerDiagnostic('upbit', observation);
  expect(sanitized.errorCode).toBe('UNSAFE_ERROR_CODE_REDACTED');
  expect(sanitized.openOrdersKnown).toBe(false);
  expect(providerDiagnosticHealthy(sanitized)).toBe(false);
  expect(JSON.stringify(sanitized)).not.toContain('secret=value');
});
