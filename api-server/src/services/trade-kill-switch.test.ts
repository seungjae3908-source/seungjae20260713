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
