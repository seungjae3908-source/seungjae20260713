import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync('stock-analyzer/e2e/production-comprehensive-readonly-qa.spec.ts', 'utf8');

test('Production comprehensive QA preserves fail-closed login attribution evidence', () => {
  assert.match(source, /function sanitizeLoginDiagnostics\(items: Diagnostic\[\]\)/);
  assert.match(source, /path: item\.path\.split\('\?'\)\[0\]\.slice\(0, 300\)/);
  assert.match(source, /detail: item\.detail\.slice\(0, 300\)/);
  assert.match(source, /diagnostics\.slice\(diagnosticStart\)/);
  assert.match(source, /blocked\.slice\(blockedStart\)/);
  assert.match(source, /-login-failure\.json/);
  assert.match(source, /authenticated: false/);
  assert.match(source, /loginSurfaceVisible, membershipVisible, fallbackVisible/);
  assert.match(source, /\[PRODUCTION_QA_AUTH_NOT_ESTABLISHED\]/);

  for (const evidenceName of ['routes', 'search', 'charts']) {
    assert.match(
      source,
      new RegExp(`await login\\(page, testInfo, diagnostics, blocked, '${evidenceName}'\\);`),
      `missing login evidence binding for ${evidenceName}`,
    );
  }

  assert.equal(
    (source.match(/await loginButton\.click\(/g) ?? []).length,
    1,
    'login attribution repair must not add retry-to-pass clicks',
  );
  assert.match(
    source,
    /membership-label'\)\.toBeVisible\(\{ timeout: 15_000 \}\)/,
    'login gate must remain fail-closed at the existing bound',
  );
});
