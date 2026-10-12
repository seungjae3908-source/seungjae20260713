import test from 'node:test';
import './automatic-live-owner-policy.service.test';
import assert from 'node:assert/strict';
import { auditAutomaticLivePreactivation } from './automatic-live-preactivation-audit.service';
import { InMemoryTradingRepository } from './trade-automation.repository';
import type { MemberAutoTradingBackgroundSource } from './member-auto-trading-background-worker.service';

test('one read-only audit collects all policy, missing-source and four-provider failures without financial calls', async () => {
  const repository = new InMemoryTradingRepository();
  let writes = 0;
  let providerReads = 0;
  repository.savePlan = async () => { writes += 1; throw new Error('FORBIDDEN'); };
  repository.saveOrder = async () => { writes += 1; throw new Error('FORBIDDEN'); };
  repository.savePolicy = async () => { writes += 1; throw new Error('FORBIDDEN'); };
  const source: Pick<MemberAutoTradingBackgroundSource, 'readHandoff' | 'readLiveAccountSnapshot'> = {
    async readHandoff() { throw new Error('HANDOFF_ENTRY_STALE:private-path:secret'); },
    async readLiveAccountSnapshot() { providerReads += 1; throw new Error('AUTH_REVOKED:private-account'); },
  };
  const audit = await auditAutomaticLivePreactivation({ userId: 'audit-owner', repository, source,
    profile: { membership_level: 'admin', role: 'admin', status: 'approved', is_active: true },
    targetSha: 'a'.repeat(40), nowMs: Date.parse('2026-10-12T01:00:00Z') });
  assert.equal(audit.ready, false);
  assert.equal(providerReads, 4, 'one provider rejection cannot hide failures in another provider');
  assert.equal(writes, 0);
  assert.equal(audit.checks.length, 16);
  assert.deepEqual(audit.checks.find((row) => row.id === 'SIGNAL_FRESHNESS_AND_SHA')!.codes, ['HANDOFF_ENTRY_STALE']);
  assert.equal(audit.checks.filter((row) => row.id.startsWith('ACCOUNT_')).every((row) => row.codes[0] === 'AUTH_REVOKED'), true);
  assert.equal(audit.checks.find((row) => row.id === 'GENUINE_SCANNER_AND_AI_CONNECTION')!.status, 'BLOCKED');
  assert.equal(JSON.stringify(audit).includes('private-path'), false);
  assert.equal(JSON.stringify(audit).includes('private-account'), false);
  assert.equal(audit.orderRequests + audit.cancelRequests + audit.amendRequests + audit.transferRequests + audit.withdrawalRequests, 0);
  assert.equal(audit.autoTradingAuthorityGrantedByAudit, false);
  assert.equal(audit.activationReady, false);
  assert.ok(audit.additionalRequiredControls.includes('ATOMIC_AGGREGATE_BUDGET'));
});
