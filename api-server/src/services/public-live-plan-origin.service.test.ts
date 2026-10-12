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
  for (const reason of ['CANONICAL_LIVE_AUTO_HANDOFF', ' AUTO_EXIT_ENTRY_PLAN:owned ', 'PILOT_DYNAMIC_CAP_V1:forged',
    'CANONICAL_PAPER_HANDOFF', 'STRATEGY_RULE_PACK:TREND_PULLBACK_REACCEL_V1',
    'STRATEGY_RULE_PACK_GATE:PAPER_CANDIDATE', 'AI_REVIEW_DECISION:PASS',
    'AI_REVIEW_LIVE_ELIGIBLE:PASS_ONLY_ELIGIBLE', 'AI_REVIEW_EVIDENCE:' + 'a'.repeat(64),
    'AI_REVIEW_EXPIRES:2099-01-01T00:00:00Z']) {
    assert.throws(() => assertPublicLivePlanOrigin({ ...input, signalReasons: [reason] }), /PUBLIC_AUTOMATIC_LIVE_ORIGIN_FORBIDDEN/);
  }
  for (const signalReasons of [null, 1, {}, [true]]) {
    assert.throws(() => assertPublicLivePlanOrigin({ ...input, signalReasons } as unknown as TradingPlanInput), /PUBLIC_AUTOMATIC_LIVE_ORIGIN_FORBIDDEN/);
  }
});

test('HTTP approval cannot start a background AUTO Live plan or reclassify its owned exit as manual', () => {
  const plan = { accountMode: 'live', executionMode: 'automatic', signalReasons: [] } as unknown as TradingPlan;
  assert.throws(() => assertPublicPlanApprovalOrigin(plan), /BACKGROUND_EXECUTION_REQUIRED/);
  for (const reason of ['CANONICAL_LIVE_AUTO_HANDOFF', 'AUTO_EXIT_ENTRY_PLAN:owned',
    'CANONICAL_PAPER_HANDOFF', 'AI_REVIEW_DECISION:PASS', 'STRATEGY_RULE_PACK_GATE:PAPER_CANDIDATE']) {
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

test('unknown/case-coerced account mode cannot inherit a non-live policy or skip origin validation', () => {
  const policy = { ...structuredClone(DEFAULT_TRADING_POLICY), mode: 'automatic' as const, automaticEnabled: true };
  for (const accountMode of [undefined, null, 'LIVE', ' live ', 'unknown', 0, {}, []]) {
    const input = { accountMode, signalReasons: [] } as unknown as TradingPlanInput;
    assert.throws(() => publicPlanPolicy(input, policy), /PUBLIC_TRADING_ACCOUNT_MODE_INVALID/);
    assert.throws(() => assertPublicPlanApprovalOrigin(input as TradingPlan), /PUBLIC_TRADING_ACCOUNT_MODE_INVALID/);
  }
  const mock = { accountMode: 'mock', signalReasons: [] } as unknown as TradingPlanInput;
  assert.equal(publicPlanPolicy(mock, policy), policy, 'explicit broker mock remains non-LIVE and unchanged');
});
