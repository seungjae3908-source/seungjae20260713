import { expect, test } from '@playwright/test';

import { scannerFailureDiagnostic } from './support/scanner-readiness';

test('scanner failure diagnostic keeps only bounded allowlisted provider evidence', () => {
  const diagnostic = scannerFailureDiagnostic(502, {
    error: 'SCAN_PROVIDER_ERROR',
    outcome: 'PROVIDER_FAILURE',
    dataState: 'unavailable',
    message: 'MUST_NOT_APPEAR_MESSAGE',
    token: 'MUST_NOT_APPEAR_TOKEN',
    providerHealth: [{
      provider: 'yahoo',
      state: 'TIMEOUT',
      latencyMs: 1_649.8,
      retryCount: 1.2,
      timeout: true,
      freshness: 'STALE',
      failureReason: 'YAHOO_CHART_BUDGET_EXCEEDED\nsecondary detail',
      credential: 'MUST_NOT_APPEAR_CREDENTIAL',
    }],
  });

  expect(JSON.parse(diagnostic)).toEqual({
    httpStatus: 502,
    error: 'SCAN_PROVIDER_ERROR',
    outcome: 'PROVIDER_FAILURE',
    dataState: 'unavailable',
    providerHealth: [{
      provider: 'yahoo',
      state: 'TIMEOUT',
      latencyMs: 1_650,
      retryCount: 1,
      timeout: true,
      freshness: 'STALE',
      failureReason: 'YAHOO_CHART_BUDGET_EXCEEDED secondary detail',
    }],
  });
  expect(diagnostic).not.toContain('MUST_NOT_APPEAR_MESSAGE');
  expect(diagnostic).not.toContain('MUST_NOT_APPEAR_TOKEN');
  expect(diagnostic).not.toContain('MUST_NOT_APPEAR_CREDENTIAL');
});

test('scanner failure diagnostic caps provider rows and unsafe text length', () => {
  const diagnostic = scannerFailureDiagnostic(502, {
    providerHealth: Array.from({ length: 12 }, (_, index) => ({
      provider: `provider-${index}`,
      state: 'PROVIDER_FAILURE',
      failureReason: 'x'.repeat(500),
    })),
  });
  const parsed = JSON.parse(diagnostic) as { providerHealth: Array<{ failureReason: string }> };

  expect(parsed.providerHealth).toHaveLength(8);
  expect(parsed.providerHealth[0]?.failureReason).toHaveLength(240);
});
