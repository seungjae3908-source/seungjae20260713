import { expect, test } from '@playwright/test';
import { formatSafeErrorDiagnostics, safeErrorPath } from '../src/lib/safe-error-diagnostics';

test('safe error diagnostics copy only allowlisted metadata and strips route secrets', () => {
  const diagnostics = formatSafeErrorDiagnostics({
    pathname: '/account?token=secret-value#credential',
    appSha: 'E0DAD8E5C63837BFC5E36A38BA001B8EDA6BFE19',
    provider: 'Upbit<script>alert(1)</script>',
    errorCode: 'UPSTREAM_ERROR',
    occurredAt: '2026-08-21T09:15:00+09:00',
  });

  expect(diagnostics).toContain('path: /account');
  expect(diagnostics).toContain('app_sha: e0dad8e5c63837bfc5e36a38ba001b8eda6bfe19');
  expect(diagnostics).toContain('error_code: UPSTREAM_ERROR');
  expect(diagnostics).toContain('occurred_at: 2026-08-21T00:15:00.000Z');
  expect(diagnostics).not.toContain('secret-value');
  expect(diagnostics).not.toContain('#credential');
  expect(diagnostics).not.toContain('<script>');
  expect(diagnostics).not.toContain('Authorization');
  expect(diagnostics).not.toContain('message:');
});

test('safe error diagnostics fail closed on invalid route, sha, and timestamp', () => {
  expect(safeErrorPath('https://example.test/account?token=secret')).toBe('/');

  const diagnostics = formatSafeErrorDiagnostics({
    pathname: '/',
    appSha: 'not-a-deploy-sha',
    provider: '',
    errorCode: '',
    occurredAt: 'not-a-time',
  });

  expect(diagnostics).toContain('app_sha: NOT_AVAILABLE');
  expect(diagnostics).toContain('provider: NOT_AVAILABLE');
  expect(diagnostics).toContain('error_code: UNKNOWN');
  expect(diagnostics).toContain('occurred_at: NOT_AVAILABLE');
});
