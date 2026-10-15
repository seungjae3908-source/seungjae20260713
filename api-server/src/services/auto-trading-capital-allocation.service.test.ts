import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanonicalAccountSnapshot, AccountProvider } from '../features/account-readonly/account-readonly.contract';
import { normalizeTradingPolicy, evaluateTradingPlan } from './trade-automation-risk.service';
import { DEFAULT_TRADING_POLICY, type TradingPlanInput } from './trade-automation.types';
import {
  buildCapitalAllocationReadiness,
  effectiveCapitalAllocation,
  profitTargetCapitalBaseKrw,
  serverAuthoredCapitalAllocation,
  tradingCapitalChargeKrw,
} from './auto-trading-capital-allocation.service';

function snapshot(provider: AccountProvider, currency: string, available: number): CanonicalAccountSnapshot {
  return {
    provider, readOnly: true, connected: true, status: 'CONNECTED',
    accounts: [{ market: provider === 'upbit' ? 'UPBIT' : provider === 'bitget' ? 'BITGET' : 'KR',
      accountRef: `${provider}-account`, currency, buyingPower: available }],
    balances: [{ currency, available, locked: 0, total: available, estimatedKrwValue: currency === 'KRW' ? available : null }],
    positions: [], openOrders: [], checkedAt: '2026-10-14T02:00:00.000Z',
    lastGoodAt: '2026-10-14T02:00:00.000Z', stale: false, errorCode: null,
    orderRequests: 0, cancelRequests: 0, amendRequests: 0, transferRequests: 0,
    withdrawalRequests: 0, credentialsReturned: false, liveTradingEnabled: false,
    autoTradingEnabled: false,
  };
}

function policy(roleMaximumKrw = 500_000) {
  return normalizeTradingPolicy({ ...DEFAULT_TRADING_POLICY,
    totalCapitalKrw: roleMaximumKrw * 4, maxOrderKrw: roleMaximumKrw,
    maxAssetClassKrw: { domestic_stock: roleMaximumKrw, us_stock: roleMaximumKrw,
      crypto_spot: roleMaximumKrw, crypto_futures: roleMaximumKrw } }, roleMaximumKrw);
}

test('member can configure exact 100k, 250k, and 500k allocations from a verified 500k account', () => {
  for (const amount of [100_000, 250_000, 500_000]) {
    const current = policy();
    const readiness = buildCapitalAllocationReadiness({ policy: current,
      roleMaximumPerMarketKrw: 500_000, snapshots: { upbit: snapshot('upbit', 'KRW', 500_000) },
      krwPerCurrency: {}, leverage: 2 }).crypto_spot;
    const saved = serverAuthoredCapitalAllocation({ ...current.capitalAllocationByMarket.crypto_spot,
      configured: true, operatingCapitalKrw: amount, maxOrderKrw: Math.min(50_000, amount) },
    readiness, new Date('2026-10-14T02:01:00.000Z'));
    assert.equal(saved.operatingCapitalKrw, amount);
    assert.equal(saved.maxOrderKrw, Math.min(50_000, amount));
    assert.equal(saved.accountScopeId?.length, 24);
    assert.equal(saved.compoundAboveAllocation, false);
  }
});

test('administrator role ceiling allows 1m but member readiness remains capped at 500k', () => {
  const member = buildCapitalAllocationReadiness({ policy: policy(), roleMaximumPerMarketKrw: 500_000,
    snapshots: { upbit: snapshot('upbit', 'KRW', 2_000_000) }, krwPerCurrency: {}, leverage: 2 });
  const adminPolicy = policy(1_000_000);
  const admin = buildCapitalAllocationReadiness({ policy: adminPolicy, roleMaximumPerMarketKrw: 1_000_000,
    snapshots: { upbit: snapshot('upbit', 'KRW', 2_000_000) }, krwPerCurrency: {}, leverage: 7 });
  assert.equal(member.crypto_spot.currentMaximumConfigurableKrw, 500_000);
  assert.equal(admin.crypto_spot.currentMaximumConfigurableKrw, 1_000_000);
  const saved = serverAuthoredCapitalAllocation({ ...adminPolicy.capitalAllocationByMarket.crypto_spot,
    configured: true, operatingCapitalKrw: 1_000_000, maxOrderKrw: 100_000 },
  admin.crypto_spot, new Date('2026-10-14T02:01:00.000Z'));
  assert.equal(saved.operatingCapitalKrw, 1_000_000);
  assert.equal(saved.maxOrderKrw, 100_000);
});

test('unverified balance never fabricates a maximum and blocks configuration', () => {
  const current = policy();
  const readiness = buildCapitalAllocationReadiness({ policy: current, roleMaximumPerMarketKrw: 500_000,
    snapshots: {}, krwPerCurrency: {}, leverage: 2 }).crypto_spot;
  assert.equal(readiness.currentMaximumConfigurableKrw, null);
  assert.equal(readiness.verified, false);
  assert.throws(() => serverAuthoredCapitalAllocation({ ...current.capitalAllocationByMarket.crypto_spot,
    configured: true, operatingCapitalKrw: 100_000, maxOrderKrw: 50_000 }, readiness, new Date()),
  /ACCOUNT_READBACK_REQUIRED/);
});

test('two stock lanes sharing one provider cannot allocate the same cash twice', () => {
  const current = policy();
  current.capitalAllocationByMarket.domestic_stock = { ...current.capitalAllocationByMarket.domestic_stock,
    configured: true, operatingCapitalKrw: 300_000, maxOrderKrw: 50_000 };
  const readiness = buildCapitalAllocationReadiness({ policy: current, roleMaximumPerMarketKrw: 500_000,
    snapshots: { kiwoom: snapshot('kiwoom', 'USD', 500) }, krwPerCurrency: { USD: 1_000 }, leverage: 2 });
  assert.equal(readiness.us_stock.currentMaximumConfigurableKrw, 200_000);
});

test('maximum never adds the logical allocation to real buying power and a reduction remains safe', () => {
  const current = policy();
  current.capitalAllocationByMarket.crypto_spot = { ...current.capitalAllocationByMarket.crypto_spot,
    configured: true, operatingCapitalKrw: 500_000, maxOrderKrw: 100_000,
    updatedAt: '2026-10-13T00:00:00.000Z', accountScopeId: 'b'.repeat(24) };
  const readiness = buildCapitalAllocationReadiness({ policy: current,
    roleMaximumPerMarketKrw: 500_000, snapshots: { upbit: snapshot('upbit', 'KRW', 300_000) },
    krwPerCurrency: {}, leverage: 2 }).crypto_spot;
  assert.equal(readiness.actualAvailableKrw, 300_000);
  assert.equal(readiness.currentMaximumConfigurableKrw, 300_000);
  const reduced = serverAuthoredCapitalAllocation({ ...current.capitalAllocationByMarket.crypto_spot,
    operatingCapitalKrw: 250_000, maxOrderKrw: 50_000 }, readiness,
  new Date('2026-10-14T02:01:00.000Z'), current.capitalAllocationByMarket.crypto_spot);
  assert.equal(reduced.operatingCapitalKrw, 250_000);
  assert.equal(reduced.maxOrderKrw, 50_000);
});

test('futures exposes margin and leveraged notional separately', () => {
  const current = policy();
  current.capitalAllocationByMarket.crypto_futures = { ...current.capitalAllocationByMarket.crypto_futures,
    configured: true, operatingCapitalKrw: 100_000, maxOrderKrw: 100_000 };
  const readiness = buildCapitalAllocationReadiness({ policy: current, roleMaximumPerMarketKrw: 500_000,
    snapshots: { bitget: snapshot('bitget', 'USDT', 1_000) },
    krwPerCurrency: { USDT: 1_000 }, leverage: 3 });
  assert.equal(readiness.crypto_futures.futuresMarginAllocationKrw, 100_000);
  assert.equal(readiness.crypto_futures.futuresNominalCeilingKrw, 300_000);
  assert.equal(tradingCapitalChargeKrw({ exchange: 'bitget', estimatedKrw: 300_000, leverage: 3 }), 100_000);
});

test('user allocation is the profit-target base and remains an absolute entry ceiling', () => {
  const current = policy();
  current.capitalAllocationByMarket.crypto_spot = { ...current.capitalAllocationByMarket.crypto_spot,
    configured: true, operatingCapitalKrw: 250_000, maxOrderKrw: 50_000 };
  // Even if settlement-backed compounding raises legacy portfolio ceilings,
  // v1 has no opt-in to expand the selected cash allocation.
  current.totalCapitalKrw = 2_500_000;
  current.maxAssetClassKrw.crypto_spot = 750_000;
  current.maxOrderKrw = 500_000;
  assert.equal(profitTargetCapitalBaseKrw(current, 'crypto_spot', 500_000), 250_000);
  assert.deepEqual(effectiveCapitalAllocation(current, 'crypto_spot'), {
    configured: true, operatingCapitalKrw: 250_000, maxOrderKrw: 50_000,
    compoundAboveAllocation: false,
  });
});

test('risk blocks a new entry above the user allocation while a reducing exit remains eligible', () => {
  const current = policy();
  current.mode = 'automatic'; current.automaticEnabled = true;
  current.exchangeEnabled.upbit = true; current.enabledStrategies = ['TREND_PULLBACK_REACCEL_V1'];
  current.capitalAllocationByMarket.crypto_spot = { ...current.capitalAllocationByMarket.crypto_spot,
    configured: true, operatingCapitalKrw: 100_000, maxOrderKrw: 50_000 };
  const now = new Date().toISOString();
  const plan: TradingPlanInput = { exchange: 'upbit', accountMode: 'live', strategyId: 'TREND_PULLBACK_REACCEL_V1',
    signalId: 'natural-signal', symbol: 'BTC', market: 'KRW', side: 'buy', orderType: 'market',
    quantity: 0.001, quoteAmount: 70_000, limitPrice: 70_000_000, estimatedKrw: 70_000,
    stopPrice: 59_000_000, targetPrices: [62_000_000], splitRatios: [100], leverage: null,
    marginMode: null, reduceOnly: false, invalidateAction: 'hold', signalReasons: ['PUBLIC_DATA'],
    marketSnapshot: { observedAt: now, dataDelayMs: 0, oneMinuteMovePercent: 0.1,
      spreadPercent: 0.05, orderbookGapPercent: 0.05, halted: false, availableBalance: 500_000,
      accountValueKrw: 500_000, dailyPnlPercent: 0, assetExposurePercent: 10,
      accountExposureKrw: 40_000, instrumentExposureKrw: 0, strategyExposureKrw: 40_000,
      assetClassExposureKrw: 40_000, assetClassCapitalCommittedKrw: 40_000,
      openRiskKrw: 0, openPositionCount: 1, dailyOrderCount: 0, consecutiveLosses: 0,
      currentPrice: 60_000_000, plannedPrice: 60_000_000, estimatedSlippagePercent: 0.05 },
    averageSpreadPercent: 0.05, estimatedSlippagePercent: 0.05, economics: null,
    entryPrice: 60_000_000, entryZoneLow: null, entryZoneHigh: null, stockBroker: null,
    stockExchange: null, signalOccurrenceId: 'natural-signal@1' };
  const decision = evaluateTradingPlan(plan, current,
  { emergencyStopped: false, serverLiveEnabled: true });
  assert.equal(decision.allowed, false);
  assert.ok(decision.blockCodes.includes('MAX_ORDER_AMOUNT'));
  assert.ok(decision.blockCodes.includes('OPERATING_CAPITAL_ALLOCATION_LIMIT'));

  const reducing = evaluateTradingPlan({ ...plan,
    signalId: 'canonical-auto-exit:natural-signal', signalOccurrenceId: 'canonical-auto-exit:natural-signal@1',
    side: 'sell', reduceOnly: true, quoteAmount: null, estimatedKrw: 70_000,
    signalReasons: ['AUTO_POSITION_EXIT', 'CANONICAL_AUTO_POSITION'],
  }, current, { emergencyStopped: true, serverLiveEnabled: true });
  assert.equal(reducing.blockCodes.includes('MAX_ORDER_AMOUNT'), false);
  assert.equal(reducing.blockCodes.includes('OPERATING_CAPITAL_ALLOCATION_LIMIT'), false);
  assert.equal(reducing.blockCodes.includes('EMERGENCY_STOP_ACTIVE'), false);
});

test('futures risk uses allocation as isolated margin and keeps leveraged notional separate', () => {
  const current = policy();
  current.mode = 'automatic'; current.automaticEnabled = true;
  current.exchangeEnabled.bitget = true; current.enabledStrategies = ['TREND_PULLBACK_REACCEL_V1'];
  current.bitgetLeverage = 3;
  current.maxAssetClassKrw.crypto_futures = 500_000;
  current.maxInstrumentKrw = 500_000;
  current.maxAssetPercent = 100;
  current.capitalAllocationByMarket.crypto_futures = {
    ...current.capitalAllocationByMarket.crypto_futures,
    configured: true, operatingCapitalKrw: 100_000, maxOrderKrw: 300_000,
  };
  const now = new Date().toISOString();
  const decision = evaluateTradingPlan({ exchange: 'bitget', accountMode: 'live',
    strategyId: 'TREND_PULLBACK_REACCEL_V1', signalId: 'futures-signal', symbol: 'BTCUSDT', market: 'USDT',
    side: 'long', orderType: 'market', quantity: 0.004, quoteAmount: null, limitPrice: 75_000_000,
    estimatedKrw: 300_000, stopPrice: 72_000_000, targetPrices: [81_000_000], splitRatios: [100],
    leverage: 3, marginMode: 'isolated', reduceOnly: false, invalidateAction: 'close',
    signalReasons: ['PUBLIC_DATA'], marketSnapshot: { observedAt: now, dataDelayMs: 0,
      oneMinuteMovePercent: 0.1, spreadPercent: 0.05, orderbookGapPercent: 0.05, halted: false,
      availableBalance: 500_000, accountValueKrw: 500_000, dailyPnlPercent: 0, assetExposurePercent: 0,
      accountExposureKrw: 0, instrumentExposureKrw: 0, strategyExposureKrw: 0,
      assetClassExposureKrw: 0, assetClassCapitalCommittedKrw: 0, openRiskKrw: 0,
      openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0, currentPrice: 75_000_000,
      plannedPrice: 75_000_000, estimatedSlippagePercent: 0.05 }, averageSpreadPercent: 0.05,
    estimatedSlippagePercent: 0.05, economics: null, entryPrice: 75_000_000,
    entryZoneLow: null, entryZoneHigh: null, stockBroker: null, stockExchange: null,
    signalOccurrenceId: 'futures-signal@1' }, current,
  { emergencyStopped: false, serverLiveEnabled: true });
  assert.equal(decision.blockCodes.includes('ASSET_CLASS_AMOUNT_LIMIT'), false);
  assert.equal(decision.blockCodes.includes('OPERATING_CAPITAL_ALLOCATION_LIMIT'), false);
});
