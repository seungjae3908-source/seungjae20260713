import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TRADING_POLICY } from './trade-automation.types';
import { normalizeTradingPolicy } from './trade-automation-risk.service';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import type { TradingPlanInput } from './trade-automation.types';
import {
  deriveRulePackPilotCapitalFromTrades,
  deriveRulePackPilotExecutionPolicy,
  issueRulePackPilotDynamicCapReceipt,
  verifyRulePackPilotDynamicCapReceipt,
  resolveRulePackPilotDynamicCapPolicy,
  verifiedRulePackKrwSettlement,
  rulePackPilotLedgerHistoryComplete,
  evaluateRulePackPilotEntryGuard,
  type RulePackPilotCapitalState,
} from './trade-rule-pack-pilot-capital.service';

const NOW = Date.parse('2026-10-08T00:00:00.000Z');

function state(overrides: Partial<RulePackPilotCapitalState> = {}): RulePackPilotCapitalState {
  return Object.freeze({
    initialOperatingCapitalKrw: 500_000,
    operatingCapitalKrw: 500_000,
    reserveKrw: 0,
    highWaterMarkKrw: 500_000,
    maxEntryKrw: 500_000,
    realizedNetPnlKrw: 0,
    compoundedProfitKrw: 0,
    settledTradeCount: 0,
    dailyRealizedPnlKrw: 0,
    dailyLosingTrades: 0,
    consecutiveLosses: 0,
    latestLossBySymbol: Object.freeze({}),
    settlementReady: true,
    blockers: Object.freeze([]),
    reserveWithdrawalAutomatic: false,
    ...overrides,
  });
}

function decision(pilot: RulePackPilotCapitalState, overrides: Record<string, unknown> = {}) {
  return evaluateRulePackPilotEntryGuard({
    pilot,
    strategyId: 'CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1',
    symbol: 'BTC',
    signalId: 'signal-new',
    estimatedKrw: 500_000,
    policyMaxOrderKrw: 500_000,
    policyTotalCapitalKrw: 500_000,
    openLivePositions: 0,
    nowMs: NOW,
    ...overrides,
  } as never);
}

test('pilot capital starts at 500k and compounds only half of new high-water profit', () => {
  const result = deriveRulePackPilotCapitalFromTrades([{
    id: 'win-1',
    symbol: 'BTC',
    signalId: 'signal-win',
    closedAt: '2026-10-07T23:00:00.000Z',
    netPnlKrw: 100_000,
  }], new Date(NOW));
  assert.equal(result.initialOperatingCapitalKrw, 500_000);
  assert.equal(result.operatingCapitalKrw, 550_000);
  assert.equal(result.reserveKrw, 50_000);
  assert.equal(result.compoundedProfitKrw, 50_000);
  assert.equal(result.maxEntryKrw, 550_000);
  assert.equal(result.reserveWithdrawalAutomatic, false);
});

test('pilot entry guard allows at most the smaller of operating capital, pilot max entry, and member policy max', () => {
  const allowed = decision(state(), { estimatedKrw: 500_000 });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.effectiveOperatingCapitalKrw, 500_000);
  assert.equal(allowed.effectiveMaxEntryKrw, 500_000);

  const over = decision(state(), { estimatedKrw: 500_001 });
  assert.equal(over.allowed, false);
  assert.ok(over.blockers.includes('BACKGROUND_PILOT_ENTRY_LIMIT'));

  const memberCap = decision(state(), { estimatedKrw: 250_001, policyMaxOrderKrw: 250_000 });
  assert.equal(memberCap.effectiveMaxEntryKrw, 250_000);
  assert.ok(memberCap.blockers.includes('BACKGROUND_PILOT_ENTRY_LIMIT'));
});

test('pilot entry guard stops at five daily losses, 25k daily loss, three consecutive losses, or two live positions', () => {
  assert.ok(decision(state({ dailyLosingTrades: 5 })).blockers.includes('BACKGROUND_PILOT_DAILY_LOSS_COUNT_LIMIT'));
  assert.ok(decision(state({ dailyRealizedPnlKrw: -25_000 })).blockers.includes('BACKGROUND_PILOT_DAILY_LOSS_KRW_LIMIT'));
  assert.ok(decision(state({ consecutiveLosses: 3 })).blockers.includes('BACKGROUND_PILOT_CONSECUTIVE_LOSS_LIMIT'));
  assert.ok(decision(state(), { openLivePositions: 2 }).blockers.includes('BACKGROUND_PILOT_CONCURRENT_POSITION_LIMIT'));
});

test('pilot entry guard requires a fresh signal and 30-minute cooldown after a same-symbol loss', () => {
  const recentLoss = state({
    latestLossBySymbol: Object.freeze({
      BTC: Object.freeze({
        closedAt: '2026-10-07T23:40:00.000Z',
        signalId: 'signal-old',
      }),
    }),
  });
  const sameSignal = decision(recentLoss, { signalId: 'signal-old' });
  assert.ok(sameSignal.blockers.includes('BACKGROUND_PILOT_FRESH_SIGNAL_REQUIRED'));
  assert.ok(sameSignal.blockers.includes('BACKGROUND_PILOT_LOSS_COOLDOWN_ACTIVE'));

  const newButEarly = decision(recentLoss, { signalId: 'signal-new' });
  assert.equal(newButEarly.blockers.includes('BACKGROUND_PILOT_FRESH_SIGNAL_REQUIRED'), false);
  assert.ok(newButEarly.blockers.includes('BACKGROUND_PILOT_LOSS_COOLDOWN_ACTIVE'));

  const oldLoss = state({
    latestLossBySymbol: Object.freeze({
      BTC: Object.freeze({
        closedAt: '2026-10-07T23:29:00.000Z',
        signalId: 'signal-old',
      }),
    }),
  });
  const afterCooldown = decision(oldLoss, { signalId: 'signal-new' });
  assert.equal(afterCooldown.allowed, true);
});

test('pilot entry guard fails closed on settlement blockers or a non-rule-pack strategy', () => {
  const settlement = decision(state({
    settlementReady: false,
    blockers: Object.freeze(['PILOT_CAPITAL_FEE_EVIDENCE_UNAVAILABLE']),
  }));
  assert.ok(settlement.blockers.includes('BACKGROUND_PILOT_CAPITAL_SETTLEMENT_REQUIRED'));

  const unknown = decision(state(), { strategyId: 'UNKNOWN_STRATEGY' });
  assert.ok(unknown.blockers.includes('BACKGROUND_FORMULA_AI_PILOT_STRATEGY_REQUIRED'));
});
function closed(
  id: string, symbol: string, netPnlKrw: number,
  closedAt = '2026-10-07T23:00:00.000Z',
) {
  return Object.freeze({ id, symbol, signalId: id, netPnlKrw, closedAt });
}

test('confirmed 500k + 10% net profit yields 525k operating / 25k reserve; next entry cap compounds', () => {
  const snapshot = deriveRulePackPilotCapitalFromTrades([
    closed('KR-profit', '005930', 50_000),
  ], new Date(NOW));
  assert.equal(snapshot.initialOperatingCapitalKrw, 500_000);
  assert.equal(snapshot.operatingCapitalKrw, 525_000);
  assert.equal(snapshot.reserveKrw, 25_000);
  assert.equal(snapshot.highWaterMarkKrw, 550_000);
  assert.equal(snapshot.maxEntryKrw, 525_000);
  const eligible = decision(snapshot, { estimatedKrw: 525_000 });
  assert.equal(eligible.allowed, true);
  assert.equal(eligible.effectiveMaxEntryKrw, 525_000);
  const larger = decision(snapshot, { estimatedKrw: 525_000.01 });
  assert.ok(larger.blockers.includes('BACKGROUND_PILOT_ENTRY_LIMIT'));
});

test('four-market settlements share a single 500k ledger and compound only new highs after loss recovery', () => {
  const steps = [
    closed('kr', '005930', 50_000, '2026-10-07T17:00:00.000Z'),
    closed('us', 'AAPL', -20_000, '2026-10-07T18:00:00.000Z'),
    closed('spot', 'KRW-BTC', 20_000, '2026-10-07T19:00:00.000Z'),
    closed('futures', 'BTCUSDT', 30_000, '2026-10-07T20:00:00.000Z'),
  ];
  const first = deriveRulePackPilotCapitalFromTrades(steps.slice(0, 1), new Date(NOW));
  assert.equal(first.operatingCapitalKrw, 525_000);
  assert.equal(first.reserveKrw, 25_000);
  const afterLoss = deriveRulePackPilotCapitalFromTrades(steps.slice(0, 2), new Date(NOW));
  assert.equal(afterLoss.operatingCapitalKrw, 505_000);
  assert.equal(afterLoss.reserveKrw, 25_000);
  const afterRecovery = deriveRulePackPilotCapitalFromTrades(steps.slice(0, 3), new Date(NOW));
  assert.equal(afterRecovery.operatingCapitalKrw, 525_000);
  assert.equal(afterRecovery.reserveKrw, 25_000);
  const final = deriveRulePackPilotCapitalFromTrades(steps, new Date(NOW));
  assert.equal(final.operatingCapitalKrw, 540_000);
  assert.equal(final.reserveKrw, 40_000);
  assert.equal(final.highWaterMarkKrw, 580_000);
  assert.equal(final.settledTradeCount, 4);
});

test('reserve never auto-replenishes the 500k floor after drawdown and new entries fail closed', () => {
  const lost = deriveRulePackPilotCapitalFromTrades([
    closed('win', 'AAPL', 50_000, '2026-10-07T20:00:00.000Z'),
    closed('loss', 'ETHUSDT', -100_000, '2026-10-07T21:00:00.000Z'),
  ], new Date(NOW));
  assert.equal(lost.operatingCapitalKrw, 425_000);
  assert.equal(lost.reserveKrw, 25_000);
  assert.equal(lost.maxEntryKrw, 425_000);
  assert.equal(lost.reserveWithdrawalAutomatic, false);
  const blocked = decision(lost, { estimatedKrw: 20_000 });
  assert.ok(blocked.blockers.includes('BACKGROUND_PILOT_BASE_CAPITAL_UNDERFUNDED'));
  assert.ok(decision(state(), {
    policyTotalCapitalKrw: 100_000, policyMaxOrderKrw: 30_000,
    estimatedKrw: 20_000,
  }).blockers.includes('BACKGROUND_PILOT_BASE_POLICY_CAPITAL_REQUIRED'));
});

test('stricter member order cap stays stricter and is not silently promoted to 500k', () => {
  const gained = deriveRulePackPilotCapitalFromTrades([closed('gain', 'BTC', 50_000)], new Date(NOW));
  const small = decision(gained, { policyMaxOrderKrw: 30_000, estimatedKrw: 30_001 });
  assert.equal(small.effectiveMaxEntryKrw, 30_000);
  assert.ok(small.blockers.includes('BACKGROUND_PILOT_ENTRY_LIMIT'));
  const exact = decision(gained, { policyMaxOrderKrw: 30_000, estimatedKrw: 30_000 });
  assert.equal(exact.allowed, true);
});

test('dynamic capital policy expands only verified earned capital, never lower instrument/class caps', () => {
  const gained = deriveRulePackPilotCapitalFromTrades([closed('profit', '005930', 50_000)], new Date(NOW));
  const base = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    mode: 'automatic',
    automaticEnabled: true,
    pilotStage: 'formula-ai-exception',
    totalCapitalKrw: 500_000,
    maxOrderKrw: 500_000,
    maxInstrumentKrw: 500_000,
    maxAssetClassKrw: {
      domestic_stock: 500_000, us_stock: 500_000,
      crypto_spot: 500_000, crypto_futures: 300_000,
    },
  });
  const projected = deriveRulePackPilotExecutionPolicy(base, gained);
  assert.equal(projected.totalCapitalKrw, 525_000);
  assert.equal(projected.maxOrderKrw, 525_000);
  assert.equal(projected.maxInstrumentKrw, 525_000);
  assert.equal(projected.maxAssetClassKrw.domestic_stock, 525_000);
  assert.equal(projected.maxAssetClassKrw.crypto_futures, 300_000);
  assert.equal(projected.pilotStage, 'formula-ai-exception');
  assert.equal(projected.automaticEnabled, true);
  assert.equal(base.maxOrderKrw, 500_000, 'must not mutate source policy');
  assert.throws(() => deriveRulePackPilotExecutionPolicy({
    ...base, totalCapitalKrw: 100_000, maxOrderKrw: 30_000,
  }, gained), /BACKGROUND_PILOT_CAPITAL_SETTLEMENT_REQUIRED/);
  assert.throws(() => deriveRulePackPilotExecutionPolicy(base, {
    ...gained, settlementReady: false,
  }), /BACKGROUND_PILOT_CAPITAL_SETTLEMENT_REQUIRED/);
});

test('invalid, duplicate or future settlement evidence blocks capital promotion without double-credit', () => {
  const sample = closed('same', 'AAPL', 50_000);
  const invalid = deriveRulePackPilotCapitalFromTrades([
    sample,
    { ...sample },
    closed('future', 'BTCUSDT', 200_000, '2026-10-09T00:00:00.000Z'),
    closed('nan', '005930', Number.NaN),
  ], new Date(NOW));
  assert.equal(invalid.operatingCapitalKrw, 525_000);
  assert.equal(invalid.reserveKrw, 25_000);
  assert.equal(invalid.settledTradeCount, 1);
  assert.equal(invalid.settlementReady, false);
  assert.ok(invalid.blockers.includes('PILOT_CAPITAL_DUPLICATE_SETTLEMENT'));
  assert.ok(invalid.blockers.includes('PILOT_CAPITAL_TRADE_EVIDENCE_INVALID'));
  assert.ok(decision(invalid, { estimatedKrw: 20_000 })
    .blockers.includes('BACKGROUND_PILOT_CAPITAL_SETTLEMENT_REQUIRED'));
});

test('five losing trades in Asia/Seoul day halt entries; previous-KST-day loss does not count', () => {
  const now = new Date('2026-10-08T00:00:00.000Z');
  const day = [
    closed('prev', 'KRW-BTC', -200, '2026-10-07T14:59:59.000Z'),
    ...Array.from({ length: 5 }, (_, i) =>
      closed('loss-' + i, 'KRW-BTC', -100, '2026-10-07T15:01:00.000Z')),
  ];
  const result = deriveRulePackPilotCapitalFromTrades(day, now);
  assert.equal(result.dailyLosingTrades, 5);
  assert.ok(decision(result, { estimatedKrw: 20_000, nowMs: now.getTime() })
    .blockers.includes('BACKGROUND_PILOT_DAILY_LOSS_COUNT_LIMIT'));
});
test('realized capital admits KRW net after fees/tax, never estimated foreign FX or unfunded futures PnL', () => {
  assert.deepEqual(verifiedRulePackKrwSettlement({
    market: 'KR_STOCK', currency: 'KRW', grossPnl: 50_500, fees: 300, tax: 200,
  }), { ok: true, netPnlKrw: 50_000 });
  assert.deepEqual(verifiedRulePackKrwSettlement({
    market: 'CRYPTO_SPOT', currency: 'KRW', grossPnl: 51_000, fees: 1_000, tax: null,
  }), { ok: true, netPnlKrw: 50_000 });
  assert.deepEqual(verifiedRulePackKrwSettlement({
    market: 'US_STOCK', currency: 'USD', grossPnl: 50, fees: 1, tax: 0,
  }), { ok: false, code: 'PILOT_CAPITAL_SETTLEMENT_KRW_FX_REQUIRED' });
  assert.deepEqual(verifiedRulePackKrwSettlement({
    market: 'CRYPTO_FUTURES', currency: 'USDT', grossPnl: 100, fees: 1, tax: 0,
  }), { ok: false, code: 'PILOT_CAPITAL_FUTURES_FUNDING_SETTLEMENT_REQUIRED' });
  assert.deepEqual(verifiedRulePackKrwSettlement({
    market: 'KR_STOCK', currency: 'KRW', grossPnl: 50_000, fees: null, tax: 0,
  }), { ok: false, code: 'PILOT_CAPITAL_FEE_EVIDENCE_UNAVAILABLE' });
  assert.deepEqual(verifiedRulePackKrwSettlement({
    market: 'KR_STOCK', currency: 'KRW', grossPnl: 50_000, fees: 100, tax: null,
  }), { ok: false, code: 'PILOT_CAPITAL_KR_TAX_EVIDENCE_UNAVAILABLE' });
  assert.deepEqual(verifiedRulePackKrwSettlement({
    market: 'CRYPTO_SPOT', currency: 'KRW', grossPnl: 50_000, fees: -1, tax: 0,
  }), { ok: false, code: 'PILOT_CAPITAL_FEE_EVIDENCE_UNAVAILABLE' });
});
test('500 order / 200 plan repository page bounds are not proof of complete HWM settlement history', () => {
  assert.equal(rulePackPilotLedgerHistoryComplete(0, 0), true);
  assert.equal(rulePackPilotLedgerHistoryComplete(499, 199), true);
  assert.equal(rulePackPilotLedgerHistoryComplete(500, 199), false);
  assert.equal(rulePackPilotLedgerHistoryComplete(499, 200), false);
  assert.equal(rulePackPilotLedgerHistoryComplete(600, 201), false);
  assert.equal(rulePackPilotLedgerHistoryComplete(-1, 1), false);
  assert.equal(rulePackPilotLedgerHistoryComplete(1.5, 1), false);
});
test('simultaneous closes credit only NET profit rather than arbitrary win-before-loss HWM', () => {
  const instant = '2026-10-07T23:00:00.000Z';
  const a = closed('a-win', 'BTC', 50_000, instant);
  const z = closed('z-loss', '005930', -40_000, instant);
  const result = deriveRulePackPilotCapitalFromTrades([a, z], new Date(NOW));
  const reversed = deriveRulePackPilotCapitalFromTrades([z, a], new Date(NOW));
  assert.equal(result.settlementReady, true);
  assert.equal(result.operatingCapitalKrw, 505_000);
  assert.equal(result.reserveKrw, 5_000);
  assert.equal(result.highWaterMarkKrw, 510_000);
  assert.equal(result.dailyLosingTrades, 1);
  assert.equal(result.consecutiveLosses, 1, 'simultaneous win must not erase a losing trade');
  assert.deepEqual(
    [result.operatingCapitalKrw, result.reserveKrw, result.highWaterMarkKrw],
    [reversed.operatingCapitalKrw, reversed.reserveKrw, reversed.highWaterMarkKrw],
  );
});

test('loss exceeding remaining operating equity blocks further pilot allocation rather than fabricating a refill', () => {
  const result = deriveRulePackPilotCapitalFromTrades([
    closed('loss-more-than-wallet', 'BTCUSDT', -510_000),
  ], new Date(NOW));
  assert.equal(result.operatingCapitalKrw, 0);
  assert.equal(result.reserveKrw, 0);
  assert.equal(result.settlementReady, false);
  assert.ok(result.blockers.includes('PILOT_CAPITAL_NEGATIVE_EQUITY_UNSUPPORTED'));
  assert.ok(decision(result, { estimatedKrw: 20_000 })
    .blockers.includes('BACKGROUND_PILOT_CAPITAL_SETTLEMENT_REQUIRED'));
});
function pilotReceiptInput(estimatedKrw = 525_000): TradingPlanInput {
  return {
    exchange: 'upbit', accountMode: 'live', strategyId: 'CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1',
    signalId: 'receipt-signal', symbol: 'BTC', market: 'KRW', side: 'buy',
    orderType: 'market', quantity: 0.005, quoteAmount: estimatedKrw,
    estimatedKrw, stopPrice: 90_000, targetPrices: [120_000],
    splitRatios: [100], reduceOnly: false, leverage: null, marginMode: null,
    signalReasons: [
      'CANONICAL_PAPER_HANDOFF', 'CANONICAL_LIVE_AUTO_HANDOFF',
      'HANDOFF_ID:paper-auto-handoff:sha256:' + 'a'.repeat(64),
      'STRATEGY_RULE_PACK:CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1',
      'AI_REVIEW_DECISION:PASS',
    ],
    marketSnapshot: { openPositionCount: 0 },
  } as unknown as TradingPlanInput;
}

async function withPilotDynamicCapEnvironment<T>(run: () => Promise<T>) {
  const variables = ['RULE_PACK_PILOT_DYNAMIC_CAP_ENABLED', 'RULE_PACK_PILOT_CAP_ATTESTATION_KEY'] as const;
  const old = variables.map((name) => process.env[name]);
  try {
    process.env.RULE_PACK_PILOT_DYNAMIC_CAP_ENABLED = 'true';
    process.env.RULE_PACK_PILOT_CAP_ATTESTATION_KEY = 'test-only-unpredictable-server-key-'.repeat(3);
    return await run();
  } finally {
    variables.forEach((name, index) => {
      if (old[index] == null) delete process.env[name];
      else process.env[name] = old[index];
    });
  }
}

test('only a fresh server-HMAC bound to exact user, plan, and signal can authorize a 500k compound receipt', async () => {
  await withPilotDynamicCapEnvironment(async () => {
    const user = '11111111-1111-1111-1111-111111111111';
    const plan = pilotReceiptInput();
    const signed = issueRulePackPilotDynamicCapReceipt(user, plan, NOW);
    assert.equal(plan.signalReasons.some(x => x.startsWith('PILOT_DYNAMIC_CAP_V1:')), false);
    assert.equal(verifyRulePackPilotDynamicCapReceipt(user, signed, NOW), true);
    assert.equal(verifyRulePackPilotDynamicCapReceipt(user, signed, NOW + 90_000), true);
    assert.equal(verifyRulePackPilotDynamicCapReceipt(user, signed, NOW + 90_001), false);
    assert.equal(verifyRulePackPilotDynamicCapReceipt(user, signed, NOW - 5_001), false);
    assert.equal(verifyRulePackPilotDynamicCapReceipt('22222222-2222-2222-2222-222222222222', signed, NOW), false);
    assert.equal(verifyRulePackPilotDynamicCapReceipt(user, { ...signed, estimatedKrw: 600_000 }, NOW), false);
    assert.equal(verifyRulePackPilotDynamicCapReceipt(user, { ...signed, symbol: 'ETH' }, NOW), false);
    assert.equal(verifyRulePackPilotDynamicCapReceipt(user, { ...signed, side: 'sell' }, NOW), false);
    assert.equal(verifyRulePackPilotDynamicCapReceipt(user, {
      ...signed, signalReasons: [...signed.signalReasons, ...signed.signalReasons.filter(x => x.startsWith('PILOT_DYNAMIC_CAP_V1:'))],
    }, NOW), false);
    assert.equal(verifyRulePackPilotDynamicCapReceipt(user, {
      ...signed, signalReasons: signed.signalReasons.filter(x => !x.startsWith('HANDOFF_ID:')),
    }, NOW), false);
    process.env.RULE_PACK_PILOT_DYNAMIC_CAP_ENABLED = 'false';
    assert.equal(verifyRulePackPilotDynamicCapReceipt(user, signed, NOW), false);
    process.env.RULE_PACK_PILOT_DYNAMIC_CAP_ENABLED = 'true';
    delete process.env.RULE_PACK_PILOT_CAP_ATTESTATION_KEY;
    assert.equal(verifyRulePackPilotDynamicCapReceipt(user, signed, NOW), false);
    assert.throws(() => issueRulePackPilotDynamicCapReceipt(user, plan, NOW),
      /BACKGROUND_PILOT_DYNAMIC_CAP_SIGNING_KEY_REQUIRED/);
  });
});

test('dynamic policy recheck fails closed on unsigned, too-large or revoked auto plan', async () => {
  await withPilotDynamicCapEnvironment(async () => {
    const user = '11111111-1111-1111-1111-111111111111';
    const repository = new InMemoryTradingRepository();
    const policy = normalizeTradingPolicy({
      ...DEFAULT_TRADING_POLICY,
      mode: 'automatic', automaticEnabled: true, emergencyStopped: false,
      totalCapitalKrw: 500_000, maxOrderKrw: 500_000,
      pilotStage: 'formula-ai-exception',
    });
    const makePlan = (input: TradingPlanInput) => ({
      ...input,
      id: 'pilot-signed-plan', userId: user, idempotencyKey: 'pilot-signed-key',
      executionMode: 'automatic' as const,
      state: 'APPROVAL_PENDING' as const,
      version: 0, approvalExpiresAt: new Date(NOW + 120_000).toISOString(),
      approvedAt: null, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    });
    await assert.rejects(
      resolveRulePackPilotDynamicCapPolicy(repository, user, makePlan(pilotReceiptInput()), policy, new Date(NOW)),
      /BACKGROUND_PILOT_DYNAMIC_CAP_ATTESTATION_REQUIRED/,
    );
    const signed500 = makePlan(issueRulePackPilotDynamicCapReceipt(user, pilotReceiptInput(500_000), NOW));
    const rechecked = await resolveRulePackPilotDynamicCapPolicy(
      repository, user, signed500, policy, new Date(NOW), 0,
    );
    assert.equal(rechecked.maxOrderKrw, 500_000);
    const signed525 = makePlan(issueRulePackPilotDynamicCapReceipt(user, pilotReceiptInput(525_000), NOW));
    await assert.rejects(
      resolveRulePackPilotDynamicCapPolicy(repository, user, signed525, policy, new Date(NOW), 0),
      /BACKGROUND_PILOT_ENTRY_LIMIT/,
    );
    await assert.rejects(
      resolveRulePackPilotDynamicCapPolicy(repository, user, signed500, {
        ...policy, mode: 'approval', automaticEnabled: false,
      }, new Date(NOW), 0),
      /BACKGROUND_PILOT_DYNAMIC_CAP_POLICY_REVOKED/,
    );
    await assert.rejects(
      resolveRulePackPilotDynamicCapPolicy(repository, user, signed500, {
        ...policy, totalCapitalKrw: 100_000, maxOrderKrw: 30_000,
      }, new Date(NOW), 0),
      /BACKGROUND_PILOT_BASE_POLICY_CAPITAL_REQUIRED/,
    );
    await assert.rejects(
      resolveRulePackPilotDynamicCapPolicy(repository, user, signed500, policy, new Date(NOW + 90_001), 0),
      /BACKGROUND_PILOT_DYNAMIC_CAP_ATTESTATION_REQUIRED/,
    );
  });
});

test('manual /plans approval cannot forge the dedicated signed automatic policy origin', async () => {
  await withPilotDynamicCapEnvironment(async () => {
    const user = '11111111-1111-1111-1111-111111111111';
    const repo = new InMemoryTradingRepository();
    const policy = normalizeTradingPolicy({
      ...DEFAULT_TRADING_POLICY, mode: 'automatic', automaticEnabled: true,
      totalCapitalKrw: 500_000, maxOrderKrw: 500_000, pilotStage: 'formula-ai-exception',
    });
    await repo.savePolicy(user, policy);
    const current = pilotReceiptInput();
    await repo.savePlan({
      ...current, id: 'unsigned-over-cap', userId: user, idempotencyKey: 'unsigned-over-cap',
      state: 'APPROVAL_PENDING', version: 0, executionMode: 'automatic',
      approvedAt: null, approvalExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await assert.rejects(
      new TradeAutomationService(repo).beginAutomaticPlan(user, 'unsigned-over-cap'),
      /BACKGROUND_PILOT_DYNAMIC_CAP_ATTESTATION_REQUIRED/,
    );
    assert.equal((await repo.listOrders(user)).length, 0);
  });
});
