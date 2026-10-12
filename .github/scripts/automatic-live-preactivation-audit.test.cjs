'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { REQUIRED_CHECKS, ADDITIONAL_CONTROLS, assertMemberAccountSignalAudit } = require('./automatic-live-preactivation-audit.cjs');
const SHA = 'a'.repeat(40);
// Synthetic unit fixture only: not runtime evidence and not an activation receipt.
function fixture() {
  return {
    schemaVersion: 'automatic-live-preactivation-audit-v1', targetSha: SHA,
    generatedAt: '2026-10-12T00:00:00.000Z', scope: 'MEMBER_ACCOUNT_AND_SIGNAL_READONLY_REHEARSAL',
    ready: true, activationReady: false,
    checks: REQUIRED_CHECKS.map((id) => ({ id, status: 'PASS', codes: [] })),
    additionalRequiredControls: [...ADDITIONAL_CONTROLS], paperOutOfScope: true, telegramOutOfScope: true,
    orderRequests: 0, cancelRequests: 0, amendRequests: 0, transferRequests: 0, withdrawalRequests: 0,
    liveTradingAuthorityGrantedByAudit: false, autoTradingAuthorityGrantedByAudit: false,
  };
}
const context = { targetSha: SHA, generatedAt: '2026-10-12T00:01:00.000Z' };
test('accepts a fresh exact-SHA subset without granting overall authority', () => {
  assert.doesNotThrow(() => assertMemberAccountSignalAudit(fixture(), context));
});
test('rejects missing, blocked, duplicate, stale, forged-ready and authority-bearing audits', () => {
  for (const mutate of [
    (a) => { a.checks.pop(); },
    (a) => { a.checks[0] = a.checks[1]; },
    (a) => { const c = a.checks.find((x) => x.id === 'GENUINE_SCANNER_AND_AI_CONNECTION'); c.status = 'BLOCKED'; c.codes = ['PREACTIVATION_SCANNER_AI_PRODUCER_BINDING_NOT_PROVEN']; },
    (a) => { a.generatedAt = '2026-10-11T00:00:00.000Z'; },
    (a) => { a.generatedAt = '2026-10-12T00:02:00.000Z'; },
    (a) => { a.targetSha = 'b'.repeat(40); },
    (a) => { a.activationReady = true; },
    (a) => { a.orderRequests = 1; },
    (a) => { a.liveTradingAuthorityGrantedByAudit = true; },
    (a) => { a.additionalRequiredControls = []; },
  ]) {
    const audit = fixture(); mutate(audit);
    assert.throws(() => assertMemberAccountSignalAudit(audit, context), /MEMBER_SIGNAL_AUDIT_INVALID/u);
  }
});
