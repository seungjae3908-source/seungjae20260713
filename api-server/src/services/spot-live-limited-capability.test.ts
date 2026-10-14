import test from 'node:test';
import assert from 'node:assert/strict';
import {
  liveExecutionAuthority,
  spotLiveCapabilityDecision,
  spotLiveRuntimeStatus,
} from './spot-live-limited-capability.service';

const FULL_UPBIT_ENVIRONMENT = Object.freeze({
  executionAuthority: 'SPOT_LIVE_LIMITED',
  LIVE_TRADING: 'true',
  ORDER_EXECUTION_ENABLED: 'true',
  LIVE_TRADING_ACTIVATION_APPROVED: 'true',
  SPOT_LIVE_LIMITED_ACTIVATION_APPROVED: 'true',
  REAL_ORDER_ENABLED: 'true',
  PRIVATE_TRADING_API_ALLOWED: 'true',
  UPBIT_LIVE_ORDER_ENABLED: 'true',
  SPOT_LIVE_CAPABILITY_ALLOWLIST: 'BALANCE_READ,POSITION_READ,OPEN_ORDER_READ,ORDER_CREATE,ORDER_CANCEL',
  SPOT_LIVE_MARKET_ALLOWLIST: 'CRYPTO_SPOT',
});

test('authority is NONE when no authority key is configured', () => {
  assert.equal(liveExecutionAuthority({}), 'NONE');
});

test('legacy executionAuthority key keeps working', () => {
  assert.equal(liveExecutionAuthority({ executionAuthority: 'SPOT_LIVE_LIMITED' }), 'SPOT_LIVE_LIMITED');
  assert.equal(liveExecutionAuthority({ executionAuthority: ' manual ' }), 'MANUAL');
});

test('UPPER_SNAKE_CASE alias SPOT_LIVE_EXECUTION_AUTHORITY is accepted', () => {
  assert.equal(liveExecutionAuthority({ SPOT_LIVE_EXECUTION_AUTHORITY: 'SPOT_LIVE_LIMITED' }), 'SPOT_LIVE_LIMITED');
});

test('both keys with the same value are accepted', () => {
  assert.equal(liveExecutionAuthority({
    executionAuthority: 'SPOT_LIVE_LIMITED',
    SPOT_LIVE_EXECUTION_AUTHORITY: 'spot_live_limited',
  }), 'SPOT_LIVE_LIMITED');
});

test('conflicting keys fail closed to NONE', () => {
  assert.equal(liveExecutionAuthority({
    executionAuthority: 'SPOT_LIVE_LIMITED',
    SPOT_LIVE_EXECUTION_AUTHORITY: 'MANUAL',
  }), 'NONE');
  assert.equal(liveExecutionAuthority({
    executionAuthority: 'garbage',
    SPOT_LIVE_EXECUTION_AUTHORITY: 'SPOT_LIVE_LIMITED',
  }), 'NONE');
});

test('unknown or blank values never grant authority', () => {
  assert.equal(liveExecutionAuthority({ executionAuthority: 'FUTURES_LIVE_LIMITED' }), 'NONE');
  assert.equal(liveExecutionAuthority({ SPOT_LIVE_EXECUTION_AUTHORITY: '   ' }), 'NONE');
});

test('upbit order creation is allowed only with every required setting', () => {
  const allowed = spotLiveCapabilityDecision({
    exchange: 'upbit', capability: 'ORDER_CREATE', environment: FULL_UPBIT_ENVIRONMENT,
  });
  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.blockCodes, []);

  const { UPBIT_LIVE_ORDER_ENABLED: _removed, ...withoutProviderGate } = FULL_UPBIT_ENVIRONMENT;
  const blocked = spotLiveCapabilityDecision({
    exchange: 'upbit', capability: 'ORDER_CREATE', environment: withoutProviderGate,
  });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.blockCodes.includes('SPOT_LIVE_PROVIDER_GATE_OFF'));
});

test('upbit order creation through the alias key is allowed', () => {
  const { executionAuthority: _legacy, ...rest } = FULL_UPBIT_ENVIRONMENT;
  const decision = spotLiveCapabilityDecision({
    exchange: 'upbit',
    capability: 'ORDER_CREATE',
    environment: { ...rest, SPOT_LIVE_EXECUTION_AUTHORITY: 'SPOT_LIVE_LIMITED' },
  });
  assert.equal(decision.allowed, true);
});

test('hard-denied capabilities and bitget order creation stay blocked', () => {
  const withdraw = spotLiveCapabilityDecision({
    exchange: 'upbit',
    capability: 'ORDER_CREATE',
    environment: { ...FULL_UPBIT_ENVIRONMENT, SPOT_LIVE_CAPABILITY_ALLOWLIST: 'BALANCE_READ,POSITION_READ,OPEN_ORDER_READ,ORDER_CREATE,WITHDRAW' },
  });
  assert.equal(withdraw.allowed, false);
  assert.ok(withdraw.blockCodes.includes('SPOT_LIVE_DENIED_CAPABILITY_REQUESTED'));

  const bitget = spotLiveCapabilityDecision({
    exchange: 'bitget',
    capability: 'ORDER_CREATE',
    environment: { ...FULL_UPBIT_ENVIRONMENT, BITGET_LIVE_ORDER_ENABLED: 'true' },
  });
  assert.equal(bitget.allowed, false);
  assert.ok(bitget.blockCodes.includes('FUTURES_HARD_DISABLED'));
});

test('runtime status explains what blocks order creation without leaking values', () => {
  const closed = spotLiveRuntimeStatus({});
  assert.ok(closed.orderCreateBlockCodes.upbit.includes('SPOT_LIVE_EXECUTION_AUTHORITY_MISMATCH'));
  assert.ok(closed.orderCreateBlockCodes.upbit.includes('LIVE_TRADING_OFF'));
  assert.ok(closed.orderCreateBlockCodes.bitget.includes('FUTURES_HARD_DISABLED'));

  const open = spotLiveRuntimeStatus({ ...FULL_UPBIT_ENVIRONMENT });
  assert.deepEqual(open.orderCreateBlockCodes.upbit, []);
  assert.equal(open.executionAuthority, 'SPOT_LIVE_LIMITED');
  for (const code of Object.values(open.orderCreateBlockCodes).flat()) {
    assert.match(code, /^[A-Z0-9_]+$/u);
  }
});
