import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveRulePackPilotCapitalFromTrades,
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
