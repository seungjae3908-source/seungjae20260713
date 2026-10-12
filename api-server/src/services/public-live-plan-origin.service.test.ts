import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicLivePlanOrigin, publicPlanPolicy, assertPublicPlanApprovalOrigin } from './public-live-plan-origin.service';
import { DEFAULT_TRADING_POLICY, type TradingPlanInput, type TradingPlan } from './trade-automation.types';

test('every public Live provider remains manual approval even while its stored AUTO policy is enabled', () => {
  const stored = { ...structuredClone(DEFAULT_TRADING_POLICY), mode: 'automatic' as const, automaticEnabled: true };
  const original = structuredClone(stored);
  for (const exchange of ['kiwoom', 'toss', 'upbit', 'bitget'] as const) {
    const input = { exchange, accountMode: 'live', signalReasons: ['member manual rationale'] } as TradingPlanInput;
    const local = publicPlanPolicy(input, stored);
    assert.equal(local.mode, 'approval'); assert.equal(local.automaticEnabled, false);
    assert.equal(local.maxOrderKrw, stored.maxOrderKrw);
    assert.equal(local.emergencyStopped, stored.emergencyStopped);
    assert.equal(local.newEntriesStopped, stored.newEntriesStopped);
    assert.notEqual(local, stored); assert.deepEqual(stored, original);
  }
});

test('client execution labels and AUTO ownership, exit parent or pilot receipts are rejected before any repository access', () => {
  const input = { accountMode: 'live', signalReasons: ['manual'] } as TradingPlanInput;
  for (const executionMode of ['automatic', 'AUTOMATIC', null, true]) {
    assert.throws(() => assertPublicLivePlanOrigin({ ...input, executionMode }), /PUBLIC_AUTOMATIC_LIVE_ORIGIN_FORBIDDEN/);
  }
  for (const reason of ['CANONICAL_LIVE_AUTO_HANDOFF', ' AUTO_EXIT_ENTRY_PLAN:owned ', 'PILOT_DYNAMIC_CAP_V1:forged']) {
    assert.throws(() => assertPublicLivePlanOrigin({ ...input, signalReasons: [reason] }), /PUBLIC_AUTOMATIC_LIVE_ORIGIN_FORBIDDEN/);
  }
  for (const signalReasons of [null, 1, {}, [true]]) {
    assert.throws(() => assertPublicLivePlanOrigin({ ...input, signalReasons } as unknown as TradingPlanInput), /PUBLIC_AUTOMATIC_LIVE_ORIGIN_FORBIDDEN/);
  }
});

test('HTTP approval cannot start a background AUTO Live plan or reclassify its owned exit as manual', () => {
  const plan = { accountMode: 'live', executionMode: 'automatic', signalReasons: [] } as unknown as TradingPlan;
  assert.throws(() => assertPublicPlanApprovalOrigin(plan), /BACKGROUND_EXECUTION_REQUIRED/);
  for (const reason of ['CANONICAL_LIVE_AUTO_HANDOFF', 'AUTO_EXIT_ENTRY_PLAN:owned']) {
    assert.throws(() => assertPublicPlanApprovalOrigin({ ...plan, executionMode: 'manual', signalReasons: [reason] }), /BACKGROUND_EXECUTION_REQUIRED/);
  }
  assert.doesNotThrow(() => assertPublicPlanApprovalOrigin({ ...plan, executionMode: 'manual' }));
});

test('public Paper remains independent and trusted internal AUTO services are not altered', () => {
  const stored = { ...structuredClone(DEFAULT_TRADING_POLICY), mode: 'automatic' as const, automaticEnabled: true };
  const input = { accountMode: 'paper', signalReasons: ['CANONICAL_LIVE_AUTO_HANDOFF'] } as TradingPlanInput;
  assert.equal(publicPlanPolicy(input, stored), stored);
  assert.doesNotThrow(() => assertPublicPlanApprovalOrigin({ ...input, executionMode: 'automatic' } as TradingPlan));
});
