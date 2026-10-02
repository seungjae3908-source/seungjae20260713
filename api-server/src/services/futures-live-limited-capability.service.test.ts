import test from 'node:test';
import assert from 'node:assert/strict';
import type { TradingPlanInput } from './trade-automation.types';
import {
  FUTURES_LIVE_HARD_DENIED_CAPABILITIES,
  futuresLiveCapabilityDecision,
  futuresLivePlanCapabilityDecision,
  futuresLiveRuntimeStatus,
} from './futures-live-limited-capability.service';

function environment(overrides: Record<string, string> = {}) {
  return {
    LIVE_TRADING: 'true',
    ORDER_EXECUTION_ENABLED: 'true',
    LIVE_TRADING_ACTIVATION_APPROVED: 'true',
    REAL_ORDER_ENABLED: 'true',
    PRIVATE_TRADING_API_ALLOWED: 'true',
    FUTURES_LIVE_LIMITED_ACTIVATION_APPROVED: 'true',
    BITGET_FUTURES_LIVE_ORDER_ENABLED: 'true',
    FUTURES_LIVE_EXECUTION_AUTHORITY: 'FUTURES_LIVE_LIMITED',
    FUTURES_LIVE_CAPABILITY_ALLOWLIST: 'BALANCE_READ,POSITION_READ,OPEN_ORDER_READ,ORDER_CREATE,ORDER_CANCEL,ORDER_AMEND',
    FUTURES_LIVE_MARKET_ALLOWLIST: 'CRYPTO_FUTURES',
    FUTURES_LIVE_MAX_LEVERAGE: '3',
    FUTURES_LIVE_MARGIN_MODE: 'isolated',
    ...overrides,
  };
}

type FuturesPlan = Pick<TradingPlanInput,
  'exchange' | 'market' | 'side' | 'leverage' | 'marginMode' | 'reduceOnly'>;

function plan(overrides: Partial<FuturesPlan> = {}): FuturesPlan {
  return {
    exchange: 'bitget' as const,
    market: 'USDT-FUTURES',
    side: 'long' as const,
    leverage: 2,
    marginMode: 'isolated' as const,
    reduceOnly: false,
    ...overrides,
  };
}

test('futures live create requires exact Bitget limited authority and read prerequisites', () => {
  const decision = futuresLivePlanCapabilityDecision(plan(), 'ORDER_CREATE', environment());
  assert.equal(decision.allowed, true);

  const missingRead = futuresLivePlanCapabilityDecision(
    plan(),
    'ORDER_CREATE',
    environment({ FUTURES_LIVE_CAPABILITY_ALLOWLIST: 'ORDER_CREATE' }),
  );
  assert.equal(missingRead.allowed, false);
  assert.ok(missingRead.blockCodes.includes('FUTURES_LIVE_CAPABILITY_MISSING_BALANCE_READ'));
  assert.ok(missingRead.blockCodes.includes('FUTURES_LIVE_CAPABILITY_MISSING_POSITION_READ'));
  assert.ok(missingRead.blockCodes.includes('FUTURES_LIVE_CAPABILITY_MISSING_OPEN_ORDER_READ'));
});

test('futures live rejects non-Bitget, crossed margin, and leverage outside 2x/3x', () => {
  const nonBitget = futuresLiveCapabilityDecision({
    exchange: 'upbit',
    capability: 'ORDER_CREATE',
    plan: { ...plan(), exchange: 'upbit' },
    environment: environment(),
  });
  assert.equal(nonBitget.allowed, false);
  assert.ok(nonBitget.blockCodes.includes('FUTURES_LIVE_PROVIDER_NOT_SUPPORTED'));

  const crossed = futuresLivePlanCapabilityDecision(
    plan({ marginMode: 'crossed' }),
    'ORDER_CREATE',
    environment(),
  );
  assert.equal(crossed.allowed, false);
  assert.ok(crossed.blockCodes.includes('FUTURES_LIVE_ISOLATED_MARGIN_REQUIRED'));

  const leverage = futuresLivePlanCapabilityDecision(
    plan({ leverage: 4 }),
    'ORDER_CREATE',
    environment(),
  );
  assert.equal(leverage.allowed, false);
  assert.ok(leverage.blockCodes.includes('FUTURES_LIVE_LEVERAGE_NOT_ALLOWED'));
});

test('futures live remains fail-closed when any runtime gate is off', () => {
  for (const key of [
    'LIVE_TRADING',
    'ORDER_EXECUTION_ENABLED',
    'LIVE_TRADING_ACTIVATION_APPROVED',
    'REAL_ORDER_ENABLED',
    'PRIVATE_TRADING_API_ALLOWED',
    'FUTURES_LIVE_LIMITED_ACTIVATION_APPROVED',
    'BITGET_FUTURES_LIVE_ORDER_ENABLED',
  ]) {
    const decision = futuresLivePlanCapabilityDecision(
      plan(),
      'ORDER_CREATE',
      environment({ [key]: 'false' }),
    );
    assert.equal(decision.allowed, false, key);
    assert.ok(decision.blockCodes.includes(`${key}_OFF`), key);
  }
});

test('futures live runtime publishes transfer/withdraw/external-wallet hard denies', () => {
  const status = futuresLiveRuntimeStatus(environment());
  assert.equal(status.executionAuthority, 'FUTURES_LIVE_LIMITED');
  assert.equal(status.providerCapabilities.ORDER_CREATE, true);
  assert.equal(status.maxLeverage, 3);
  assert.equal(status.marginMode, 'isolated');
  for (const capability of FUTURES_LIVE_HARD_DENIED_CAPABILITIES) {
    assert.equal(status.hardDeniedCapabilities[capability], false);
  }
});
