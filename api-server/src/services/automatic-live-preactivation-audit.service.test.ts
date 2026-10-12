import test from 'node:test';
import './automatic-live-owner-policy.service.test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { automaticLiveLifecycleCoverage, auditAutomaticLivePreactivation } from './automatic-live-preactivation-audit.service';
import { InMemoryTradingRepository } from './trade-automation.repository';
import type { MemberAutoTradingBackgroundSource } from './member-auto-trading-background-worker.service';
import type { TradingPlan, TradingOrder } from './trade-automation.types';

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
  assert.equal(audit.checks.length, 18);
  assert.deepEqual(audit.checks.find((row) => row.id === 'NATIVE_FUTURES_PROTECTION_READBACK')!.codes,
    ['BITGET_NATIVE_PROTECTION_RUNTIME_PROOF_REQUIRED']);
  assert.deepEqual(audit.checks.find((row) => row.id === 'ATOMIC_BUDGET_GUARD_INSTALLED')!.codes,
    ['AUTOMATIC_LIVE_ATOMIC_BUDGET_GUARD_NOT_READY']);
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


test('formula-AI live pilot cannot pass the AI review gate from missing, blocked or empty handoffs', async () => {
  const at = Date.parse('2026-10-13T00:00:00Z');
  for (const handoff of [
    null,
    { status: 'READY', evaluatedAtMs: at, entries: [] },
    { status: 'BLOCKED_DATA', evaluatedAtMs: at, entries: [], blockers: ['PUBLIC_SOURCE_MISSING'] },
  ]) {
    const repository = new InMemoryTradingRepository();
    const baseGet = repository.getPolicy.bind(repository);
    repository.getPolicy = async (userId) => ({ ...(await baseGet(userId)), pilotStage: 'formula-ai-exception' });
    let writes = 0;
    repository.saveOrder = async () => { writes++; throw new Error('FORBIDDEN'); };
    repository.savePlan = async () => { writes++; throw new Error('FORBIDDEN'); };
    const source: Pick<MemberAutoTradingBackgroundSource, 'readHandoff' | 'readLiveAccountSnapshot'> = {
      async readHandoff() {
        return handoff as Awaited<ReturnType<MemberAutoTradingBackgroundSource['readHandoff']>>;
      },
      async readLiveAccountSnapshot() { throw new Error('ACCOUNT_NOT_CONFIGURED'); },
    };
    const audit = await auditAutomaticLivePreactivation({
      userId: 'audit-owner', repository, source, targetSha: 'a'.repeat(40), nowMs: at,
      profile: { membership_level: 'admin', role: 'admin', status: 'approved', is_active: true },
    });
    assert.deepEqual(audit.checks.find((check) => check.id === 'CURRENT_AI_EVIDENCE')?.codes,
      ['PREACTIVATION_SIGNAL_AI_REVIEW_MISSING']);
    assert.ok(audit.lifecycleCoverage.blockedControlIds.includes('AI_PRODUCER_CONNECTED'));
    assert.equal(audit.ready, false);
    assert.equal(audit.activationReady, false);
    assert.equal(audit.orderRequests + audit.cancelRequests + audit.amendRequests, 0);
    assert.equal(writes, 0);
  }
});

test('formula-AI live pilot rejects expired or absent per-candidate reviews without extending the two-minute TTL', async () => {
  const at = Date.parse('2026-10-13T00:00:00Z');
  const repository = new InMemoryTradingRepository();
  const baseGet = repository.getPolicy.bind(repository);
  repository.getPolicy = async (userId) => ({ ...(await baseGet(userId)), pilotStage: 'formula-ai-exception' });
  const source: Pick<MemberAutoTradingBackgroundSource, 'readHandoff' | 'readLiveAccountSnapshot'> = {
    async readHandoff() {
      return { status: 'READY', evaluatedAtMs: at, entries: [
        { identity: { signalId: 'candidate-no-current-issuer', market: 'CRYPTO_SPOT',
          researchCodeSha: 'a'.repeat(40) }, evaluatedAtMs: at, aiReviewEvidence: {
          reviewedAtMs: at - 120_000, expiresAtMs: at,
        } },
      ] } as unknown as Awaited<ReturnType<MemberAutoTradingBackgroundSource['readHandoff']>>;
    },
    async readLiveAccountSnapshot() { throw new Error('ACCOUNT_NOT_CONFIGURED'); },
  };
  const audit = await auditAutomaticLivePreactivation({
    userId: 'audit-owner', repository, source, targetSha: 'a'.repeat(40), nowMs: at,
    profile: { membership_level: 'admin', role: 'admin', status: 'approved', is_active: true },
  });
  assert.deepEqual(audit.checks.find((check) => check.id === 'CURRENT_AI_EVIDENCE')?.codes,
    ['PREACTIVATION_SIGNAL_AI_REVIEW_INVALID']);
  assert.equal(audit.activationReady, false);
  assert.equal(audit.orderRequests, 0);
});


test('empty READY handoff is transport-only and never proves first signal identity SHA', async () => {
  const at = Date.parse('2026-10-13T00:00:00Z');
  const repository = new InMemoryTradingRepository();
  const source: Pick<MemberAutoTradingBackgroundSource, 'readHandoff' | 'readLiveAccountSnapshot'> = {
    async readHandoff() {
      return ({ status: 'READY', evaluatedAtMs: at, entryCount: 0, entries: [], blockers: [] }
        as unknown as Awaited<ReturnType<MemberAutoTradingBackgroundSource['readHandoff']>>);
    },
    async readLiveAccountSnapshot() { throw new Error('CREDENTIALS_UNAVAILABLE'); },
  };
  const audit = await auditAutomaticLivePreactivation({
    userId: 'audit-owner', repository, source, nowMs: at, targetSha: 'a'.repeat(40),
    profile: { membership_level: 'admin', role: 'admin', status: 'approved', is_active: true },
  });
  assert.deepEqual(audit.checks.find((c) => c.id === 'SIGNAL_FRESHNESS_AND_SHA')?.codes,
    ['PREACTIVATION_HANDOFF_CANDIDATE_IDENTITY_MISSING']);
  assert.ok(audit.lifecycleCoverage.blockedControlIds.includes('FRESH_SIGNAL_SHA'));
  assert.equal(audit.ready, false);
  assert.equal(audit.activationReady, false);
  assert.equal(audit.orderRequests + audit.cancelRequests + audit.amendRequests, 0);
});

test('handoff invalid count, missing identity or invalid timestamps cannot be reported as source PASS', async () => {
  const at = Date.parse('2026-10-13T00:00:00Z');
  for (const sample of [
    { evaluatedAtMs: at, entryCount: 2, entries: [{ identity: { researchCodeSha: 'a'.repeat(40) } }],
      code: 'PREACTIVATION_HANDOFF_IDENTITY_COUNT_INVALID' },
    { evaluatedAtMs: at, entryCount: 1, entries: [{ identity: { researchCodeSha: 'b'.repeat(40) } }],
      code: 'PREACTIVATION_HANDOFF_SHA_MISMATCH' },
    { evaluatedAtMs: at, entryCount: 1, entries: [{}],
      code: 'PREACTIVATION_HANDOFF_SHA_MISMATCH' },
    { evaluatedAtMs: Number.NaN, entryCount: 1, entries: [{ identity: { researchCodeSha: 'a'.repeat(40) } }],
      code: 'PREACTIVATION_HANDOFF_STALE' },
    { evaluatedAtMs: Number.POSITIVE_INFINITY, entryCount: 1,
      entries: [{ identity: { researchCodeSha: 'a'.repeat(40) } }], code: 'PREACTIVATION_HANDOFF_STALE' },
    { evaluatedAtMs: at + 1, entryCount: 1, entries: [{ identity: { researchCodeSha: 'a'.repeat(40) } }],
      code: 'PREACTIVATION_HANDOFF_STALE' },
  ]) {
    const repository = new InMemoryTradingRepository();
    const source: Pick<MemberAutoTradingBackgroundSource, 'readHandoff' | 'readLiveAccountSnapshot'> = {
      async readHandoff() {
        return ({ status: 'READY', blockers: [], ...sample }
          as unknown as Awaited<ReturnType<MemberAutoTradingBackgroundSource['readHandoff']>>);
      },
      async readLiveAccountSnapshot() { throw new Error('CREDENTIALS_UNAVAILABLE'); },
    };
    const audit = await auditAutomaticLivePreactivation({
      userId: 'audit-owner', repository, source, nowMs: at, targetSha: 'a'.repeat(40),
      profile: { membership_level: 'admin', role: 'admin', status: 'approved', is_active: true },
    });
    assert.deepEqual(audit.checks.find((c) => c.id === 'SIGNAL_FRESHNESS_AND_SHA')?.codes,
      [sample.code]);
    assert.equal(audit.ready, false);
    assert.equal(audit.autoTradingAuthorityGrantedByAudit, false);
  }
});

test('invalid clock never turns stale source or expired formula AI proof into a PASS', async () => {
  const at = Date.parse('2026-10-13T00:00:00Z');
  for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 0.5]) {
    const repository = new InMemoryTradingRepository();
    const oldPolicy = repository.getPolicy.bind(repository);
    repository.getPolicy = async (userId) =>
      ({ ...(await oldPolicy(userId)), pilotStage: 'formula-ai-exception' });
    const source: Pick<MemberAutoTradingBackgroundSource, 'readHandoff' | 'readLiveAccountSnapshot'> = {
      async readHandoff() {
        return ({ status: 'READY', evaluatedAtMs: at, entryCount: 1, blockers: [],
          entries: [{ identity: { signalId: 'clock-test', market: 'CRYPTO_SPOT',
            researchCodeSha: 'a'.repeat(40) }, evaluatedAtMs: at }] }
          as unknown as Awaited<ReturnType<MemberAutoTradingBackgroundSource['readHandoff']>>);
      },
      async readLiveAccountSnapshot() { throw new Error('CREDENTIALS_UNAVAILABLE'); },
    };
    const audit = await auditAutomaticLivePreactivation({
      userId: 'audit-owner', repository, source, nowMs, targetSha: 'a'.repeat(40),
      profile: { membership_level: 'admin', role: 'admin', status: 'approved', is_active: true },
    });
    assert.deepEqual(audit.checks.find((c) => c.id === 'SIGNAL_FRESHNESS_AND_SHA')?.codes,
      ['PREACTIVATION_CLOCK_INVALID']);
    assert.deepEqual(audit.checks.find((c) => c.id === 'CURRENT_AI_EVIDENCE')?.codes,
      ['PREACTIVATION_CLOCK_INVALID']);
    assert.ok(Number.isFinite(Date.parse(audit.generatedAt)));
    assert.equal(audit.activationReady, false);
    assert.equal(audit.liveTradingAuthorityGrantedByAudit, false);
    assert.equal(audit.autoTradingAuthorityGrantedByAudit, false);
    assert.equal(audit.orderRequests + audit.cancelRequests + audit.amendRequests
      + audit.transferRequests + audit.withdrawalRequests, 0);
  }
});

async function historyAudit(plans: TradingPlan[], orders: TradingOrder[]) {
  const repository = new InMemoryTradingRepository();
  repository.listPlans = async () => plans;
  repository.listOrders = async () => orders;
  const source = { readHandoff: async () => null,
    readLiveAccountSnapshot: async () => { throw new Error('AUDIT_ACCOUNT_NOT_CONFIGURED'); } };
  return auditAutomaticLivePreactivation({ userId: 'audit-owner', repository, source,
    profile: { membership_level: 'admin', role: 'admin', status: 'approved', is_active: true },
    targetSha: 'a'.repeat(40), nowMs: Date.parse('2026-10-12T01:00:00Z') });
}

test('legacy ACL-only budget v2 cannot certify the definition-bound v3 guard', async () => {
  for (const version of ['automatic-live-atomic-budget-v2', 'automatic-live-atomic-budget-v3']) {
    const repository = Object.assign(new InMemoryTradingRepository(), {
      readAutomaticLiveBudgetGuard: async () => ({ ready: true, version }),
    });
    const audit = await auditAutomaticLivePreactivation({ userId: 'audit-owner', repository,
      source: { readHandoff: async () => null,
        readLiveAccountSnapshot: async () => { throw new Error('CREDENTIALS_UNAVAILABLE'); } },
      profile: { membership_level: 'admin', role: 'admin', status: 'approved', is_active: true },
      targetSha: 'a'.repeat(40), nowMs: Date.parse('2026-10-12T01:00:00Z') });
    const guard = audit.checks.find((row) => row.id === 'ATOMIC_BUDGET_GUARD_INSTALLED')!;
    assert.equal(guard.status, version.endsWith('v3') ? 'PASS' : 'BLOCKED');
    assert.equal(audit.activationReady, false);
    assert.equal(audit.orderRequests + audit.cancelRequests + audit.amendRequests, 0);
  }
});
const historyPlan = (id: string, accountMode: 'live' | 'paper', key = id): TradingPlan => ({
  id, userId: 'audit-owner', accountMode, exchange: 'upbit', executionMode: 'manual',
  signalReasons: [], reduceOnly: false, idempotencyKey: key,
  strategyId: 'history-test', signalId: id, symbol: 'BTC', market: 'KRW', side: 'buy',
  orderType: 'limit', estimatedKrw: 10_000, stopPrice: 90, targetPrices: [105], splitRatios: [100],
  state: 'REJECTED', approvedAt: null, approvalExpiresAt: null,
  createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z',
  marketSnapshot: { currentPrice: 100, openPositionCount: 0 } as TradingPlan['marketSnapshot'],
});
const historyOrder = (id: string, planId: string, clientOrderId = id,
  state: TradingOrder['state'] = 'REJECTED'): TradingOrder => ({
  id, userId: 'audit-owner', planId, exchange: 'upbit', clientOrderId, state, filledQuantity: 0,
  exchangeOrderId: null, requestedQuantity: 1, averageFillPrice: null, retryCount: 0, lastErrorCode: null,
  createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z',
});

test('known Paper duplicate keys and pending orders cannot block otherwise isolated LIVE history', async () => {
  const audit = await historyAudit([
    historyPlan('paper-1', 'paper', 'shared-key'), historyPlan('paper-2', 'paper', 'shared-key'),
    historyPlan('live-1', 'live', 'shared-key'),
  ], [historyOrder('paper-o1', 'paper-1', 'shared-client', 'RECOVERY_REQUIRED'),
    historyOrder('paper-o2', 'paper-2', 'shared-client', 'SUBMITTED'),
    historyOrder('live-o1', 'live-1', 'shared-client')]);
  for (const id of ['CANONICAL_OWNERSHIP_AND_DUPLICATES', 'LIVE_PENDING_AND_RECOVERY']) {
    assert.equal(audit.checks.find((c) => c.id === id)!.status, 'PASS');
  }
  assert.equal(audit.ready, false, 'isolating Paper is not an activation permission');
  assert.equal(audit.activationReady, false);
});

test('real LIVE duplicates and pending recovery still block after Paper isolation', async () => {
  const plans = [historyPlan('live-1', 'live', 'shared'), historyPlan('live-2', 'live', 'shared')];
  const orders = [historyOrder('live-o1', 'live-1', 'duplicate', 'RECOVERY_REQUIRED'),
    historyOrder('live-o2', 'live-2', 'duplicate')];
  let audit = await historyAudit(plans, orders);
  assert.deepEqual(audit.checks.find((c) => c.id === 'CANONICAL_OWNERSHIP_AND_DUPLICATES')!.codes,
    ['PREACTIVATION_DUPLICATE_CLIENT_ORDER_ID']);
  assert.deepEqual(audit.checks.find((c) => c.id === 'LIVE_PENDING_AND_RECOVERY')!.codes,
    ['PREACTIVATION_LIVE_ORDER_RECONCILIATION_REQUIRED']);
  orders[1]!.clientOrderId = 'unique';
  audit = await historyAudit(plans, orders);
  assert.deepEqual(audit.checks.find((c) => c.id === 'CANONICAL_OWNERSHIP_AND_DUPLICATES')!.codes,
    ['PREACTIVATION_DUPLICATE_IDEMPOTENCY_KEY']);
});

test('unknown parent or wrong LIVE provider/owner is not silently classified as Paper', async () => {
  for (const order of [historyOrder('unknown', 'missing'),
    { ...historyOrder('wrong-owner', 'live-1'), userId: 'another-owner' },
    { ...historyOrder('wrong-provider', 'live-1'), exchange: 'bitget' as const }]) {
    const audit = await historyAudit([historyPlan('live-1', 'live')], [order]);
    assert.equal(audit.checks.find((c) => c.id === 'CANONICAL_OWNERSHIP_AND_DUPLICATES')!.status, 'BLOCKED');
    if (order.planId === 'missing') {
      assert.deepEqual(audit.checks.find((c) => c.id === 'LIVE_PENDING_AND_RECOVERY')!.codes,
        ['PREACTIVATION_ORDER_PARENT_UNRESOLVED']);
    }
  }
});

test('uppercase credentials and arbitrary provider errors never become sanitized audit codes', async () => {
  const secret = 'API_KEY_PASSPHRASE_SIGNATURE_MUST_NOT_ESCAPE';
  const repository = new InMemoryTradingRepository();
  repository.getPolicy = async () => { throw new Error(secret); };
  const source = { readHandoff: async () => { throw new Error(secret); },
    readLiveAccountSnapshot: async () => { throw new Error(secret); } };
  const audit = await auditAutomaticLivePreactivation({ userId: 'audit-owner', repository, source,
    profile: { membership_level: 'admin', role: 'admin', status: 'approved', is_active: true },
    targetSha: 'a'.repeat(40), nowMs: Date.parse('2026-10-12T01:00:00Z') });
  assert.equal(JSON.stringify(audit).includes(secret), false);
  assert.ok(audit.checks.filter((check) => check.id.startsWith('ACCOUNT_'))
    .every((check) => check.codes[0] === 'PREACTIVATION_EVIDENCE_UNAVAILABLE'));
});

test('one coverage report retains all 26 lifecycle controls and never promotes unobserved operations', async () => {
  const audit = await historyAudit([], []);
  const manifest = JSON.parse(readFileSync('.github/config/automatic-live-preactivation-checklist.json', 'utf8'));
  assert.deepEqual(audit.lifecycleCoverage.controls.map(({ id, phase }) => ({ id, phase })),
    manifest.requiredChecks.map(({ id, phase }: { id: string; phase: string }) => ({ id, phase })));
  assert.equal(audit.lifecycleCoverage.controls.length, 26);
  for (const id of ['MAIN_PRODUCTION_IDENTITY', 'FRESH_MARKET_SESSION', 'ATOMIC_AGGREGATE_BUDGET',
    'NATIVE_FUTURES_PROTECTION', 'RECOVERY_WORKER_HEALTH', 'PM2_PERSISTENCE_AND_ROLLBACK', 'POST_ARM_HEALTH']) {
    assert.ok(audit.lifecycleCoverage.unobservedControlIds.includes(id));
  }
  assert.ok(audit.lifecycleCoverage.blockedControlIds.includes('SCANNER_PRODUCER_CONNECTED'));
  const passingSubset = automaticLiveLifecycleCoverage(audit.checks.map((check) => ({ ...check, status: 'PASS', codes: [] })));
  assert.ok(passingSubset.unobservedControlIds.length > 0);
  assert.equal(passingSubset.activationReady, false);
  assert.equal(passingSubset.liveTradingAuthorityGranted, false);
  assert.equal(passingSubset.autoTradingAuthorityGranted, false);
});
