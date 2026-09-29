import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SPOT_LIVE_HARD_DENIED_CAPABILITIES,
  spotLiveCapabilityDecision,
  spotLivePlanCapabilityDecision,
  spotLiveRuntimeStatus,
} from './spot-live-limited-capability.service';
import type { TradingPlanInput } from './trade-automation.types';

function environment(overrides: Record<string, string> = {}) {
  return {
    executionAuthority: 'SPOT_LIVE_LIMITED',
    LIVE_TRADING: 'true',
    ORDER_EXECUTION_ENABLED: 'true',
    LIVE_TRADING_ACTIVATION_APPROVED: 'true',
    SPOT_LIVE_LIMITED_ACTIVATION_APPROVED: 'true',
    REAL_ORDER_ENABLED: 'true',
    PRIVATE_TRADING_API_ALLOWED: 'true',
    BITGET_LIVE_ORDER_ENABLED: 'false',
    UPBIT_LIVE_ORDER_ENABLED: 'true',
    KIWOOM_LIVE_ORDER_ENABLED: 'true',
    TOSS_LIVE_ORDER_ENABLED: 'true',
    SPOT_LIVE_CAPABILITY_ALLOWLIST:
      'BALANCE_READ,POSITION_READ,OPEN_ORDER_READ,ORDER_CREATE,ORDER_CANCEL,ORDER_AMEND',
    SPOT_LIVE_MARKET_ALLOWLIST: 'KR_STOCK,US_STOCK,CRYPTO_SPOT',
    ...overrides,
  };
}

function plan(overrides: Partial<TradingPlanInput> = {}) {
  return {
    exchange: 'upbit',
    market: 'KRW',
    side: 'buy',
    leverage: null,
    marginMode: null,
    stockBroker: null,
    ...overrides,
  } as TradingPlanInput;
}

test('spot live create is capability allowlisted and exact-authority bound', () => {
  assert.equal(spotLivePlanCapabilityDecision(plan(), 'ORDER_CREATE', environment()).allowed, true);

  const legacy = spotLivePlanCapabilityDecision(
    plan(),
    'ORDER_CREATE',
    environment({ executionAuthority: 'AUTOMATIC' }),
  );
  assert.equal(legacy.allowed, false);
  assert.ok(legacy.blockCodes.includes('SPOT_LIVE_EXECUTION_AUTHORITY_MISMATCH'));

  const missingRead = spotLivePlanCapabilityDecision(
    plan(),
    'ORDER_CREATE',
    environment({ SPOT_LIVE_CAPABILITY_ALLOWLIST: 'ORDER_CREATE' }),
  );
  assert.equal(missingRead.allowed, false);
  assert.ok(missingRead.blockCodes.includes('SPOT_LIVE_CAPABILITY_MISSING_BALANCE_READ'));
  assert.ok(missingRead.blockCodes.includes('SPOT_LIVE_CAPABILITY_MISSING_POSITION_READ'));
  assert.ok(missingRead.blockCodes.includes('SPOT_LIVE_CAPABILITY_MISSING_OPEN_ORDER_READ'));
});

test('futures, margin, short, and leverage routes are hard disabled', () => {
  const futures = spotLivePlanCapabilityDecision(
    plan({ exchange: 'bitget', market: 'USDT', side: 'long', leverage: 2, marginMode: 'crossed' }),
    'ORDER_CREATE',
    environment({ BITGET_LIVE_ORDER_ENABLED: 'true' }),
  );
  assert.equal(futures.allowed, false);
  for (const code of ['FUTURES_HARD_DISABLED', 'SHORT_HARD_DISABLED', 'LEVERAGE_HARD_DISABLED', 'MARGIN_HARD_DISABLED']) {
    assert.ok(futures.blockCodes.includes(code), `missing blocker ${code}`);
  }

  const denied = spotLiveCapabilityDecision({
    exchange: 'upbit',
    capability: 'ORDER_CREATE',
    environment: environment({
      SPOT_LIVE_CAPABILITY_ALLOWLIST: 'BALANCE_READ,POSITION_READ,OPEN_ORDER_READ,ORDER_CREATE,WITHDRAW',
    }),
  });
  assert.equal(denied.allowed, false);
  assert.ok(denied.blockCodes.includes('SPOT_LIVE_DENIED_CAPABILITY_REQUESTED'));
});

test('market and provider matrix permits three spot markets without widening providers', () => {
  const cases: Array<[Partial<TradingPlanInput>, boolean]> = [
    [{ exchange: 'kiwoom', stockBroker: 'kiwoom', market: 'KR' }, true],
    [{ exchange: 'kiwoom', stockBroker: 'kiwoom', market: 'US' }, true],
    [{ exchange: 'toss', stockBroker: 'toss', market: 'KR' }, true],
    [{ exchange: 'toss', stockBroker: 'toss', market: 'US' }, true],
    [{ exchange: 'upbit', stockBroker: null, market: 'KRW' }, true],
    [{ exchange: 'upbit', stockBroker: null, market: 'USDT' }, false],
  ];
  for (const [overrides, expected] of cases) {
    assert.equal(
      spotLivePlanCapabilityDecision(plan(overrides), 'ORDER_CREATE', environment()).allowed,
      expected,
      JSON.stringify(overrides),
    );
  }
});

test('crypto spot allows cancel but never amend', () => {
  assert.equal(spotLivePlanCapabilityDecision(plan(), 'ORDER_CANCEL', environment()).allowed, true);
  const amend = spotLivePlanCapabilityDecision(plan(), 'ORDER_AMEND', environment());
  assert.equal(amend.allowed, false);
  assert.ok(amend.blockCodes.includes('SPOT_LIVE_PROVIDER_CAPABILITY_UNSUPPORTED_ORDER_AMEND'));
  assert.ok(amend.blockCodes.includes('CRYPTO_SPOT_AMEND_HARD_DISABLED'));
});

test('runtime status publishes every permanent deny as false', () => {
  const status = spotLiveRuntimeStatus(environment());
  assert.equal(status.executionAuthority, 'SPOT_LIVE_LIMITED');
  assert.equal(status.providerCapabilities.bitget.ORDER_CREATE, false);
  assert.equal(status.providerCapabilities.upbit.ORDER_CREATE, true);
  for (const capability of SPOT_LIVE_HARD_DENIED_CAPABILITIES) {
    assert.equal(status.hardDeniedCapabilities[capability], false);
  }
});
