import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTO_TRADING_LIVE_SAFETY_RELEASE,
  assertLiveActivationBlocked,
  buildProtectiveStopPlan,
  evaluateLiveSafetyReadiness,
  evaluateRestartSafety,
  reconcileMockExecution,
  type LiveSafetyGateInput,
} from './auto-trading-live-safety.service';

const allPreparationGates: LiveSafetyGateInput = {
  operatorManualApproval: true,
  exchangePermissionAudit: true,
  protectiveStopPlan: true,
  liquidationGuard: true,
  orderReconciliation: true,
  cancelReconciliation: true,
  positionReconciliation: true,
  killSwitchPersistence: true,
  restartRecovery: true,
  idempotency: true,
  mockCanary: true,
  exactHeadCi: true,
};

test('live safety release is preparation only with zero real/private counters', () => {
  assert.equal(AUTO_TRADING_LIVE_SAFETY_RELEASE.releaseMode, 'PREPARATION_ONLY');
  assert.equal(AUTO_TRADING_LIVE_SAFETY_RELEASE.liveActivationIncluded, false);
  assert.equal(AUTO_TRADING_LIVE_SAFETY_RELEASE.liveTrading, false);
  assert.equal(AUTO_TRADING_LIVE_SAFETY_RELEASE.realOrderCount, 0);
  assert.equal(AUTO_TRADING_LIVE_SAFETY_RELEASE.realCancelCount, 0);
  assert.equal(AUTO_TRADING_LIVE_SAFETY_RELEASE.privateTradingApiCount, 0);
  assert.equal(AUTO_TRADING_LIVE_SAFETY_RELEASE.credentialsAcceptedByRuntime, false);
  assert.equal(AUTO_TRADING_LIVE_SAFETY_RELEASE.signedPrivateRequestsAllowed, false);
});

test('all preparation gates can pass without enabling live activation', () => {
  const readiness = evaluateLiveSafetyReadiness(allPreparationGates);
  assert.equal(readiness.preparationComplete, true);
  assert.equal(readiness.liveActivationAllowed, false);
  assert.equal(readiness.liveTrading, false);
  assert.equal(readiness.realOrderCount, 0);
  assert.equal(readiness.realCancelCount, 0);
  assert.equal(readiness.privateTradingApiCount, 0);
  assert.deepEqual(readiness.unmetGates, []);
});

test('missing safety gate keeps preparation incomplete and live locked', () => {
  const readiness = evaluateLiveSafetyReadiness({ ...allPreparationGates, liquidationGuard: false });
  assert.equal(readiness.preparationComplete, false);
  assert.equal(readiness.liveActivationAllowed, false);
  assert.deepEqual(readiness.unmetGates, ['liquidationGuard']);
});

test('activation assertion always rejects in this release', () => {
  assert.throws(() => assertLiveActivationBlocked(), /AUTO_TRADING_LIVE_ACTIVATION_NOT_INCLUDED/);
});

test('protective stop planning is pure and rejects unsafe geometry', () => {
  const ready = buildProtectiveStopPlan({ direction: 'LONG', entryPrice: 100, stopPrice: 98, markPrice: 101 });
  assert.equal(ready.status, 'READY_FOR_MOCK_VALIDATION');
  assert.equal(ready.source, 'PLANNING_ONLY');
  if (ready.status === 'READY_FOR_MOCK_VALIDATION') {
    assert.equal(ready.triggerDirection, 'BELOW_MARK');
    assert.equal(ready.stopBeforeAdverseMove, true);
    assert.equal(ready.stopDistancePercent, 2);
  }

  const unavailable = buildProtectiveStopPlan({ direction: 'SHORT', entryPrice: 100, stopPrice: 99, markPrice: 98 });
  assert.equal(unavailable.status, 'UNAVAILABLE');
});

test('mock reconciliation halts duplicate execution identity', () => {
  const persisted = [{ signalId: 'sig-1', executionId: 'exec-1', idempotencyKey: 'idem-1', state: 'POSITION_PROTECTED' }];
  const duplicate = reconcileMockExecution(
    { signalId: 'sig-1', executionId: 'exec-2', idempotencyKey: 'idem-2', state: 'ORDER_PLANNED' },
    persisted,
  );
  assert.equal(duplicate.status, 'SAFE_HALT');
  assert.equal(duplicate.duplicateSignal, true);

  const unique = reconcileMockExecution(
    { signalId: 'sig-2', executionId: 'exec-2', idempotencyKey: 'idem-2', state: 'ORDER_PLANNED' },
    persisted,
  );
  assert.equal(unique.status, 'MATCH');
});

test('restart safety preserves persisted kill switch and safe halt', () => {
  const halted = evaluateRestartSafety({
    persistedSafeHalt: false,
    persistedKillSwitch: true,
    reconciliationHealthy: true,
    idempotencyStateRestored: true,
  });
  assert.equal(halted.safeHalt, true);
  assert.equal(halted.killSwitch, true);
  assert.equal(halted.workerMayEvaluatePaperShadow, false);
  assert.equal(halted.liveActivationAllowed, false);

  const safe = evaluateRestartSafety({
    persistedSafeHalt: false,
    persistedKillSwitch: false,
    reconciliationHealthy: true,
    idempotencyStateRestored: true,
  });
  assert.equal(safe.safeHalt, false);
  assert.equal(safe.workerMayEvaluatePaperShadow, true);
  assert.equal(safe.liveActivationAllowed, false);
});
