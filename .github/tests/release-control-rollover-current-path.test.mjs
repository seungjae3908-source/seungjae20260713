import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const currentReleasePath = [
  '.github/workflows/application-ci-main-fallback.yml',
  '.github/workflows/staging-postgres-auth-gate.yml',
  '.github/workflows/production-app-release-control.yml',
  '.github/workflows/production-comprehensive-readonly-dispatch-bridge.yml',
  '.github/workflows/production-account-readonly-live-qa-dispatch-bridge.yml',
  '.github/workflows/production-account-readonly-provider-activation.yml',
];

test('current release path resolves canonical Release Control instead of hardcoding one rollover issue', () => {
  for (const file of currentReleasePath) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes("contains(github.event.issue.labels.*.name, 'release-control')"), file);
    assert.ok(source.includes("startsWith(github.event.issue.title, 'Staging Readiness Control')"), file);
    assert.ok(source.includes('current-release-control.cjs'), file);
    assert.equal(/github\.event\.issue\.number == \d+\b/.test(source), false, file);
    assert.equal(/issue_number:\s*\d+\b/.test(source), false, file);
    assert.equal(source.includes("github.event.issue.title == 'Staging Readiness Control — Rollover 2026-10-02'"), false, file);
  }
});

test('canonical resolver is marker-based and predecessor-safe', () => {
  const resolver = fs.readFileSync('.github/scripts/current-release-control.cjs', 'utf8');
  assert.ok(resolver.includes("RELEASE_CONTROL_LABEL = 'release-control'"));
  assert.ok(resolver.includes("RELEASE_CONTROL_TITLE_PREFIX = 'Staging Readiness Control'"));
  assert.ok(resolver.includes("RELEASE_CONTROL_CANONICAL_MARKER = '<!-- release-control-canonical:v2 -->'"));
  assert.ok(resolver.includes('issue?.user?.login === owner'));
  assert.ok(resolver.includes('Number(right?.number ?? 0) - Number(left?.number ?? 0)'));
  assert.ok(resolver.includes('RELEASE_CONTROL_NOT_CANONICAL'));
});

test('rollover resolver migration does not introduce live trading authority', () => {
  const combined = currentReleasePath.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.equal(combined.includes("LIVE_TRADING: 'true'"), false);
  assert.equal(combined.includes("AUTO_TRADING: 'true'"), false);
  assert.equal(combined.includes("REAL_ORDER_ENABLED: 'true'"), false);
  assert.equal(combined.includes("PRIVATE_TRADING_API_ALLOWED: 'true'"), false);
});
