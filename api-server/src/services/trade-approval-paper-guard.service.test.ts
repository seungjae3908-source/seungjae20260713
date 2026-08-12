import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TRADING_POLICY,
  type TradingPlan,
} from './trade-automation.types';
import {
  approvalOnlyPolicy,
  assertPaperApprovalEnvelope,
  assertPaperApprovalPlan,
} from './trade-approval-paper-guard.service';

function errorCode(operation: () => void) {
  try {
    operation();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test('paper approval envelope rejects automatic and live elevation attempts', () => {
  assert.equal(errorCode(() => assertPaperApprovalEnvelope({ mode: 'automatic' })), 'AUTOMATIC_MODE_FORBIDDEN');
  assert.equal(errorCode(() => assertPaperApprovalEnvelope({ automaticEnabled: true })), 'AUTOMATIC_MODE_FORBIDDEN');
  assert.equal(errorCode(() => assertPaperApprovalEnvelope({ accountMode: 'live' })), 'LIVE_MODE_FORBIDDEN');
  assert.equal(errorCode(() => assertPaperApprovalEnvelope({ liveOrderEnabled: true })), 'LIVE_MODE_FORBIDDEN');
});

test('paper approval envelope rejects unknown or mismatched adapters', () => {
  assert.equal(errorCode(() => assertPaperApprovalEnvelope({ accountMode: 'paper', adapter: 'bitget-live' })), 'PAPER_ADAPTER_REQUIRED');
  assert.equal(errorCode(() => assertPaperApprovalEnvelope({ accountMode: 'mock', executionAdapter: 'paper' })), 'PAPER_ADAPTER_REQUIRED');
  assert.equal(errorCode(() => assertPaperApprovalEnvelope({ accountMode: 'sandbox' })), 'PAPER_ACCOUNT_MODE_REQUIRED');
});

test('paper approval envelope permits only explicit paper or mock modes', () => {
  assert.doesNotThrow(() => assertPaperApprovalEnvelope({ mode: 'approval', accountMode: 'paper', adapter: 'paper' }, { requireAccountMode: true }));
  assert.doesNotThrow(() => assertPaperApprovalEnvelope({ mode: 'approval', accountMode: 'mock', adapter: 'mock-simulator' }, { requireAccountMode: true }));
  assert.equal(errorCode(() => assertPaperApprovalEnvelope({ mode: 'approval' }, { requireAccountMode: true })), 'PAPER_ACCOUNT_MODE_REQUIRED');
});

test('stored live plan cannot enter the approval execution path', () => {
  const plan = { accountMode: 'live' } as TradingPlan;
  assert.equal(errorCode(() => assertPaperApprovalPlan(plan)), 'LIVE_MODE_FORBIDDEN');
});

test('approval policy always disables automatic execution and every exchange switch', () => {
  const policy = approvalOnlyPolicy({
    ...DEFAULT_TRADING_POLICY,
    mode: 'automatic',
    automaticEnabled: true,
    exchangeEnabled: { bitget: true, upbit: true, kiwoom: true, toss: true },
    providerModes: { bitget: 'LIVE', upbit: 'LIVE', kiwoom: 'LIVE', toss: 'LIVE' },
    enabledAssets: { bitget: ['BTCUSDT'], upbit: ['BTC'], kiwoom: ['005930'], toss: ['005930'] },
    enabledStrategies: ['unsafe-auto'],
  });
  assert.equal(policy.mode, 'approval');
  assert.equal(policy.automaticEnabled, false);
  assert.deepEqual(policy.exchangeEnabled, { bitget: false, upbit: false, kiwoom: false, toss: false });
  assert.deepEqual(policy.providerModes, { bitget: 'OFF', upbit: 'OFF', kiwoom: 'OFF', toss: 'OFF' });
  assert.deepEqual(policy.enabledAssets, { bitget: [], upbit: [], kiwoom: [], toss: [] });
  assert.deepEqual(policy.enabledStrategies, []);
});