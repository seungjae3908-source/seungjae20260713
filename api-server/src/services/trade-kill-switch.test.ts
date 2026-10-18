import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { killSwitchReasons, tripKillSwitchForRiskFailure } from './trade-kill-switch.service';

const USER = '11111111-1111-1111-1111-111111111111';

test('severe market, account, execution and reconciliation failures map to kill switch', () => {
  const reasons = killSwitchReasons([
    'FAST_MOVE_DETECTED',
    'DAILY_LOSS_LIMIT',
    'ACCOUNT_STATE_MISMATCH',
    'ORDER_STATE_UNKNOWN',
    'EXECUTION_RECONCILIATION_FAILED',
    'MAX_ORDER_AMOUNT',
  ]);
  assert.deepEqual(reasons, [
    'FAST_MOVE_DETECTED',
    'DAILY_LOSS_LIMIT',
    'ACCOUNT_STATE_MISMATCH',
    'ORDER_STATE_UNKNOWN',
    'EXECUTION_RECONCILIATION_FAILED',
  ]);
});

test('severe risk failure persists global new-order halt', async () => {
  const repository = new InMemoryTradingRepository();
  await repository.setGlobalEmergencyStop(false, USER);
  const result = await tripKillSwitchForRiskFailure({
    repository,
    userId: USER,
    blockCodes: ['FAST_MOVE_DETECTED'],
  });
  assert.equal(result.tripped, true);
  assert.equal(await repository.getGlobalEmergencyStop(), true);
});

test('ordinary single-order rejection does not broaden into global halt', async () => {
  const repository = new InMemoryTradingRepository();
  await repository.setGlobalEmergencyStop(false, USER);
  const result = await tripKillSwitchForRiskFailure({
    repository,
    userId: USER,
    blockCodes: ['MAX_ORDER_AMOUNT'],
  });
  assert.equal(result.tripped, false);
  assert.equal(await repository.getGlobalEmergencyStop(), false);
});

test('simulated (paper/mock) failures never trip the global halt that also stops real-money orders; live and unknown still do', async () => {
  for (const [accountMode, expected] of [['paper', false], ['mock', false], ['live', true], [undefined, true], [null, true]] as const) {
    const repository = new InMemoryTradingRepository();
    await repository.setGlobalEmergencyStop(false, USER);
    const result = await tripKillSwitchForRiskFailure({ repository, userId: USER, blockCodes: ['MARKET_DATA_STALE', 'ORDER_STATE_UNKNOWN'], accountMode });
    assert.equal(result.tripped, expected, String(accountMode));
    assert.equal(await repository.getGlobalEmergencyStop(), expected, String(accountMode));
    assert.deepEqual(result.reasons.sort(), ['MARKET_DATA_STALE', 'ORDER_STATE_UNKNOWN']);
  }
});

test('the account-level daily loss limit keeps its global effect even for a paper plan', async () => {
  const repository = new InMemoryTradingRepository();
  await repository.setGlobalEmergencyStop(false, USER);
  const result = await tripKillSwitchForRiskFailure({ repository, userId: USER, blockCodes: ['DAILY_LOSS_LIMIT'], accountMode: 'paper' });
  assert.equal(result.tripped, true);
  assert.equal(await repository.getGlobalEmergencyStop(), true);
});
