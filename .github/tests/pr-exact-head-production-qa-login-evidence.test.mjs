import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync('stock-analyzer/e2e/production-comprehensive-readonly-qa.spec.ts', 'utf8');
const sharedLogin = fs.readFileSync('stock-analyzer/e2e/support/production-readonly-login.ts', 'utf8');
const deployWorkflow = fs.readFileSync('.github/workflows/production-deploy.yml', 'utf8');
const accountWorkflow = fs.readFileSync('.github/workflows/production-account-readonly-live-qa.yml', 'utf8');
const credentialWorkflow = fs.readFileSync('.github/workflows/production-live-credential-reuse-qa.yml', 'utf8');
const tradingCoreWorkflow = fs.readFileSync('.github/workflows/production-trading-core-qa.yml', 'utf8');
const accountQa = fs.readFileSync('stock-analyzer/e2e/production-account-readonly-live-qa.spec.ts', 'utf8');
const tradingCoreQa = fs.readFileSync('stock-analyzer/e2e/production-trading-core-qa.spec.ts', 'utf8');

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
    /membership-label'\)\)\.toBeVisible\(\{ timeout: 15_000 \}\)/,
    'login gate must remain fail-closed at the existing bound',
  );
});

test('shared Production login retries an incomplete cold surface without weakening the 15 second gate', () => {
  assert.match(sharedLogin, /const LOGIN_READY_BUDGET_MS = 15_000;/);
  assert.match(sharedLogin, /const LOGIN_INTERACTIVE_COLD_RETRIES = 1;/);
  assert.match(sharedLogin, /state\.path === '\/login'/);
  assert.match(sharedLogin, /!state\.membershipVisible/);
  assert.match(sharedLogin, /!state\.alertVisible/);
  assert.match(sharedLogin, /diagnosticCount === 0/);
  assert.doesNotMatch(sharedLogin, /&& state\.fallbackVisible/);
  assert.match(sharedLogin, /attempt >= LOGIN_INTERACTIVE_COLD_RETRIES/);
  assert.equal(
    (sharedLogin.match(/await loginButton\.click\(/g) ?? []).length,
    1,
    'cold recovery must never resubmit credentials',
  );
});

test('all shared-login Production QA workflows retain sanitized login diagnostics on failure', () => {
  assert.match(sharedLogin, /PRODUCTION_LOGIN_DIAGNOSTIC_DIR/);
  assert.match(sharedLogin, /production-login-readiness-failure-v1/);
  assert.match(sharedLogin, /secretValuesRecorded: false/);
  assert.match(sharedLogin, /redactDiagnosticDetail/);

  for (const [workflow, scope] of [
    [deployWorkflow, 'account'],
    [deployWorkflow, 'credential'],
    [deployWorkflow, 'trading-core'],
    [accountWorkflow, 'account'],
    [credentialWorkflow, 'credential'],
    [tradingCoreWorkflow, 'trading-core'],
  ]) {
    assert.match(workflow, new RegExp(`PRODUCTION_LOGIN_DIAGNOSTIC_DIR: production-login-diagnostics/${scope}`));
    assert.match(workflow, new RegExp(`stock-analyzer/production-login-diagnostics/${scope}`));
  }

  assert.match(deployWorkflow, /if: \$\{\{ always\(\) && steps\.account_qa\.outcome != 'skipped' \}\}/);
  assert.match(deployWorkflow, /if: \$\{\{ always\(\) && steps\.credential_qa\.outcome != 'skipped' \}\}/);
  assert.match(deployWorkflow, /if: \$\{\{ always\(\) && steps\.trading_core_qa\.outcome != 'skipped' \}\}/);
});

test('authenticated Production QA probes send the in-memory Bearer token to protected app APIs', () => {
  for (const qa of [accountQa, tradingCoreQa]) {
    assert.match(qa, /productionReadOnlyAccessToken/);
    assert.match(qa, /Authorization: `Bearer \$\{token\}`/);
    assert.doesNotMatch(qa, /console\.(?:log|error)\([^\n]*accessToken/);
    assert.doesNotMatch(qa, /writeEvidence\([^)]*accessToken/);
  }

  assert.match(accountQa, /Authenticated Production access token must remain in memory only/);
  assert.match(tradingCoreQa, /PRODUCTION_TRADING_CORE_AUTH_TOKEN_MISSING/);
});
