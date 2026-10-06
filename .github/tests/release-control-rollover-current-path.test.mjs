import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const successorIssue = '1555';
const successorTitle = 'Staging Readiness Control — Rollover 2026-10-02';

const currentReleasePath = [
  '.github/workflows/application-ci-main-fallback.yml',
  '.github/workflows/staging-postgres-auth-gate.yml',
  '.github/workflows/production-app-release-control.yml',
  '.github/workflows/production-comprehensive-readonly-dispatch-bridge.yml',
  '.github/workflows/production-account-readonly-live-qa-dispatch-bridge.yml',
  '.github/workflows/production-account-readonly-provider-activation.yml',
];

const rolloverResilientResearchControls = [
  '.github/workflows/public-forward-liquidity-schedule-delivery-control.yml',
  '.github/workflows/public-forward-partial-fill-release-binding-publication.yml',
];

test('current release path is routed away from append-blocked Release Control #23', () => {
  for (const file of currentReleasePath) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes('github.event.issue.number == ' + successorIssue), file);
    assert.ok(source.includes(successorTitle), file);
    assert.equal(/github\.event\.issue\.number == 23\b/.test(source), false, file);
    assert.equal(/issue_number:\s*23\b/.test(source), false, file);
    assert.equal(source.includes("github.event.issue.title == 'Staging Readiness Control'"), false, file);
  }
});

test('rollover does not introduce live trading authority', () => {
  const combined = currentReleasePath.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.equal(combined.includes("LIVE_TRADING: 'true'"), false);
  assert.equal(combined.includes("AUTO_TRADING: 'true'"), false);
  assert.equal(combined.includes("REAL_ORDER_ENABLED: 'true'"), false);
  assert.equal(combined.includes("PRIVATE_TRADING_API_ALLOWED: 'true'"), false);
});

test('research controls accept the active rollover title instead of saturated issue numbers', () => {
  for (const file of rolloverResilientResearchControls) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes("startsWith(github.event.issue.title, 'Staging Readiness Control — Rollover '"), file);
    assert.equal(/github\.event\.issue\.number == 23\b/.test(source), false, file);
    assert.equal(/issue_number:\s*23\b/.test(source), false, file);
  }
});
