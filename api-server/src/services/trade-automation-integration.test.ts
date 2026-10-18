import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeAutomationService, tradingIdempotencyKey } from './trade-automation.service';
import { TradeExecutionService, bitgetAcknowledgedOrderId } from './trade-execution.service';
import { setTradingPlanMarketIntelligenceRunnerForTests } from './trade-market-intelligence.service';
import { encryptTradingCredentials, decryptTradingCredentials } from './trade-credential-vault.service';
import {
  buildBitgetSignature, buildUpbitJwt, prepareBitgetLeverage, prepareBitgetOrder, prepareBitgetTicker, prepareKiwoomOrder,
  prepareUpbitOrder, redactPreparedRequest, validateBitgetContractRules,
} from './trade-exchange-adapters.service';
import { evaluateTradingPlan, normalizeTradingPolicy, upbitKrwPriceStep } from './trade-automation-risk.service';
import {
  assetClassOfPlan,
  liveSafetyAlertCodes,
  notifyLiveMarketSwitch,
  notifyLiveSafetyBlock,
} from './live-trading-safety-telegram.service';
import {
  BENCHMARK_DRAWDOWN_LONG_BLOCK_PERCENT,
  benchmarkDrawdownBlocksLong,
  createBtcBenchmarkDrawdownReader,
  drawdownFromPeakPercent,
  isNewCryptoLongEntry,
} from './crypto-benchmark-regime.service';
import { assertOrderTransition, canTransitionOrder } from './trade-order-state-machine.service';
import {
  DEFAULT_TRADING_POLICY,
  PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW,
  type TradingPlanInput,
} from './trade-automation.types';
import { readTradeAutomationJournalPayloads } from './trade-automation-unified-journal-adapter';
import { buildUnifiedTradeJournal } from './unified-trade-journal.service';
import {
  SPOT_LIVE_HARD_DENIED_CAPABILITIES,
  spotLiveCapabilityDecision,
  spotLivePlanCapabilityDecision,
  spotLiveRuntimeStatus,
} from './spot-live-limited-capability.service';

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

test('Bitget stores the actual broker ID, not clientOid, including one-way reducing acknowledgement without ID', () => {
  const ack = { code: '00000', data: { clientOid: 'app-id', orderId: 'exchange-id' } };
  assert.equal(bitgetAcknowledgedOrderId(ack, 'app-id'), 'exchange-id');
  assert.equal(bitgetAcknowledgedOrderId({ code: '00000', data: { clientOid: 'app-id' } }, 'app-id', true), null);
  assert.throws(() => bitgetAcknowledgedOrderId({ code: '00000', data: { clientOid: 'app-id' } }, 'app-id'), /ORDER_ID_MISSING/);
  assert.throws(() => bitgetAcknowledgedOrderId(ack, 'other-app-id'), /INVALID_RESPONSE/);
  assert.throws(() => bitgetAcknowledgedOrderId({ code: '00000', data: [ack.data] }, 'app-id'), /INVALID_RESPONSE/);
});

test('automatic Bitget entries preserve native stop and final target; reducing exits never attach new protection', () => {
  const credentials = { apiKey: 'test-key', secretKey: 'test-secret', passphrase: 'test-pass' };
  const automaticPlan = plan({ exchange: 'bitget', side: 'long', symbol: 'BTCUSDT', orderType: 'market',
    quantity: 0.01, marginMode: 'isolated', leverage: 7, reduceOnly: false,
    signalReasons: ['CANONICAL_LIVE_AUTO_HANDOFF'],
    entryPrice: 100, stopPrice: 95, targetPrices: [103.5, 105], marketSnapshot: { ...plan().marketSnapshot, currentPrice: 100 },
  });
  const body = JSON.parse(prepareBitgetOrder(credentials, automaticPlan, 'mock-only', '1000').body!);
  assert.equal(body.presetStopLossPrice, '95');
  assert.equal(body.presetStopSurplusPrice, '105');
  const short = JSON.parse(prepareBitgetOrder(credentials, { ...automaticPlan, side: 'short',
    stopPrice: 105, targetPrices: [96.5, 95] }, 'mock-short', '1000').body!);
  assert.equal(short.presetStopLossPrice, '105');
  assert.equal(short.presetStopSurplusPrice, '95');
  const exit = JSON.parse(prepareBitgetOrder(credentials, { ...automaticPlan, reduceOnly: true }, 'mock-exit', '1000').body!);
  assert.equal(exit.reduceOnly, 'YES');
  assert.equal('presetStopLossPrice' in exit, false);
  assert.throws(() => prepareBitgetOrder(credentials, { ...automaticPlan, stopPrice: 110 }, 'bad', '1000'),
    /NATIVE_PROTECTION_INVALID/);
  assert.throws(() => prepareBitgetOrder(credentials, { ...automaticPlan, targetPrices: [] }, 'bad', '1000'),
    /NATIVE_PROTECTION_INVALID/);
});
test('Bitget native-protection validation covers mode-only and marker-only automatic entries', () => {
  const credentials = { apiKey: 'test-key', secretKey: 'test-secret', passphrase: 'test-pass' };
  const input = plan({ exchange: 'bitget', side: 'long', symbol: 'BTCUSDT', orderType: 'market',
    quantity: 0.01, marginMode: 'isolated', leverage: 7, reduceOnly: false,
    signalReasons: [], entryPrice: 100, stopPrice: 95, targetPrices: [103.5, 105],
    marketSnapshot: { ...plan().marketSnapshot, currentPrice: 100 },
  });
  const contract = { pricePlace: '1', priceEndStep: '5', minTradeNum: '0.01', sizeMultiplier: '0.01' };
  for (const automaticPlan of [
    { ...input, executionMode: 'automatic' as const },
    { ...input, signalReasons: ['CANONICAL_LIVE_AUTO_HANDOFF'] },
    { ...input, executionMode: 'automatic' as const, signalReasons: ['CANONICAL_LIVE_AUTO_HANDOFF'] },
  ]) {
    assert.doesNotThrow(() => validateBitgetContractRules(automaticPlan, contract, 100));
    for (const invalid of [
      { ...automaticPlan, stopPrice: 95.1 },
      { ...automaticPlan, targetPrices: [103.5, 105.1] },
    ]) {
      assert.throws(() => validateBitgetContractRules(invalid, contract, 100), /AUTOMATIC_PROTECTION_PRICE_STEP/);
    }
    assert.throws(() => validateBitgetContractRules({ ...automaticPlan, stopPrice: 105 }, contract, 100),
      /AUTOMATIC_NATIVE_PROTECTION_INVALID/);
    assert.throws(() => validateBitgetContractRules({ ...automaticPlan, targetPrices: [] }, contract, 100),
      /AUTOMATIC_NATIVE_PROTECTION_INVALID/);
    const body = JSON.parse(prepareBitgetOrder(credentials, automaticPlan, 'mock-only', '1000').body!);
    assert.equal(body.presetStopLossPrice, '95');
    assert.equal(body.presetStopSurplusPrice, '105');
    const short = { ...automaticPlan, side: 'short' as const, stopPrice: 105, targetPrices: [96.5, 95] };
    assert.doesNotThrow(() => validateBitgetContractRules(short, contract, 100));
    assert.throws(() => validateBitgetContractRules({ ...short, stopPrice: 105.1 }, contract, 100),
      /AUTOMATIC_PROTECTION_PRICE_STEP/);
    assert.throws(() => validateBitgetContractRules({ ...short, stopPrice: 95 }, contract, 100),
      /AUTOMATIC_NATIVE_PROTECTION_INVALID/);
    const shortBody = JSON.parse(prepareBitgetOrder(credentials, short, 'mock-short', '1000').body!);
    assert.equal(shortBody.presetStopLossPrice, '105');
    assert.equal(shortBody.presetStopSurplusPrice, '95');
    const reducing = { ...automaticPlan, reduceOnly: true, stopPrice: 95.1, targetPrices: [105.1] };
    assert.doesNotThrow(() => validateBitgetContractRules(reducing, contract, 100));
    const exit = JSON.parse(prepareBitgetOrder(credentials, reducing, 'mock-exit', '1000').body!);
    assert.equal('presetStopLossPrice' in exit, false);
    assert.equal('presetStopSurplusPrice' in exit, false);
  }
  const manual = { ...input, stopPrice: 95.1, targetPrices: [105.1] };
  assert.doesNotThrow(() => validateBitgetContractRules(manual, contract, 100));
  const body = JSON.parse(prepareBitgetOrder(credentials, manual, 'mock-manual', '1000').body!);
  assert.equal('presetStopLossPrice' in body, false);
  assert.equal('presetStopSurplusPrice' in body, false);
});
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const SPOT_LIVE_TEST_KEYS = [
  'SPOT_LIVE_LIMITED_ACTIVATION_APPROVED',
  'SPOT_LIVE_CAPABILITY_ALLOWLIST',
  'SPOT_LIVE_MARKET_ALLOWLIST',
] as const;

function spotLiveEnvironmentSnapshot() {
  return Object.fromEntries(SPOT_LIVE_TEST_KEYS.map((key) => [key, process.env[key]]));
}

function enableSpotLiveTestEnvironment() {
  process.env.SPOT_LIVE_LIMITED_ACTIVATION_APPROVED = 'true';
  process.env.SPOT_LIVE_CAPABILITY_ALLOWLIST = 'BALANCE_READ,POSITION_READ,OPEN_ORDER_READ,ORDER_CREATE,ORDER_CANCEL,ORDER_AMEND';
  process.env.SPOT_LIVE_MARKET_ALLOWLIST = 'KR_STOCK,US_STOCK,CRYPTO_SPOT';
  process.env.executionAuthority = 'SPOT_LIVE_LIMITED';
}

function spotLiveCapabilityEnvironment(overrides: Record<string, string> = {}) {
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

function plan(overrides: Partial<TradingPlanInput> = {}): TradingPlanInput {
  const observedAt = new Date().toISOString();
  return {
    exchange: 'upbit', accountMode: 'paper', strategyId: 'breakout-v1', signalId: 'signal-1',
    symbol: 'BTC', market: 'KRW', side: 'buy', orderType: 'market', quantity: null,
    quoteAmount: 100_000, limitPrice: null, estimatedKrw: 100_000, stopPrice: 90_000,
    targetPrices: [110_000], splitRatios: [100], leverage: null, marginMode: null,
    reduceOnly: false, invalidateAction: 'hold', signalReasons: ['trend', 'volume'],
    marketSnapshot: {
      observedAt, riskObservedAt: observedAt, dataDelayMs: 0, oneMinuteMovePercent: 0.5,
      spreadPercent: 0.1, orderbookGapPercent: 0.2, halted: false, availableBalance: 1_000_000,
      accountValueKrw: 5_000_000, dailyPnlPercent: 0, assetExposurePercent: 5,
      openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0,
      currentPrice: 100_000, plannedPrice: 100_000, marketStatus: 'OPEN',
      availableLiquidityKrw: 1_000_000, estimatedSlippagePercent: 0.1, estimatedFeePercent: 0.05,
      correlatedExposurePercent: 0, signalState: 'entry_ready', signalObservedAt: observedAt,
    },
    ...overrides,
  };
}

test('automatic trading and every exchange default to OFF', () => {
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  assert.equal(policy.mode, 'approval');
  assert.equal(policy.automaticEnabled, false);
  assert.equal(policy.emergencyStopped, false);
  assert.deepEqual(policy.exchangeEnabled, { bitget: false, upbit: false, kiwoom: false, toss: false });
  assert.deepEqual(policy.enabledAssets, { bitget: [], upbit: [], kiwoom: [], toss: [] });
  assert.equal(policy.bitgetLeverage, 2);
  assert.equal(policy.totalCapitalKrw, 1_000_000);
  assert.equal(policy.maxOrderKrw, 500_000);
});

test('member entry is capped at 500k while administrator entry accepts 1M and both fail closed above tier', () => {
  const memberPolicy = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    totalCapitalKrw: 5_000_000,
    maxOrderKrw: 5_000_000,
  });
  assert.equal(memberPolicy.maxOrderKrw, 500_000);
  assert.equal(evaluateTradingPlan(plan({
    quoteAmount: 500_000,
    estimatedKrw: 500_000,
  }), memberPolicy, { emergencyStopped: false, serverLiveEnabled: false })
    .blockCodes.includes('MAX_ORDER_AMOUNT'), false);
  assert.ok(evaluateTradingPlan(plan({
    quoteAmount: 500_001,
    estimatedKrw: 500_001,
  }), memberPolicy, { emergencyStopped: false, serverLiveEnabled: false })
    .blockCodes.includes('MAX_ORDER_AMOUNT'));

  const administratorPolicy = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    totalCapitalKrw: 5_000_000,
    maxOrderKrw: 5_000_000,
  }, PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW);
  assert.equal(administratorPolicy.maxOrderKrw, 1_000_000);

  const exact = evaluateTradingPlan(plan({
    quoteAmount: 1_000_000,
    estimatedKrw: 1_000_000,
  }), administratorPolicy, { emergencyStopped: false, serverLiveEnabled: false });
  assert.equal(exact.blockCodes.includes('MAX_ORDER_AMOUNT'), false);

  const exceeded = evaluateTradingPlan(plan({
    quoteAmount: 1_000_001,
    estimatedKrw: 1_000_001,
  }), administratorPolicy, { emergencyStopped: false, serverLiveEnabled: false });
  assert.ok(exceeded.blockCodes.includes('MAX_ORDER_AMOUNT'));
});

test('spot live create is capability allowlisted and exact-authority bound', () => {
  assert.equal(
    spotLivePlanCapabilityDecision(plan(), 'ORDER_CREATE', spotLiveCapabilityEnvironment()).allowed,
    true,
  );

  const legacy = spotLivePlanCapabilityDecision(
    plan(),
    'ORDER_CREATE',
    spotLiveCapabilityEnvironment({ executionAuthority: 'AUTOMATIC' }),
  );
  assert.equal(legacy.allowed, false);
  assert.ok(legacy.blockCodes.includes('SPOT_LIVE_EXECUTION_AUTHORITY_MISMATCH'));

  const missingRead = spotLivePlanCapabilityDecision(
    plan(),
    'ORDER_CREATE',
    spotLiveCapabilityEnvironment({ SPOT_LIVE_CAPABILITY_ALLOWLIST: 'ORDER_CREATE' }),
  );
  assert.equal(missingRead.allowed, false);
  assert.ok(missingRead.blockCodes.includes('SPOT_LIVE_CAPABILITY_MISSING_BALANCE_READ'));
  assert.ok(missingRead.blockCodes.includes('SPOT_LIVE_CAPABILITY_MISSING_POSITION_READ'));
  assert.ok(missingRead.blockCodes.includes('SPOT_LIVE_CAPABILITY_MISSING_OPEN_ORDER_READ'));
});

test('spot live permanently rejects futures, margin, short, leverage, and denied capabilities', () => {
  const futures = spotLivePlanCapabilityDecision(
    plan({ exchange: 'bitget', market: 'USDT', side: 'long', leverage: 2, marginMode: 'crossed' }),
    'ORDER_CREATE',
    spotLiveCapabilityEnvironment({ BITGET_LIVE_ORDER_ENABLED: 'true' }),
  );
  assert.equal(futures.allowed, false);
  for (const code of [
    'FUTURES_HARD_DISABLED',
    'SHORT_HARD_DISABLED',
    'LEVERAGE_HARD_DISABLED',
    'MARGIN_HARD_DISABLED',
  ]) {
    assert.ok(futures.blockCodes.includes(code), `missing blocker ${code}`);
  }

  const denied = spotLiveCapabilityDecision({
    exchange: 'upbit',
    capability: 'ORDER_CREATE',
    environment: spotLiveCapabilityEnvironment({
      SPOT_LIVE_CAPABILITY_ALLOWLIST:
        'BALANCE_READ,POSITION_READ,OPEN_ORDER_READ,ORDER_CREATE,WITHDRAW',
    }),
  });
  assert.equal(denied.allowed, false);
  assert.ok(denied.blockCodes.includes('SPOT_LIVE_DENIED_CAPABILITY_REQUESTED'));
});

test('spot live supports KR and US through Toss or Kiwoom, and Upbit spot only', () => {
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
      spotLivePlanCapabilityDecision(
        plan(overrides),
        'ORDER_CREATE',
        spotLiveCapabilityEnvironment(),
      ).allowed,
      expected,
      JSON.stringify(overrides),
    );
  }
});

test('crypto spot allows cancel but never amend', () => {
  assert.equal(
    spotLivePlanCapabilityDecision(plan(), 'ORDER_CANCEL', spotLiveCapabilityEnvironment()).allowed,
    true,
  );
  const amend = spotLivePlanCapabilityDecision(
    plan(),
    'ORDER_AMEND',
    spotLiveCapabilityEnvironment(),
  );
  assert.equal(amend.allowed, false);
  assert.ok(amend.blockCodes.includes('SPOT_LIVE_PROVIDER_CAPABILITY_UNSUPPORTED_ORDER_AMEND'));
  assert.ok(amend.blockCodes.includes('CRYPTO_SPOT_AMEND_HARD_DISABLED'));
});

test('spot live runtime status publishes every permanent deny as false', () => {
  const status = spotLiveRuntimeStatus(spotLiveCapabilityEnvironment());
  assert.equal(status.executionAuthority, 'SPOT_LIVE_LIMITED');
  assert.equal(status.providerCapabilities.bitget.ORDER_CREATE, false);
  assert.equal(status.providerCapabilities.upbit.ORDER_CREATE, true);
  for (const capability of SPOT_LIVE_HARD_DENIED_CAPABILITIES) {
    assert.equal(status.hardDeniedCapabilities[capability], false);
  }
});

test('stock broker selection is per market, backward compatible, and enforced for automatic stock Paper plans', () => {
  const legacy = normalizeTradingPolicy({ ...DEFAULT_TRADING_POLICY, stockBrokerByMarket: undefined });
  assert.deepEqual(legacy.stockBrokerByMarket, { domestic_stock: 'kiwoom', us_stock: 'kiwoom' });

  const legacyUsToss = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    stockBrokerByMarket: { domestic_stock: 'toss', us_stock: 'toss' },
  });
  assert.deepEqual(legacyUsToss.stockBrokerByMarket, { domestic_stock: 'toss', us_stock: 'toss' });
  const invalidUsBroker = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    stockBrokerByMarket: { domestic_stock: 'kiwoom', us_stock: 'unknown' as 'kiwoom' },
  });
  assert.equal(invalidUsBroker.stockBrokerByMarket?.us_stock, 'kiwoom');

  const policy = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    mode: 'automatic',
    automaticEnabled: true,
    marketEnabled: { domestic_stock: true, us_stock: true, crypto_spot: true, crypto_futures: true },
    stockBrokerByMarket: { domestic_stock: 'toss', us_stock: 'kiwoom' },
    exchangeEnabled: { bitget: true, upbit: true, kiwoom: true, toss: true },
  });

  const domesticToss = evaluateTradingPlan(
    plan({
      exchange: 'toss',
      stockBroker: 'toss',
      accountMode: 'paper',
      market: 'KR',
      symbol: '005930',
      side: 'buy',
      quantity: 1,
      quoteAmount: null,
    }),
    policy,
    { emergencyStopped: false, serverLiveEnabled: true },
  );
  assert.equal(domesticToss.blockCodes.includes('STOCK_BROKER_MISMATCH'), false);

  const domesticWrongBroker = evaluateTradingPlan(
    plan({
      exchange: 'kiwoom',
      stockBroker: 'kiwoom',
      accountMode: 'paper',
      market: 'KR',
      symbol: '005930',
      side: 'buy',
      quantity: 1,
      quoteAmount: null,
    }),
    policy,
    { emergencyStopped: false, serverLiveEnabled: true },
  );
  assert.ok(domesticWrongBroker.blockCodes.includes('STOCK_BROKER_MISMATCH'));

  const usKiwoom = evaluateTradingPlan(
    plan({
      exchange: 'kiwoom',
      stockBroker: 'kiwoom',
      stockExchange: 'NASDAQ',
      accountMode: 'paper',
      market: 'US',
      symbol: 'AAPL',
      side: 'buy',
      quantity: 1,
      quoteAmount: null,
    }),
    policy,
    { emergencyStopped: false, serverLiveEnabled: true },
  );
  assert.equal(usKiwoom.blockCodes.includes('STOCK_BROKER_MISMATCH'), false);

  const usTossPolicy = normalizeTradingPolicy({
    ...policy,
    stockBrokerByMarket: { domestic_stock: 'toss', us_stock: 'toss' },
  });
  const usToss = evaluateTradingPlan(
    plan({
      exchange: 'toss',
      stockBroker: 'toss',
      accountMode: 'paper',
      market: 'US',
      symbol: 'AAPL',
      side: 'buy',
      quantity: 1,
      quoteAmount: null,
    }),
    usTossPolicy,
    { emergencyStopped: false, serverLiveEnabled: true },
  );
  assert.equal(usToss.blockCodes.includes('STOCK_BROKER_MISMATCH'), false);
  const usKiwoomWhileTossSelected = evaluateTradingPlan(
    plan({
      exchange: 'kiwoom',
      stockBroker: 'kiwoom',
      stockExchange: 'NASDAQ',
      accountMode: 'paper',
      market: 'US',
      symbol: 'AAPL',
      side: 'buy',
      quantity: 1,
      quoteAmount: null,
    }),
    usTossPolicy,
    { emergencyStopped: false, serverLiveEnabled: true },
  );
  assert.ok(usKiwoomWhileTossSelected.blockCodes.includes('STOCK_BROKER_MISMATCH'));
});

test('automatic policy fields restrict eligibility and standing activation removes per-order approval', async () => {
  const automatic = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    mode: 'automatic',
    automaticEnabled: true,
    marketEnabled: { domestic_stock: true, us_stock: true, crypto_spot: true, crypto_futures: true },
    exchangeEnabled: { bitget: false, upbit: true, kiwoom: false, toss: false },
    enabledAssets: { bitget: [], upbit: ['ETH'], kiwoom: [], toss: [] },
    enabledStrategies: ['breakout-v1'],
  });
  const blocked = evaluateTradingPlan(plan(), automatic, { emergencyStopped: false, serverLiveEnabled: true });
  assert.ok(blocked.blockCodes.includes('ASSET_NOT_ENABLED'));
  const allowedPolicy = { ...automatic, enabledAssets: { ...automatic.enabledAssets, upbit: ['BTC'] } };
  const allowed = evaluateTradingPlan(plan(), allowedPolicy, { emergencyStopped: false, serverLiveEnabled: true });
  assert.equal(allowed.allowed, true);

  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER_A, allowedPolicy);
  const service = new TradeAutomationService(repository);
  const created = await service.createPlan(USER_A, plan({ signalId: 'automatic-standing-authorization' }), allowedPolicy, false);
  assert.equal(created.plan?.state, 'APPROVAL_PENDING');

  const submitted = await service.beginAutomaticPlan(USER_A, created.plan!.id);
  assert.equal(submitted.state, 'SUBMITTED');
  assert.ok(submitted.approvedAt);
  assert.ok((submitted as TradingPlanInput & { riskEnvelope?: unknown }).riskEnvelope);
  assert.equal(await repository.findOrderByPlan(USER_A, created.plan!.id), null);
});
test('risk engine blocks emergency, stale/volatile markets, loss limits, and insufficient balance', () => {
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const decision = evaluateTradingPlan(plan({
    marketSnapshot: { ...plan().marketSnapshot, dataDelayMs: 6_000, oneMinuteMovePercent: -7,
      spreadPercent: 2, orderbookGapPercent: 3, availableBalance: 100, dailyPnlPercent: -5 },
  }), policy, { emergencyStopped: true, serverLiveEnabled: false });
  for (const code of ['EMERGENCY_STOP_ACTIVE', 'MARKET_DATA_DELAYED', 'FAST_MOVE_DETECTED', 'ONE_MINUTE_VOLATILITY',
    'SPREAD_TOO_WIDE', 'ORDERBOOK_GAP', 'DAILY_LOSS_LIMIT', 'INSUFFICIENT_BALANCE']) {
    assert.ok(decision.blockCodes.includes(code), code);
  }
});

test('zero daily order quota stays opportunity-driven while an explicit positive quota remains fail-closed', () => {
  const opportunityDriven = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    maxDailyOrders: 0,
  });
  const afterManyValidOpportunities = evaluateTradingPlan(plan({
    marketSnapshot: { ...plan().marketSnapshot, dailyOrderCount: 500 },
  }), opportunityDriven, { emergencyStopped: false, serverLiveEnabled: true });
  assert.equal(afterManyValidOpportunities.blockCodes.includes('DAILY_ORDER_LIMIT'), false);

  const explicitlyBounded = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    maxDailyOrders: 10,
  });
  const bounded = evaluateTradingPlan(plan({
    marketSnapshot: { ...plan().marketSnapshot, dailyOrderCount: 10 },
  }), explicitlyBounded, { emergencyStopped: false, serverLiveEnabled: true });
  assert.ok(bounded.blockCodes.includes('DAILY_ORDER_LIMIT'));
});

test('validated signal occurrences are idempotent within one event and allow a later repeat opportunity', () => {
  const first = plan({ signalId: 'stable-scanner-signal', signalOccurrenceId: 'stable-scanner-signal@1000' });
  const replay = { ...first };
  const later = { ...first, signalOccurrenceId: 'stable-scanner-signal@2000' };
  assert.equal(tradingIdempotencyKey(USER_A, first), tradingIdempotencyKey(USER_A, replay));
  assert.notEqual(tradingIdempotencyKey(USER_A, first), tradingIdempotencyKey(USER_A, later));
  assert.equal(first.signalId, later.signalId, 'the scanner strategy identity remains stable');
});

test('Bitget caps members at 3x, preserves administrator 2x-7x, and keeps risk checks explicit', () => {
  for (const leverage of [2, 3] as const) {
    assert.equal(
      normalizeTradingPolicy({ ...DEFAULT_TRADING_POLICY, bitgetLeverage: leverage }).bitgetLeverage,
      leverage,
    );
  }
  for (const leverage of [4, 5, 6, 7] as const) {
    assert.equal(
      normalizeTradingPolicy({ ...DEFAULT_TRADING_POLICY, bitgetLeverage: leverage }).bitgetLeverage,
      3,
    );
    assert.equal(
      normalizeTradingPolicy(
        { ...DEFAULT_TRADING_POLICY, bitgetLeverage: leverage },
        PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW,
      ).bitgetLeverage,
      leverage,
    );
  }
  assert.throws(
    () => normalizeTradingPolicy({ ...DEFAULT_TRADING_POLICY, bitgetLeverage: 8 as 7 }),
    /BITGET_LEVERAGE_POLICY_INVALID/,
  );
  assert.throws(
    () => normalizeTradingPolicy({ ...DEFAULT_TRADING_POLICY, bitgetLeverage: 1 as 2 }),
    /BITGET_LEVERAGE_POLICY_INVALID/,
  );
  const policy = normalizeTradingPolicy(
    { ...DEFAULT_TRADING_POLICY, bitgetLeverage: 7 },
    PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW,
  );
  const input = plan({ exchange: 'bitget', market: 'USDT-FUTURES', side: 'short', quantity: 0.01,
    quoteAmount: null, estimatedKrw: 100_000, leverage: 8, marginMode: 'isolated',
    marketSnapshot: { ...plan().marketSnapshot, existingPositionSide: 'long' } });
  const decision = evaluateTradingPlan(input, policy, { emergencyStopped: false, serverLiveEnabled: true });
  assert.ok(decision.blockCodes.includes('BITGET_LEVERAGE_LIMIT'));
  assert.ok(decision.blockCodes.includes('BITGET_OPPOSITE_POSITION_DUPLICATE'));
  const maxAllowed = evaluateTradingPlan({ ...input, leverage: 7,
    marketSnapshot: { ...input.marketSnapshot, existingPositionSide: null } },
  policy, { emergencyStopped: false, serverLiveEnabled: true });
  assert.equal(maxAllowed.blockCodes.includes('BITGET_LEVERAGE_LIMIT'), false);
  assert.equal(maxAllowed.blockCodes.includes('BITGET_LEVERAGE_POLICY_LIMIT'), false);
  const memberPolicyLimit = evaluateTradingPlan({ ...input, leverage: 7,
    marketSnapshot: { ...input.marketSnapshot, existingPositionSide: null } },
  normalizeTradingPolicy({ ...DEFAULT_TRADING_POLICY, bitgetLeverage: 3 }),
  { emergencyStopped: false, serverLiveEnabled: true });
  assert.ok(memberPolicyLimit.blockCodes.includes('BITGET_LEVERAGE_POLICY_LIMIT'));
  const liquidationRisk = evaluateTradingPlan({ ...input, leverage: 3,
    marketSnapshot: { ...input.marketSnapshot, existingPositionSide: null, liquidationDistancePercent: 4 } },
  policy, { emergencyStopped: false, serverLiveEnabled: true });
  assert.ok(liquidationRisk.blockCodes.includes('BITGET_LIQUIDATION_RISK'));
  const crossedMargin = evaluateTradingPlan({ ...input, leverage: 3, marginMode: 'crossed',
    marketSnapshot: { ...input.marketSnapshot, existingPositionSide: null } },
  policy, { emergencyStopped: false, serverLiveEnabled: true });
  assert.ok(crossedMargin.blockCodes.includes('BITGET_ISOLATED_MARGIN_REQUIRED'));
  const isolatedMargin = evaluateTradingPlan({ ...input, leverage: 3, marginMode: 'isolated',
    marketSnapshot: { ...input.marketSnapshot, existingPositionSide: null } },
  policy, { emergencyStopped: false, serverLiveEnabled: true });
  assert.equal(isolatedMargin.blockCodes.includes('BITGET_ISOLATED_MARGIN_REQUIRED'), false);
  const request = prepareBitgetOrder({ apiKey: 'key', secretKey: 'secret', passphrase: 'pass' }, { ...input, leverage: 3 }, 'client-1', '1000');
  assert.match(request.body ?? '', /"reduceOnly":"NO"/);
  assert.doesNotThrow(() => validateBitgetContractRules({ ...input, quantity: 0.02, leverage: 3 }, {
    minTradeNum: '0.01', sizeMultiplier: '0.01', pricePlace: '1', priceEndStep: '1',
  }));
  assert.throws(() => validateBitgetContractRules({ ...input, quantity: 0.015, leverage: 3 }, {
    minTradeNum: '0.01', sizeMultiplier: '0.01', pricePlace: '1', priceEndStep: '1',
  }), /BITGET_QUANTITY_STEP/);
  assert.throws(() => validateBitgetContractRules({ ...input, quantity: 0.01, leverage: 3 }, {
    minTradeNum: '0.01', minTradeUSDT: '10', sizeMultiplier: '0.01', symbolStatus: 'normal',
  }, 500), /BITGET_MINIMUM_NOTIONAL/);
  const ticker = prepareBitgetTicker('BTCUSDT');
  assert.equal(ticker.path, '/api/v2/mix/market/ticker');
  assert.equal(Object.keys(ticker.headers).some((key) => key.startsWith('ACCESS-')), false);
  for (const leverage of [2, 3, 4, 5, 6, 7] as const) {
    const prepared = prepareBitgetLeverage(
      { apiKey: 'key', secretKey: 'secret', passphrase: 'pass' },
      'BTCUSDT',
      leverage,
      '1000',
    );
    assert.equal(prepared.path, '/api/v2/mix/account/set-leverage');
    assert.equal(JSON.parse(prepared.body ?? '{}').leverage, String(leverage));
  }
});

test('Upbit enforces KRW spot, no short, 5,000 KRW minimum, and market buy/sell units', () => {
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const blocked = evaluateTradingPlan(plan({ side: 'short', estimatedKrw: 4_999 }), policy,
    { emergencyStopped: false, serverLiveEnabled: true });
  assert.ok(blocked.blockCodes.includes('UPBIT_SPOT_ONLY'));
  assert.ok(blocked.blockCodes.includes('UPBIT_MINIMUM_ORDER'));
  assert.equal(upbitKrwPriceStep(700_000), 500);
  const buy = prepareUpbitOrder({ accessKey: 'access', secretKey: 'secret' }, plan(), 'buy-1', 'nonce-1');
  assert.match(buy.body ?? '', /"ord_type":"price"/);
  assert.match(buy.body ?? '', /"price":"100000"/);
  assert.doesNotMatch(buy.body ?? '', /"volume"/);
  const sell = prepareUpbitOrder({ accessKey: 'access', secretKey: 'secret' },
    plan({ side: 'sell', quantity: 0.01, quoteAmount: null }), 'sell-1', 'nonce-2');
  assert.match(sell.body ?? '', /"ord_type":"market"/);
  assert.match(sell.body ?? '', /"volume":"0.01"/);
});

test('Kiwoom US stock requires an explicit supported exchange venue while KR order contracts stay intact', () => {
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);

  const missingVenue = evaluateTradingPlan(
    plan({ exchange: 'kiwoom', accountMode: 'paper', market: 'US', symbol: 'AAPL', side: 'buy', quantity: 1 }),
    policy,
    { emergencyStopped: false, serverLiveEnabled: true },
  );
  assert.ok(missingVenue.blockCodes.includes('KIWOOM_US_EXCHANGE_REQUIRED'));

  const paperUs = evaluateTradingPlan(
    plan({
      exchange: 'kiwoom',
      accountMode: 'paper',
      market: 'US',
      stockExchange: 'NASDAQ',
      symbol: 'AAPL',
      side: 'buy',
      quantity: 1,
    }),
    policy,
    { emergencyStopped: false, serverLiveEnabled: true },
  );
  assert.equal(paperUs.blockCodes.includes('STOCK_MARKET_NOT_SUPPORTED'), false);
  assert.equal(paperUs.blockCodes.includes('KIWOOM_US_EXCHANGE_REQUIRED'), false);

  const request = prepareKiwoomOrder({ appKey: 'app', secretKey: 'secret', accessToken: 'token' },
    plan({ exchange: 'kiwoom', accountMode: 'mock', market: 'KR', symbol: '005930', side: 'buy', quantity: 2, quoteAmount: null }));
  assert.equal(request.headers['api-id'], 'kt10000');
  assert.match(request.body ?? '', /"stk_cd":"005930"/);
});
test('official signature formats are deterministic and secret headers redact completely', () => {
  const message = '1000POST/api/v2/mix/order/place-order{"a":1}';
  assert.equal(buildBitgetSignature('secret', '1000', 'POST', '/api/v2/mix/order/place-order', '', '{"a":1}'),
    createHmac('sha256', 'secret').update(message).digest('base64'));
  const jwt = buildUpbitJwt({ accessKey: 'access', secretKey: 'secret' }, 'market=KRW-BTC', 'nonce');
  assert.equal(jwt.split('.').length, 3);
  const redacted = redactPreparedRequest(prepareBitgetOrder({ apiKey: 'api-value', secretKey: 'secret-value', passphrase: 'pass-value' },
    plan({ exchange: 'bitget', market: 'USDT-FUTURES', side: 'long', quantity: 0.01, leverage: 2, marginMode: 'isolated' }), 'client', '1000'));
  assert.doesNotMatch(JSON.stringify(redacted), /api-value|secret-value|pass-value/);
});

test('credential vault round-trips with AES-GCM and never returns plaintext in status shapes', () => {
  const encrypted = encryptTradingCredentials({ apiKey: 'member-a-key', secretKey: 'member-a-secret' }, MASTER_KEY);
  assert.doesNotMatch(encrypted, /member-a-key|member-a-secret/);
  assert.deepEqual(decryptTradingCredentials(encrypted, MASTER_KEY), { apiKey: 'member-a-key', secretKey: 'member-a-secret' });
  assert.throws(() => decryptTradingCredentials(encrypted, Buffer.alloc(32, 8).toString('base64')));
});

test('state machine supports partial fill/cancel/recovery and rejects unsafe transitions', () => {
  assert.equal(canTransitionOrder('ACCEPTED', 'PARTIALLY_FILLED'), true);
  assert.equal(canTransitionOrder('PARTIALLY_FILLED', 'CANCEL_REQUESTED'), true);
  assert.equal(canTransitionOrder('CANCEL_REQUESTED', 'RECOVERY_REQUIRED'), true);
  assert.throws(() => assertOrderTransition('FILLED', 'SUBMITTED'), /INVALID_ORDER_STATE_TRANSITION/);
});

test('same signal is idempotent, approval is mandatory, and members cannot read each other', async () => {
  const repository = new InMemoryTradingRepository();
  const service = new TradeAutomationService(repository);
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const first = await service.createPlan(USER_A, plan(), policy, false);
  const second = await service.createPlan(USER_A, plan(), policy, false);
  assert.equal(first.plan?.id, second.plan?.id);
  assert.equal(second.duplicate, true);
  assert.equal(await repository.getPlan(USER_B, first.plan!.id), null);
  assert.equal(first.plan?.state, 'APPROVAL_PENDING');
  await assert.rejects(() => service.beginAutomaticPlan(USER_A, first.plan!.id), /USER_APPROVAL_REQUIRED/);
  const approved = await service.approvePlan(USER_A, first.plan!.id);
  assert.equal((approved as TradingPlanInput & { riskEnvelope?: unknown }).riskEnvelope != null, true);
  const created = await service.createOrder(USER_A, approved);
  assert.equal(created.order.state, 'SUBMITTED');
  const duplicateOrder = await service.createOrder(USER_A, approved);
  assert.equal(duplicateOrder.duplicate, true);
});

test('approval rechecks signal freshness and expires stale plans before order creation', async () => {
  const repository = new InMemoryTradingRepository();
  const service = new TradeAutomationService(repository);
  const created = await service.createPlan(USER_A, plan({ signalId: 'stale-at-approval' }),
    normalizeTradingPolicy(DEFAULT_TRADING_POLICY), false);
  created.plan!.marketSnapshot.observedAt = new Date(Date.now() - 60_000).toISOString();
  await repository.savePlan(created.plan!);
  await assert.rejects(() => service.approvePlan(USER_A, created.plan!.id), /TRADE_PLAN_RISK_RECHECK_FAILED/);
  assert.equal((await repository.getPlan(USER_A, created.plan!.id))?.state, 'EXPIRED');
  assert.equal(await repository.findOrderByPlan(USER_A, created.plan!.id), null);
});

test('automatic live plans require separate global automatic-live authority', async () => {
  const previous = {
    ...spotLiveEnvironmentSnapshot(),
    ORDER_EXECUTION_ENABLED: process.env.ORDER_EXECUTION_ENABLED,
    LIVE_TRADING_ACTIVATION_APPROVED: process.env.LIVE_TRADING_ACTIVATION_APPROVED,
    REAL_ORDER_ENABLED: process.env.REAL_ORDER_ENABLED,
    PRIVATE_TRADING_API_ALLOWED: process.env.PRIVATE_TRADING_API_ALLOWED,
    UPBIT_LIVE_ORDER_ENABLED: process.env.UPBIT_LIVE_ORDER_ENABLED,
    LIVE_AUTOMATIC_TRADING_ENABLED: process.env.LIVE_AUTOMATIC_TRADING_ENABLED,
    LIVE_TRADING: process.env.LIVE_TRADING,
    AUTO_TRADING: process.env.AUTO_TRADING,
    executionAuthority: process.env.executionAuthority,
  };
  try {
    setTradingPlanMarketIntelligenceRunnerForTests(async () => ({
      status: 'READY',
      warnings: [],
      autoTrading: {
        mode: 'ELIGIBLE_FOR_PARENT_GATE',
        orderAllowed: false,
        evidenceReady: true,
        parentEligibilityReady: true,
        hardBlockReason: null,
      },
    } as any));
    process.env.ORDER_EXECUTION_ENABLED = 'true';
    process.env.LIVE_TRADING_ACTIVATION_APPROVED = 'true';
    process.env.REAL_ORDER_ENABLED = 'true';
    process.env.PRIVATE_TRADING_API_ALLOWED = 'true';
    process.env.UPBIT_LIVE_ORDER_ENABLED = 'true';
    process.env.LIVE_TRADING = 'true';
    process.env.AUTO_TRADING = 'true';
    process.env.LIVE_AUTOMATIC_TRADING_ENABLED = 'false';
    enableSpotLiveTestEnvironment();

    const repository = new InMemoryTradingRepository();
    const service = new TradeAutomationService(repository);
    const policy = normalizeTradingPolicy({
      ...DEFAULT_TRADING_POLICY,
      mode: 'automatic',
      automaticEnabled: true,
      marketEnabled: { domestic_stock: false, us_stock: false, crypto_spot: true, crypto_futures: false },
      exchangeEnabled: { bitget: false, upbit: true, kiwoom: false, toss: false },
      enabledAssets: { bitget: [], upbit: ['BTC'], kiwoom: [], toss: [] },
      enabledStrategies: ['breakout-v1'],
    });

    const blocked = await service.createPlan(
      USER_A,
      plan({ accountMode: 'live', signalId: 'auto-live-global-gate-off' }),
      policy,
      false,
    );
    assert.equal(blocked.plan, null);
    assert.ok(blocked.decision.blockCodes.includes('LIVE_EXECUTION_DISABLED'));

    process.env.LIVE_AUTOMATIC_TRADING_ENABLED = 'true';
    const authorizedGate = await service.createPlan(
      USER_A,
      plan({ accountMode: 'live', signalId: 'auto-live-global-gate-on' }),
      policy,
      false,
    );
    assert.equal(authorizedGate.decision.blockCodes.includes('LIVE_EXECUTION_DISABLED'), false);
    assert.equal(authorizedGate.plan, null);
    assert.ok(authorizedGate.decision.blockCodes.includes('SERVER_PROFITABILITY_ATTESTATION_REQUIRED'));
  } finally {
    setTradingPlanMarketIntelligenceRunnerForTests(null);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('persistent global emergency stop blocks new work and standing automatic resumes only after stop clears', async () => {
  const repository = new InMemoryTradingRepository();
  const service = new TradeAutomationService(repository);
  const approvalPolicy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const approvalPlan = await service.createPlan(USER_A, plan({ signalId: 'global-stop-approval' }), approvalPolicy, false);
  assert.ok(approvalPlan.plan);

  await repository.setGlobalEmergencyStop(true, USER_A);
  await assert.rejects(() => service.approvePlan(USER_A, approvalPlan.plan!.id), /TRADE_PLAN_RISK_RECHECK_FAILED/);
  const blocked = await service.createPlan(USER_A, plan({ signalId: 'global-stop-new-plan' }), approvalPolicy, false);
  assert.equal(blocked.plan, null);
  assert.ok(blocked.decision.blockCodes.includes('EMERGENCY_STOP_ACTIVE'));

  const automaticPolicy = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    mode: 'automatic',
    automaticEnabled: true,
    marketEnabled: { domestic_stock: true, us_stock: true, crypto_spot: true, crypto_futures: true },
    exchangeEnabled: { bitget: false, upbit: true, kiwoom: false, toss: false },
    enabledAssets: { bitget: [], upbit: ['BTC'], kiwoom: [], toss: [] },
    enabledStrategies: ['breakout-v1'],
  });
  await repository.savePolicy(USER_A, automaticPolicy);

  const whileStopped = await service.createPlan(
    USER_A,
    plan({ signalId: 'global-stop-automatic-blocked' }),
    automaticPolicy,
    false,
  );
  assert.equal(whileStopped.plan, null);
  assert.ok(whileStopped.decision.blockCodes.includes('EMERGENCY_STOP_ACTIVE'));

  await repository.setGlobalEmergencyStop(false, USER_A);
  const automaticPlan = await service.createPlan(
    USER_A,
    plan({ signalId: 'global-stop-automatic-resumed' }),
    automaticPolicy,
    false,
  );
  assert.equal(automaticPlan.plan?.state, 'APPROVAL_PENDING');
  const submitted = await service.beginAutomaticPlan(USER_A, automaticPlan.plan!.id);
  assert.equal(submitted.state, 'SUBMITTED');
  assert.ok(submitted.riskEnvelope);
  assert.equal(await repository.findOrderByPlan(USER_A, automaticPlan.plan!.id), null);
});
test('live provider execution is blocked until the saved credential is explicitly verified', async () => {
  const previous = {
    ...spotLiveEnvironmentSnapshot(),
    ORDER_EXECUTION_ENABLED: process.env.ORDER_EXECUTION_ENABLED,
    LIVE_TRADING_ACTIVATION_APPROVED: process.env.LIVE_TRADING_ACTIVATION_APPROVED,
    REAL_ORDER_ENABLED: process.env.REAL_ORDER_ENABLED,
    PRIVATE_TRADING_API_ALLOWED: process.env.PRIVATE_TRADING_API_ALLOWED,
    UPBIT_LIVE_ORDER_ENABLED: process.env.UPBIT_LIVE_ORDER_ENABLED,
    TRADING_CREDENTIAL_MASTER_KEY: process.env.TRADING_CREDENTIAL_MASTER_KEY,
    LIVE_TRADING: process.env.LIVE_TRADING,
    executionAuthority: process.env.executionAuthority,
  };
  const nativeFetch = globalThis.fetch;
  try {
    process.env.ORDER_EXECUTION_ENABLED = 'true';
    process.env.LIVE_TRADING_ACTIVATION_APPROVED = 'true';
    process.env.REAL_ORDER_ENABLED = 'true';
    process.env.PRIVATE_TRADING_API_ALLOWED = 'true';
    process.env.UPBIT_LIVE_ORDER_ENABLED = 'true';
    process.env.LIVE_TRADING = 'true';
    process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
    enableSpotLiveTestEnvironment();

    const repository = new InMemoryTradingRepository();
    const automation = new TradeAutomationService(repository);
    const created = await automation.createPlan(
      USER_A,
      plan({ signalId: 'unverified-live-connection' }),
      normalizeTradingPolicy(DEFAULT_TRADING_POLICY),
      false,
    );
    const approved = await automation.approvePlan(USER_A, created.plan!.id);
    const order = (await automation.createOrder(USER_A, approved)).order;
    const livePlan = { ...approved, accountMode: 'live' as const };
    await repository.savePlan(livePlan);
    await repository.saveConnection({
      userId: USER_A,
      exchange: 'upbit',
      accountMode: 'live',
      configured: true,
      encryptedCredentials: encryptTradingCredentials({ accessKey: 'live-access', secretKey: 'live-secret' }, MASTER_KEY),
      lastVerifiedAt: null,
      lastErrorCode: 'LIVE_EXECUTION_NOT_VERIFIED',
      updatedAt: new Date().toISOString(),
    });

    let outbound = 0;
    globalThis.fetch = (async () => {
      outbound += 1;
      throw new Error('PROVIDER_REQUEST_MUST_NOT_HAPPEN');
    }) as typeof fetch;

    const executed = await new TradeExecutionService(repository).execute(USER_A, livePlan, order);
    assert.equal(executed.state, 'REJECTED');
    assert.equal(executed.lastErrorCode, 'LIVE_EXECUTION_CONNECTION_NOT_VERIFIED');
    assert.equal(outbound, 0);
  } finally {
    globalThis.fetch = nativeFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('provider submission rechecks canonical LIVE_TRADING and blocks before outbound request', async () => {
  const previous = {
    ...spotLiveEnvironmentSnapshot(),
    ORDER_EXECUTION_ENABLED: process.env.ORDER_EXECUTION_ENABLED,
    LIVE_TRADING_ACTIVATION_APPROVED: process.env.LIVE_TRADING_ACTIVATION_APPROVED,
    REAL_ORDER_ENABLED: process.env.REAL_ORDER_ENABLED,
    PRIVATE_TRADING_API_ALLOWED: process.env.PRIVATE_TRADING_API_ALLOWED,
    UPBIT_LIVE_ORDER_ENABLED: process.env.UPBIT_LIVE_ORDER_ENABLED,
    TRADING_CREDENTIAL_MASTER_KEY: process.env.TRADING_CREDENTIAL_MASTER_KEY,
    LIVE_TRADING: process.env.LIVE_TRADING,
    executionAuthority: process.env.executionAuthority,
  };
  const nativeFetch = globalThis.fetch;
  try {
    process.env.ORDER_EXECUTION_ENABLED = 'true';
    process.env.LIVE_TRADING_ACTIVATION_APPROVED = 'true';
    process.env.REAL_ORDER_ENABLED = 'true';
    process.env.PRIVATE_TRADING_API_ALLOWED = 'true';
    process.env.UPBIT_LIVE_ORDER_ENABLED = 'true';
    process.env.LIVE_TRADING = 'false';
    process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
    enableSpotLiveTestEnvironment();

    const repository = new InMemoryTradingRepository();
    const automation = new TradeAutomationService(repository);
    const approvalPolicy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
    const created = await automation.createPlan(
      USER_A,
      plan({ signalId: 'final-canonical-live-flag-recheck' }),
      approvalPolicy,
      false,
    );
    const approved = await automation.approvePlan(USER_A, created.plan!.id);
    const order = (await automation.createOrder(USER_A, approved)).order;
    const livePlan = { ...approved, accountMode: 'live' as const };
    await repository.savePlan(livePlan);
    await repository.saveConnection({
      userId: USER_A,
      exchange: 'upbit',
      accountMode: 'live',
      configured: true,
      encryptedCredentials: encryptTradingCredentials({ accessKey: 'live-access', secretKey: 'live-secret' }, MASTER_KEY),
      lastVerifiedAt: new Date().toISOString(),
      lastErrorCode: null,
      updatedAt: new Date().toISOString(),
    });

    let outbound = 0;
    globalThis.fetch = (async () => {
      outbound += 1;
      throw new Error('PROVIDER_REQUEST_MUST_NOT_HAPPEN');
    }) as typeof fetch;

    const executed = await new TradeExecutionService(repository).execute(USER_A, livePlan, order);
    assert.equal(executed.state, 'REJECTED');
    assert.equal(executed.lastErrorCode, 'LIVE_TRADING_OFF');
    assert.equal(outbound, 0);
  } finally {
    globalThis.fetch = nativeFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('provider submission rechecks canonical AUTO_TRADING and blocks automatic live before outbound request', async () => {
  const previous = {
    ...spotLiveEnvironmentSnapshot(),
    ORDER_EXECUTION_ENABLED: process.env.ORDER_EXECUTION_ENABLED,
    LIVE_TRADING_ACTIVATION_APPROVED: process.env.LIVE_TRADING_ACTIVATION_APPROVED,
    REAL_ORDER_ENABLED: process.env.REAL_ORDER_ENABLED,
    PRIVATE_TRADING_API_ALLOWED: process.env.PRIVATE_TRADING_API_ALLOWED,
    UPBIT_LIVE_ORDER_ENABLED: process.env.UPBIT_LIVE_ORDER_ENABLED,
    LIVE_AUTOMATIC_TRADING_ENABLED: process.env.LIVE_AUTOMATIC_TRADING_ENABLED,
    TRADING_CREDENTIAL_MASTER_KEY: process.env.TRADING_CREDENTIAL_MASTER_KEY,
    LIVE_TRADING: process.env.LIVE_TRADING,
    AUTO_TRADING: process.env.AUTO_TRADING,
    executionAuthority: process.env.executionAuthority,
  };
  const nativeFetch = globalThis.fetch;
  try {
    process.env.ORDER_EXECUTION_ENABLED = 'true';
    process.env.LIVE_TRADING_ACTIVATION_APPROVED = 'true';
    process.env.REAL_ORDER_ENABLED = 'true';
    process.env.PRIVATE_TRADING_API_ALLOWED = 'true';
    process.env.UPBIT_LIVE_ORDER_ENABLED = 'true';
    process.env.LIVE_TRADING = 'true';
    process.env.AUTO_TRADING = 'false';
    process.env.LIVE_AUTOMATIC_TRADING_ENABLED = 'true';
    process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
    enableSpotLiveTestEnvironment();

    const repository = new InMemoryTradingRepository();
    const automation = new TradeAutomationService(repository);
    const approvalPolicy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
    const created = await automation.createPlan(
      USER_A,
      plan({ signalId: 'final-canonical-auto-flag-recheck' }),
      approvalPolicy,
      false,
    );
    const approved = await automation.approvePlan(USER_A, created.plan!.id);
    const order = (await automation.createOrder(USER_A, approved)).order;
    const livePlan = { ...approved, accountMode: 'live' as const };
    await repository.savePlan(livePlan);
    await repository.saveConnection({
      userId: USER_A,
      exchange: 'upbit',
      accountMode: 'live',
      configured: true,
      encryptedCredentials: encryptTradingCredentials({ accessKey: 'live-access', secretKey: 'live-secret' }, MASTER_KEY),
      lastVerifiedAt: new Date().toISOString(),
      lastErrorCode: null,
      updatedAt: new Date().toISOString(),
    });
    await repository.savePolicy(USER_A, normalizeTradingPolicy({
      ...DEFAULT_TRADING_POLICY,
      mode: 'automatic',
      automaticEnabled: true,
      marketEnabled: { domestic_stock: false, us_stock: false, crypto_spot: true, crypto_futures: false },
      exchangeEnabled: { bitget: false, upbit: true, kiwoom: false, toss: false },
      enabledAssets: { bitget: [], upbit: ['BTC'], kiwoom: [], toss: [] },
      enabledStrategies: ['breakout-v1'],
    }));

    let outbound = 0;
    globalThis.fetch = (async () => {
      outbound += 1;
      throw new Error('PROVIDER_REQUEST_MUST_NOT_HAPPEN');
    }) as typeof fetch;

    const executed = await new TradeExecutionService(repository).execute(USER_A, livePlan, order);
    assert.equal(executed.state, 'REJECTED');
    assert.equal(executed.lastErrorCode, 'LIVE_EXECUTION_DISABLED');
    assert.equal(outbound, 0);
  } finally {
    globalThis.fetch = nativeFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('provider submission rechecks automatic live authority and blocks before outbound request', async () => {
  const previous = {
    ...spotLiveEnvironmentSnapshot(),
    ORDER_EXECUTION_ENABLED: process.env.ORDER_EXECUTION_ENABLED,
    LIVE_TRADING_ACTIVATION_APPROVED: process.env.LIVE_TRADING_ACTIVATION_APPROVED,
    REAL_ORDER_ENABLED: process.env.REAL_ORDER_ENABLED,
    PRIVATE_TRADING_API_ALLOWED: process.env.PRIVATE_TRADING_API_ALLOWED,
    UPBIT_LIVE_ORDER_ENABLED: process.env.UPBIT_LIVE_ORDER_ENABLED,
    LIVE_AUTOMATIC_TRADING_ENABLED: process.env.LIVE_AUTOMATIC_TRADING_ENABLED,
    TRADING_CREDENTIAL_MASTER_KEY: process.env.TRADING_CREDENTIAL_MASTER_KEY,
    LIVE_TRADING: process.env.LIVE_TRADING,
    AUTO_TRADING: process.env.AUTO_TRADING,
    executionAuthority: process.env.executionAuthority,
  };
  const nativeFetch = globalThis.fetch;
  try {
    process.env.ORDER_EXECUTION_ENABLED = 'true';
    process.env.LIVE_TRADING_ACTIVATION_APPROVED = 'true';
    process.env.REAL_ORDER_ENABLED = 'true';
    process.env.PRIVATE_TRADING_API_ALLOWED = 'true';
    process.env.UPBIT_LIVE_ORDER_ENABLED = 'true';
    process.env.LIVE_TRADING = 'true';
    process.env.AUTO_TRADING = 'true';
    process.env.LIVE_AUTOMATIC_TRADING_ENABLED = 'false';
    process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
    enableSpotLiveTestEnvironment();

    const repository = new InMemoryTradingRepository();
    const automation = new TradeAutomationService(repository);
    const approvalPolicy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
    const created = await automation.createPlan(
      USER_A,
      plan({ signalId: 'final-auto-live-recheck-fixture' }),
      approvalPolicy,
      false,
    );
    const approved = await automation.approvePlan(USER_A, created.plan!.id);
    const order = (await automation.createOrder(USER_A, approved)).order;
    const livePlan = { ...approved, accountMode: 'live' as const };
    await repository.savePlan(livePlan);
    await repository.saveConnection({
      userId: USER_A,
      exchange: 'upbit',
      accountMode: 'live',
      configured: true,
      encryptedCredentials: encryptTradingCredentials({ accessKey: 'live-access', secretKey: 'live-secret' }, MASTER_KEY),
      lastVerifiedAt: new Date().toISOString(),
      lastErrorCode: null,
      updatedAt: new Date().toISOString(),
    });
    await repository.savePolicy(USER_A, normalizeTradingPolicy({
      ...DEFAULT_TRADING_POLICY,
      mode: 'automatic',
      automaticEnabled: true,
      marketEnabled: { domestic_stock: false, us_stock: false, crypto_spot: true, crypto_futures: false },
      exchangeEnabled: { bitget: false, upbit: true, kiwoom: false, toss: false },
      enabledAssets: { bitget: [], upbit: ['BTC'], kiwoom: [], toss: [] },
      enabledStrategies: ['breakout-v1'],
    }));

    let outbound = 0;
    globalThis.fetch = (async () => {
      outbound += 1;
      throw new Error('PROVIDER_REQUEST_MUST_NOT_HAPPEN');
    }) as typeof fetch;

    const executed = await new TradeExecutionService(repository).execute(USER_A, livePlan, order);
    assert.equal(executed.state, 'REJECTED');
    assert.equal(executed.lastErrorCode, 'LIVE_EXECUTION_DISABLED');
    assert.equal(outbound, 0);
  } finally {
    globalThis.fetch = nativeFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('live connection verification authenticates the three spot providers with zero order mutation', async () => {
  const previous = {
    ...spotLiveEnvironmentSnapshot(),
    TRADING_CREDENTIAL_MASTER_KEY: process.env.TRADING_CREDENTIAL_MASTER_KEY,
    ORDER_EXECUTION_ENABLED: process.env.ORDER_EXECUTION_ENABLED,
    LIVE_TRADING_ACTIVATION_APPROVED: process.env.LIVE_TRADING_ACTIVATION_APPROVED,
    REAL_ORDER_ENABLED: process.env.REAL_ORDER_ENABLED,
    PRIVATE_TRADING_API_ALLOWED: process.env.PRIVATE_TRADING_API_ALLOWED,
    UPBIT_LIVE_ORDER_ENABLED: process.env.UPBIT_LIVE_ORDER_ENABLED,
    KIWOOM_LIVE_ORDER_ENABLED: process.env.KIWOOM_LIVE_ORDER_ENABLED,
    TOSS_LIVE_ORDER_ENABLED: process.env.TOSS_LIVE_ORDER_ENABLED,
    LIVE_TRADING: process.env.LIVE_TRADING,
    executionAuthority: process.env.executionAuthority,
  };
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
  process.env.ORDER_EXECUTION_ENABLED = 'true';
  process.env.LIVE_TRADING_ACTIVATION_APPROVED = 'true';
  process.env.REAL_ORDER_ENABLED = 'true';
  process.env.PRIVATE_TRADING_API_ALLOWED = 'true';
  process.env.UPBIT_LIVE_ORDER_ENABLED = 'true';
  process.env.KIWOOM_LIVE_ORDER_ENABLED = 'true';
  process.env.TOSS_LIVE_ORDER_ENABLED = 'true';
  process.env.LIVE_TRADING = 'true';
  enableSpotLiveTestEnvironment();
  const nativeFetch = globalThis.fetch;
  const financialMutations: string[] = [];
  const seen: string[] = [];
  try {
    const providers = [
      { exchange: 'upbit', credentials: { accessKey: 'upbit-access', secretKey: 'upbit-secret' } },
      { exchange: 'kiwoom', credentials: { appKey: 'kiwoom-key', secretKey: 'kiwoom-secret' } },
      { exchange: 'toss', credentials: { clientId: 'toss-client', clientSecret: 'toss-secret', accountSeq: 'account-1' } },
    ] as const;

    const repository = new InMemoryTradingRepository();
    for (const row of providers) {
      await repository.saveConnection({
        userId: USER_A,
        exchange: row.exchange,
        accountMode: 'live',
        configured: true,
        encryptedCredentials: encryptTradingCredentials(row.credentials, MASTER_KEY),
        lastVerifiedAt: null,
        lastErrorCode: 'LIVE_EXECUTION_NOT_VERIFIED',
        updatedAt: new Date().toISOString(),
      });
    }

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      seen.push(`${method} ${url}`);
      if (
        (url.includes('api.upbit.com/v1/orders') && method !== 'GET')
        || url.includes('api.bitget.com/api/v2/mix/order/place-order')
        || url.includes('api.kiwoom.com/api/dostk/ordr')
        || url.includes('api.kiwoom.com/api/us/ordr')
        || (url.includes('openapi.tossinvest.com/api/v1/orders') && method !== 'GET')
      ) {
        financialMutations.push(`${method} ${url}`);
        throw new Error('TEST_FINANCIAL_MUTATION_FORBIDDEN');
      }
      if (url.includes('api.upbit.com/v1/accounts')) {
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('api.bitget.com/api/v2/mix/account/accounts')
        || url.includes('api.bitget.com/api/v2/mix/position/all-position')) {
        return new Response(JSON.stringify({ code: '00000', data: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('api.kiwoom.com/oauth2/token')) {
        return new Response(JSON.stringify({ return_code: 0, token: 'kiwoom-token' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('api.kiwoom.com/api/dostk/acnt')) {
        return new Response(JSON.stringify({ return_code: 0 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('openapi.tossinvest.com/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'toss-token', expires_in: 3600 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('openapi.tossinvest.com/api/v1/accounts')) {
        return new Response(JSON.stringify({
          result: [{ accountSeq: 'account-1', accountType: 'brokerage' }],
        }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('openapi.tossinvest.com/api/v1/buying-power')) {
        return new Response(JSON.stringify({ result: { buyingPower: '0' } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`UNEXPECTED_VERIFICATION_REQUEST:${method}:${url}`);
    }) as typeof fetch;

    const execution = new TradeExecutionService(repository);
    for (const row of providers) {
      const result = await execution.verifyLiveConnection(USER_A, row.exchange);
      assert.equal(result.verified, true, row.exchange);
      assert.equal(result.orderRequests, 0, row.exchange);
      assert.equal(result.cancelRequests, 0, row.exchange);
      assert.equal(result.amendRequests, 0, row.exchange);
      assert.equal(result.transferRequests, 0, row.exchange);
      assert.equal(result.withdrawalRequests, 0, row.exchange);
      assert.equal(result.realOrderSubmitted, false, row.exchange);
      const connection = await repository.getConnection(USER_A, row.exchange);
      assert.ok(connection?.lastVerifiedAt, row.exchange);
      assert.equal(connection?.lastErrorCode, null, row.exchange);
    }
    assert.deepEqual(financialMutations, []);
    assert.ok(seen.length >= 6);
  } finally {
    globalThis.fetch = nativeFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('FILLED state transition rejects missing execution evidence before storing a false terminal fill', async () => {
  const repository = new InMemoryTradingRepository();
  const automation = new TradeAutomationService(repository);
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const created = await automation.createPlan(USER_A, plan({ signalId: 'no-fake-fill-signal' }), policy, false);
  assert.ok(created.plan);
  const approved = await automation.approvePlan(USER_A, created.plan.id);
  const order = (await automation.createOrder(USER_A, approved)).order;
  const accepted = await automation.transition(order, 'ACCEPTED', 'PAPER_BROKER_ACCEPTED');

  await assert.rejects(
    automation.transition(accepted, 'FILLED', 'PAPER_BROKER_FILLED'),
    /TRADE_FILLED_EXECUTION_EVIDENCE_REQUIRED/,
  );
  await assert.rejects(
    automation.transition(accepted, 'FILLED', 'PAPER_BROKER_FILLED', {
      filledQuantity: 0, averageFillPrice: 100_000,
    }),
    /TRADE_FILLED_EXECUTION_EVIDENCE_REQUIRED/,
  );
  const persisted = await repository.getOrder(USER_A, accepted.id);
  assert.equal(persisted?.state, 'ACCEPTED');
  assert.equal(persisted?.filledQuantity, 0);
  assert.ok((await repository.listEvents(USER_A)).every((event) => event.toState !== 'FILLED'));

  const completed = await automation.transition(accepted, 'FILLED', 'PAPER_BROKER_FILLED', {
    filledQuantity: 1, averageFillPrice: 100_000, feeAmount: 50, feeCurrency: 'KRW',
  });
  assert.equal(completed.state, 'FILLED');
  assert.equal(completed.filledQuantity, 1);
  assert.equal((await repository.getOrder(USER_A, accepted.id))?.filledQuantity, 1);
});

test('paper execution has zero outbound calls and restart scan marks an accepted order for reconciliation', async () => {
  const repository = new InMemoryTradingRepository();
  const automation = new TradeAutomationService(repository);
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const created = await automation.createPlan(USER_A, plan(), policy, false);
  const approved = await automation.approvePlan(USER_A, created.plan!.id);
  const { order } = await automation.createOrder(USER_A, approved);
  await repository.saveConnection({
    userId: USER_A, exchange: 'upbit', accountMode: 'paper', configured: true,
    encryptedCredentials: encryptTradingCredentials({ accessKey: 'paper', secretKey: 'paper' }, MASTER_KEY),
    lastVerifiedAt: null, lastErrorCode: null, updatedAt: new Date().toISOString(),
  });
  const nativeFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound += 1; throw new Error('outbound blocked'); }) as typeof fetch;
  const previous = process.env.TRADING_CREDENTIAL_MASTER_KEY;
  process.env.TRADING_CREDENTIAL_MASTER_KEY = MASTER_KEY;
  try {
    const executed = await new TradeExecutionService(repository).execute(USER_A, approved, order);
    assert.equal(executed.state, 'FILLED');
    assert.equal(executed.filledQuantity, 1);
    assert.equal(executed.averageFillPrice, 100_000);
    assert.equal(outbound, 0);
    const payloads = await readTradeAutomationJournalPayloads(repository, USER_A);
    const journal = buildUnifiedTradeJournal(payloads, {
      range: '30D',
      source: 'APP_PAPER',
      strategy: 'breakout-v1',
    });
    assert.equal(journal.trades.length, 1);
    assert.equal(journal.trades[0]?.strategy, 'breakout-v1');
    assert.deepEqual(journal.trades[0]?.canonicalLineage?.signalIds, ['signal-1']);
  } finally {
    globalThis.fetch = nativeFetch;
    if (previous == null) delete process.env.TRADING_CREDENTIAL_MASTER_KEY;
    else process.env.TRADING_CREDENTIAL_MASTER_KEY = previous;
  }

  const second = await automation.createPlan(USER_A, plan({ signalId: 'restart-signal' }), policy, false);
  const secondApproved = await automation.approvePlan(USER_A, second.plan!.id);
  const secondOrder = (await automation.createOrder(USER_A, secondApproved)).order;
  const accepted = await automation.transition(secondOrder, 'ACCEPTED', 'TEST_ACCEPTED');
  const recovered = await new TradeAutomationService(repository).recoverOpenOrders(USER_A);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.state, 'RECOVERY_REQUIRED');
  assert.equal((await repository.getOrder(USER_A, accepted.id))?.state, 'RECOVERY_REQUIRED');
});

test('signal invalidation cancels only the unfilled remainder and preserves partial fills', async () => {
  const repository = new InMemoryTradingRepository();
  const service = new TradeAutomationService(repository);
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const created = await service.createPlan(USER_A, plan({ signalId: 'partial-signal', side: 'sell', quantity: 10, quoteAmount: null }), policy, false);
  const approved = await service.approvePlan(USER_A, created.plan!.id);
  const order = (await service.createOrder(USER_A, approved)).order;
  await service.transition(order, 'ACCEPTED', 'EXCHANGE_ACCEPTED');
  await service.transition(order, 'PARTIALLY_FILLED', 'PARTIAL_FILL', { filledQuantity: 4, averageFillPrice: 100_000 });
  const result = await service.invalidatePlan(USER_A, approved.id);
  assert.equal(result.order?.state, 'CANCEL_REQUESTED');
  assert.equal(result.filledQuantityPreserved, 4);
  const nativeFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound += 1; throw new Error('outbound blocked'); }) as typeof fetch;
  try {
    const canceled = await new TradeExecutionService(repository).cancel(USER_A, approved, result.order!);
    assert.equal(canceled.state, 'CANCELED');
    assert.equal(canceled.filledQuantity, 4);
    assert.equal(outbound, 0);
  } finally { globalThis.fetch = nativeFetch; }
});


test('malformed reduceOnly cash BUY fails closed before bypassing stop, new-entry or amount gates', () => {
  const policy = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    mode: 'automatic',
    automaticEnabled: true,
    newEntriesStopped: true,
    exchangeEnabled: { bitget: false, upbit: true, kiwoom: true, toss: true },
  });
  for (const [exchange, market, symbol] of [
    ['upbit', 'KRW', 'BTC'],
    ['kiwoom', 'KR', '005930'],
    ['toss', 'KR', '005930'],
  ] as const) {
    const decision = evaluateTradingPlan(plan({
      exchange, market, symbol, side: 'buy', reduceOnly: true,
      stockBroker: exchange === 'upbit' ? null : exchange,
      quantity: exchange === 'upbit' ? 0.01 : 1,
      quoteAmount: null, estimatedKrw: 150_000,
      targetPrices: [], stopPrice: 0,
    }), policy, { emergencyStopped: true, serverLiveEnabled: true });
    assert.ok(decision.blockCodes.includes('REDUCE_ONLY_SIDE_INVALID'), exchange);
    assert.ok(decision.blockCodes.includes('EMERGENCY_STOP_ACTIVE'), exchange);
    assert.ok(decision.blockCodes.includes('NEW_ENTRIES_STOPPED'), exchange);
    assert.equal(decision.allowed, false);
  }
});

test('canonical trading risk never treats an empty automatic allowlist as unrestricted authority', () => {
  const active = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    mode:'automatic', automaticEnabled:true,
    marketEnabled:{domestic_stock:false,us_stock:false,crypto_spot:true,crypto_futures:false},
    exchangeEnabled:{toss:false,kiwoom:false,upbit:true,bitget:false},
    enabledStrategies:[],
  });
  const simulated = plan({
    accountMode:'paper',exchange:'upbit',market:'KRW',side:'buy',
    symbol:'BTC',strategyId:'unapproved-strategy',
  });
  const blocked = evaluateTradingPlan(simulated,active,{
    emergencyStopped:false,serverLiveEnabled:false,
  });
  assert.ok(blocked.blockCodes.includes('STRATEGY_NOT_ENABLED'));
  assert.equal(blocked.allowed,false);

  const allowedPolicy=normalizeTradingPolicy({
    ...active,enabledStrategies:[simulated.strategyId],
  });
  const reviewed=evaluateTradingPlan(simulated,allowedPolicy,{
    emergencyStopped:false,serverLiveEnabled:false,
  });
  assert.equal(reviewed.blockCodes.includes('STRATEGY_NOT_ENABLED'),false);
});

test('BTC benchmark drawdown blocks only new crypto long/buy entries and never fails closed on missing data', () => {
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const options = { emergencyStopped: false, serverLiveEnabled: false };
  const blocked = (input: TradingPlanInput) => evaluateTradingPlan(input, policy, options)
    .blockCodes.includes('BENCHMARK_DRAWDOWN_LONG_BLOCKED');
  const crash = { ...plan().marketSnapshot, benchmarkDrawdownPercent: 6.5 };
  const calm = { ...plan().marketSnapshot, benchmarkDrawdownPercent: 2 };

  // Upbit spot buy during a BTC crash: blocked. Calm or unknown benchmark: not blocked.
  assert.equal(blocked(plan({ marketSnapshot: crash })), true);
  assert.equal(blocked(plan({ marketSnapshot: calm })), false);
  assert.equal(blocked(plan()), false);
  assert.equal(blocked(plan({ marketSnapshot: { ...plan().marketSnapshot, benchmarkDrawdownPercent: null } })), false);

  // Bitget: new long blocked, short allowed.
  const futures = { exchange: 'bitget' as const, market: 'USDT-FUTURES', quantity: 0.01, quoteAmount: null,
    leverage: 2, marginMode: 'isolated' as const };
  assert.equal(blocked(plan({ ...futures, side: 'long', marketSnapshot: crash })), true);
  assert.equal(blocked(plan({ ...futures, side: 'short', marketSnapshot: crash })), false);

  // Stocks are never affected by the crypto benchmark.
  assert.equal(blocked(plan({ exchange: 'kiwoom', market: 'KR', symbol: '005930', quantity: 1, quoteAmount: null,
    marketSnapshot: crash })), false);
});

test('drawdown is measured from the peak close to the last close', () => {
  assert.equal(drawdownFromPeakPercent([100, 110, 99]), 10);
  assert.equal(drawdownFromPeakPercent([100, 101, 102]), 0);
  assert.equal(drawdownFromPeakPercent([100]), null);
  assert.equal(drawdownFromPeakPercent([]), null);
});

test('block threshold is 6% and unknown values never block', () => {
  assert.equal(BENCHMARK_DRAWDOWN_LONG_BLOCK_PERCENT, 6);
  assert.equal(benchmarkDrawdownBlocksLong(6), true);
  assert.equal(benchmarkDrawdownBlocksLong(5.99), false);
  assert.equal(benchmarkDrawdownBlocksLong(null), false);
  assert.equal(benchmarkDrawdownBlocksLong(undefined), false);
  assert.equal(benchmarkDrawdownBlocksLong(Number.NaN), false);
});

test('only new crypto long/buy entries are subject to the filter', () => {
  assert.equal(isNewCryptoLongEntry({ exchange: 'bitget', side: 'long' }, false), true);
  assert.equal(isNewCryptoLongEntry({ exchange: 'upbit', side: 'buy' }, false), true);
  assert.equal(isNewCryptoLongEntry({ exchange: 'bitget', side: 'short' }, false), false);
  assert.equal(isNewCryptoLongEntry({ exchange: 'upbit', side: 'sell' }, false), false);
  assert.equal(isNewCryptoLongEntry({ exchange: 'kiwoom', side: 'buy' }, false), false);
  assert.equal(isNewCryptoLongEntry({ exchange: 'bitget', side: 'long' }, true), false);
});

function bitgetCandles(closes: number[], startMs: number) {
  return {
    code: '00000',
    msg: 'success',
    data: closes.map((close, index) => [
      String(startMs + index * 300_000), String(close), String(close), String(close), String(close), '1', String(close),
    ]),
  };
}

test('reader computes drawdown from closed Bitget candles, caches for a minute and fails open', async () => {
  const startMs = Date.UTC(2026, 9, 17, 0, 0, 0);
  const nowMs = startMs + 10 * 300_000;
  let calls = 0;
  const reader = createBtcBenchmarkDrawdownReader(async () => {
    calls += 1;
    return bitgetCandles([100, 100, 100, 100, 100, 100, 100, 100, 100, 92], startMs);
  });
  assert.equal(await reader(nowMs), 8);
  assert.equal(await reader(nowMs + 30_000), 8);
  assert.equal(calls, 1);

  const failing = createBtcBenchmarkDrawdownReader(async () => { throw new Error('network'); });
  assert.equal(await failing(nowMs), null);
  const malformed = createBtcBenchmarkDrawdownReader(async () => ({ code: '40001', data: null }));
  assert.equal(await malformed(nowMs), null);
});

test('per-market live switch defaults OFF and blocks only new LIVE entries in that market', () => {
  const defaults = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  assert.deepEqual(defaults.liveMarketEnabled, {
    domestic_stock: false, us_stock: false, crypto_spot: false, crypto_futures: false,
  });
  const options = { emergencyStopped: false, serverLiveEnabled: true };
  const live = plan({ accountMode: 'live' });
  const paper = plan({ accountMode: 'paper' });
  const blocked = (input: TradingPlanInput, policy = defaults) => evaluateTradingPlan(input, policy, options)
    .blockCodes.includes('LIVE_MARKET_SWITCH_OFF');

  assert.equal(blocked(live), true);
  assert.equal(blocked(paper), false);
  const upbitOn = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    liveMarketEnabled: { domestic_stock: false, us_stock: false, crypto_spot: true, crypto_futures: false },
  });
  assert.equal(blocked(live, upbitOn), false);
  // Another market stays off.
  assert.equal(blocked(plan({ accountMode: 'live', exchange: 'kiwoom', stockBroker: 'kiwoom', market: 'KR',
    symbol: '005930', quantity: 1, quoteAmount: null }), upbitOn), true);
  // Non-boolean values never switch a market on.
  const garbage = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    liveMarketEnabled: { domestic_stock: 'yes', us_stock: 1, crypto_spot: null, crypto_futures: undefined } as never,
  });
  assert.deepEqual(Object.values(garbage.liveMarketEnabled ?? {}), [false, false, false, false]);
});

test('first week after a market switch goes ON caps each new LIVE order at 100,000 KRW', () => {
  const options = { emergencyStopped: false, serverLiveEnabled: true };
  const at = (daysAgo: number) => new Date(Date.now() - (daysAgo * 86_400_000)).toISOString();
  const policyAt = (iso: string | null) => normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    liveMarketEnabled: { domestic_stock: false, us_stock: false, crypto_spot: true, crypto_futures: false },
    liveMarketEnabledAt: { domestic_stock: null, us_stock: null, crypto_spot: iso, crypto_futures: null },
  });
  const capped = (krw: number, iso: string | null) => evaluateTradingPlan(
    plan({ accountMode: 'live', quoteAmount: krw, estimatedKrw: krw }), policyAt(iso), options,
  ).blockCodes.includes('LIVE_FIRST_WEEK_ORDER_CAP');
  assert.equal(capped(100_000, at(1)), false);
  assert.equal(capped(100_001, at(1)), true);
  assert.equal(capped(300_000, at(8)), false);
  // Missing or malformed timestamp is treated as the first week.
  assert.equal(capped(300_000, null), true);
  assert.equal(capped(300_000, 'not-a-date'), true);
  // Paper orders are never capped by this rule.
  assert.equal(evaluateTradingPlan(plan({ accountMode: 'paper', quoteAmount: 300_000, estimatedKrw: 300_000 }), policyAt(at(1)), options)
    .blockCodes.includes('LIVE_FIRST_WEEK_ORDER_CAP'), false);
  // Timestamps of switched-off markets are dropped.
  assert.equal(policyAt(at(1)).liveMarketEnabledAt?.domestic_stock, null);
});


test('safety alerts fire only for LIVE plans and only for loss limits or the first-week cap', () => {
  assert.deepEqual(liveSafetyAlertCodes({ accountMode: 'paper' }, ['DAILY_LOSS_LIMIT']), []);
  assert.deepEqual(liveSafetyAlertCodes({ accountMode: 'live' }, ['SPREAD_TOO_WIDE']), []);
  assert.deepEqual(liveSafetyAlertCodes({ accountMode: 'live' }, ['DAILY_LOSS_LIMIT', 'LIVE_FIRST_WEEK_ORDER_CAP']),
    ['DAILY_LOSS_LIMIT', 'LIVE_FIRST_WEEK_ORDER_CAP']);
  assert.equal(assetClassOfPlan({ exchange: 'bitget', market: 'USDT-FUTURES' }), 'crypto_futures');
  assert.equal(assetClassOfPlan({ exchange: 'toss', market: 'US' }), 'us_stock');
});

test('loss-limit alerts are de-duplicated per user, rule and KST day; failures are swallowed', async () => {
  const seen: string[] = [];
  const deliver = (async (input: { event: { eventId: string; priority: string }; alert: { details?: string } }) => {
    seen.push(input.event.eventId);
    assert.equal(input.event.priority, 'CRITICAL');
    return { status: 'SKIPPED', reason: 'TELEGRAM_DISCONNECTED', policy: null };
  }) as never;
  const plan = { accountMode: 'live' as const, exchange: 'upbit' as const, market: 'KRW', symbol: 'BTC' };
  const morning = new Date('2026-10-18T00:30:00.000Z');
  const evening = new Date('2026-10-18T13:00:00.000Z');
  await notifyLiveSafetyBlock({ userId: USER_A, plan, blockCodes: ['DAILY_LOSS_LIMIT'], now: morning }, deliver);
  await notifyLiveSafetyBlock({ userId: USER_A, plan, blockCodes: ['DAILY_LOSS_LIMIT'], now: evening }, deliver);
  assert.equal(seen[0], seen[1], 'same KST day → same event id (deduplicated downstream)');
  await notifyLiveSafetyBlock({ userId: USER_A, plan, blockCodes: ['DAILY_LOSS_LIMIT'], now: new Date('2026-10-18T16:00:00.000Z') }, deliver);
  assert.notEqual(seen[2], seen[0], 'next KST day → new alert');

  const throwing = (async () => { throw new Error('telegram down'); }) as never;
  assert.deepEqual(await notifyLiveSafetyBlock({ userId: USER_A, plan, blockCodes: ['DAILY_LOSS_LIMIT'] }, throwing), [null]);
  assert.equal(await notifyLiveMarketSwitch({ userId: USER_A, market: 'crypto_spot', enabled: true }, throwing), null);
});
