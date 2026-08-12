import test from 'node:test';
import './broker-provider-adapter.test';
import './broker-portfolio-normalizer.service.test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import { TradeExecutionService } from './trade-execution.service';
import { encryptTradingCredentials, decryptTradingCredentials } from './trade-credential-vault.service';
import {
  buildBitgetSignature, buildUpbitJwt, prepareBitgetOrder, prepareBitgetTicker, prepareKiwoomOrder,
  prepareUpbitOrder, redactPreparedRequest, validateBitgetContractRules,
} from './trade-exchange-adapters.service';
import { evaluateTradingPlan, normalizeTradingPolicy, upbitKrwPriceStep } from './trade-automation-risk.service';
import { assertOrderTransition, canTransitionOrder } from './trade-order-state-machine.service';
import { DEFAULT_TRADING_POLICY, type TradingPlanInput } from './trade-automation.types';

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

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
  assert.deepEqual(policy.providerModes, { bitget: 'OFF', upbit: 'OFF', kiwoom: 'OFF', toss: 'OFF' });
  assert.deepEqual(policy.enabledAssets, { bitget: [], upbit: [], kiwoom: [], toss: [] });
  assert.equal(policy.bitgetLeverage, 2);
});

test('automatic shadow policy remains user-configured and can submit only non-live plans', async () => {
  const automatic = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY, mode: 'automatic', automaticEnabled: true,
    exchangeEnabled: { bitget: false, upbit: true, kiwoom: false, toss: false },
    enabledAssets: { bitget: [], upbit: ['ETH'], kiwoom: [], toss: [] }, enabledStrategies: ['breakout-v1'],
  });
  assert.equal(automatic.providerModes?.upbit, 'SHADOW');
  const blocked = evaluateTradingPlan(plan(), automatic, { emergencyStopped: false, serverLiveEnabled: true });
  assert.ok(blocked.blockCodes.includes('ASSET_NOT_ENABLED'));
  const allowedPolicy = { ...automatic, enabledAssets: { ...automatic.enabledAssets, upbit: ['BTC'] } };
  const allowed = evaluateTradingPlan(plan(), allowedPolicy, { emergencyStopped: false, serverLiveEnabled: true });
  assert.equal(allowed.allowed, true);
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER_A, allowedPolicy);
  const service = new TradeAutomationService(repository);
  const created = await service.createPlan(USER_A, plan({ signalId: 'automatic-shadow' }), allowedPolicy, false);
  assert.equal(created.plan?.state, 'APPROVAL_PENDING');
  const submitted = await service.beginAutomaticPlan(USER_A, created.plan!.id);
  assert.equal(submitted.state, 'SUBMITTED');
  assert.equal(submitted.riskEnvelope != null, true);
  assert.equal(await repository.findOrderByPlan(USER_A, created.plan!.id), null);
});

test('automatic shadow policy cannot elevate a plan to live account execution', async () => {
  const policy = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    mode: 'automatic', automaticEnabled: true,
    exchangeEnabled: { bitget: false, upbit: true, kiwoom: false, toss: false },
    enabledAssets: { bitget: [], upbit: ['BTC'], kiwoom: [], toss: [] },
    enabledStrategies: ['breakout-v1'],
  });
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER_A, policy);
  const service = new TradeAutomationService(repository);
  const input = plan({ accountMode: 'live', signalId: 'shadow-live-blocked' });
  const created = await service.createPlan(USER_A, input, policy, false);
  assert.equal(created.plan, null);
  assert.ok(created.decision.blockCodes.includes('AUTOMATIC_PROVIDER_LIVE_OPT_IN_REQUIRED'));
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

test('Bitget allows only 2x/3x, blocks opposite duplicate positions, and keeps reduce-only explicit', () => {
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const input = plan({ exchange: 'bitget', market: 'USDT-FUTURES', side: 'short', quantity: 0.01,
    quoteAmount: null, estimatedKrw: 100_000, leverage: 4, marginMode: 'isolated',
    marketSnapshot: { ...plan().marketSnapshot, existingPositionSide: 'long' } });
  const decision = evaluateTradingPlan(input, policy, { emergencyStopped: false, serverLiveEnabled: true });
  assert.ok(decision.blockCodes.includes('BITGET_LEVERAGE_LIMIT'));
  assert.ok(decision.blockCodes.includes('BITGET_OPPOSITE_POSITION_DUPLICATE'));
  const liquidationRisk = evaluateTradingPlan({ ...input, leverage: 3,
    marketSnapshot: { ...input.marketSnapshot, existingPositionSide: null, liquidationDistancePercent: 4 } },
  policy, { emergencyStopped: false, serverLiveEnabled: true });
  assert.ok(liquidationRisk.blockCodes.includes('BITGET_LIQUIDATION_RISK'));
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

test('Kiwoom adapter is domestic-only and keeps mock/live account mode in the plan risk gate', () => {
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const invalid = evaluateTradingPlan(plan({ exchange: 'kiwoom', market: 'US', symbol: 'AAPL', side: 'buy', quantity: 1 }), policy,
    { emergencyStopped: false, serverLiveEnabled: true });
  assert.ok(invalid.blockCodes.includes('KIWOOM_DOMESTIC_ONLY'));
  const request = prepareKiwoomOrder({ appKey: 'app', secretKey: 'secret', accessToken: 'token' },
    plan({ exchange: 'kiwoom', accountMode: 'mock', market: 'KR', symbol: '005930', side: 'buy', quantity: 2, quoteAmount: null }));
  assert.equal(request.headers['api-id'], 'kt10000');
  assert.match(request.body ?? '', /"stk_cd":"005930"/);
});

test('Toss risk contract is stock-only and quote-amount orders are US market buys only', () => {
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const valid = evaluateTradingPlan(plan({
    exchange: 'toss', market: 'KR', symbol: '005930', side: 'buy', quantity: 1, quoteAmount: null,
  }), policy, { emergencyStopped: false, serverLiveEnabled: true });
  assert.equal(valid.blockCodes.includes('TOSS_STOCK_ONLY'), false);
  assert.equal(valid.blockCodes.includes('TOSS_QUANTITY_OR_AMOUNT_REQUIRED'), false);
  const invalidAmount = evaluateTradingPlan(plan({
    exchange: 'toss', market: 'KR', symbol: '005930', side: 'buy', quantity: null, quoteAmount: 100_000,
  }), policy, { emergencyStopped: false, serverLiveEnabled: true });
  assert.ok(invalidAmount.blockCodes.includes('TOSS_AMOUNT_ORDER_US_MARKET_BUY_ONLY'));
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

test('same signal is idempotent, manual approval is mandatory outside automatic mode, and members cannot read each other', async () => {
  const repository = new InMemoryTradingRepository();
  const service = new TradeAutomationService(repository);
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const first = await service.createPlan(USER_A, plan(), policy, false);
  const second = await service.createPlan(USER_A, plan(), policy, false);
  assert.equal(first.plan?.id, second.plan?.id);
  assert.equal(second.duplicate, true);
  assert.equal(await repository.getPlan(USER_B, first.plan!.id), null);
  assert.equal(first.plan?.state, 'APPROVAL_PENDING');
  await assert.rejects(() => service.beginAutomaticPlan(USER_A, first.plan!.id), /AUTOMATIC_TRADING_NOT_ENABLED/);
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

test('persistent global emergency stop blocks plan creation and approval, then automatic shadow can resume only after stop clears', async () => {
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

  await repository.setGlobalEmergencyStop(false, USER_A);
  const automaticPolicy = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    mode: 'automatic', automaticEnabled: true,
    exchangeEnabled: { bitget: false, upbit: true, kiwoom: false, toss: false },
    enabledAssets: { bitget: [], upbit: ['BTC'], kiwoom: [], toss: [] },
    enabledStrategies: ['breakout-v1'],
  });
  await repository.savePolicy(USER_A, automaticPolicy);
  const automaticPlan = await service.createPlan(USER_A, plan({ signalId: 'global-stop-automatic' }), automaticPolicy, false);
  assert.equal(automaticPlan.plan?.state, 'APPROVAL_PENDING');
  const submitted = await service.beginAutomaticPlan(USER_A, automaticPlan.plan!.id);
  assert.equal(submitted.state, 'SUBMITTED');
  assert.equal(await repository.findOrderByPlan(USER_A, automaticPlan.plan!.id), null);
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
    assert.equal(outbound, 0);
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