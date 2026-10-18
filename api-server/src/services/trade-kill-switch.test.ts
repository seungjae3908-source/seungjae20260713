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

const OTHER = '22222222-2222-2222-2222-222222222222';
const liveEntry = { accountMode: 'live', reduceOnly: false, exchange: 'upbit', side: 'buy' } as const;

test('exchange outage on a LIVE plan persists the global new-order halt', async () => {
  for (const code of ['EXCHANGE_API_FAILURE', 'EXCHANGE_NETWORK_ERROR', 'EXCHANGE_TIMEOUT', 'MARKET_HALTED',
    'PROVIDER_CLOCK_OFFSET_TOO_LARGE', 'ORDER_STATE_UNKNOWN', 'EXECUTION_RECONCILIATION_FAILED',
    'RECOVERY_RECONCILIATION_FAILED']) {
    const repository = new InMemoryTradingRepository();
    await repository.setGlobalEmergencyStop(false, USER);
    const result = await tripKillSwitchForRiskFailure({ repository, userId: USER, blockCodes: [code], plan: liveEntry });
    assert.equal(result.tripped, true, code);
    assert.equal(result.scope, 'GLOBAL', code);
    assert.equal(await repository.getGlobalEmergencyStop(), true, code);
  }
  // A plan that cannot be read is treated as a LIVE entry (fail closed).
  const unknown = new InMemoryTradingRepository();
  await unknown.setGlobalEmergencyStop(false, USER);
  await tripKillSwitchForRiskFailure({ repository: unknown, userId: USER, blockCodes: ['ORDER_STATE_UNKNOWN'] });
  assert.equal(await unknown.getGlobalEmergencyStop(), true);
});

test('member-scoped risk failure stops only that member and never the global switch', async () => {
  for (const code of ['FAST_MOVE_DETECTED', 'ONE_MINUTE_VOLATILITY', 'DAILY_LOSS_LIMIT', 'MARKET_DATA_STALE',
    'MARKET_SNAPSHOT_STALE', 'MARKET_DATA_DELAYED', 'APPROVAL_PRICE_DRIFT_EXCEEDED', 'ACCOUNT_STATE_MISMATCH',
    'ACCOUNT_MODE_MISMATCH', 'RISK_EVIDENCE_STALE']) {
    const repository = new InMemoryTradingRepository();
    await repository.setGlobalEmergencyStop(false, USER);
    const result = await tripKillSwitchForRiskFailure({ repository, userId: USER, blockCodes: [code], plan: liveEntry });
    assert.equal(result.tripped, true, code);
    assert.equal(result.scope, 'MEMBER', code);
    assert.equal(await repository.getGlobalEmergencyStop(), false, code);
    assert.equal((await repository.getPolicy(USER)).newEntriesStopped, true, code);
    assert.equal((await repository.getPolicy(OTHER)).newEntriesStopped, false, code);
    const audit = await repository.listRunAudit(USER, 10);
    assert.equal(audit[0].action, 'KILL_SWITCH', code);
    assert.equal(audit[0].actor, 'system', code);
    assert.equal(audit[0].reason, code);
  }
});

test('Paper plans never trip the global stop, even for exchange-outage codes', async () => {
  const repository = new InMemoryTradingRepository();
  await repository.setGlobalEmergencyStop(false, USER);
  const result = await tripKillSwitchForRiskFailure({
    repository, userId: USER, blockCodes: ['EXCHANGE_TIMEOUT', 'ORDER_STATE_UNKNOWN'],
    plan: { ...liveEntry, accountMode: 'paper' },
  });
  assert.equal(result.scope, 'MEMBER');
  assert.equal(await repository.getGlobalEmergencyStop(), false);
  assert.equal((await repository.getPolicy(USER)).newEntriesStopped, true);
});

test('risk-reducing exit plans trip no kill switch at all', async () => {
  for (const plan of [
    { accountMode: 'live', reduceOnly: true, exchange: 'upbit', side: 'sell' },
    { accountMode: 'live', reduceOnly: true, exchange: 'bitget', side: 'long' },
  ] as const) {
    const repository = new InMemoryTradingRepository();
    await repository.setGlobalEmergencyStop(false, USER);
    const result = await tripKillSwitchForRiskFailure({
      repository, userId: USER, plan,
      blockCodes: ['MARKET_DATA_STALE', 'MARKET_SNAPSHOT_STALE', 'EXCHANGE_TIMEOUT', 'ORDER_STATE_UNKNOWN', 'DAILY_LOSS_LIMIT'],
    });
    assert.equal(result.tripped, false);
    assert.equal(await repository.getGlobalEmergencyStop(), false);
    assert.equal((await repository.getPolicy(USER)).newEntriesStopped, false);
    assert.deepEqual(await repository.listRunAudit(USER, 10), []);
  }
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
