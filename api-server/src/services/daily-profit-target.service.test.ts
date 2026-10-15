import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dailyProfitTargetEvidenceReason,
  evaluateDailyProfitTarget,
  parseDailyProfitTargetEvidenceReason,
  tradingDayKeyForMarket,
} from './daily-profit-target.service';
import { normalizeTradingPolicy } from './trade-automation-risk.service';
import { DEFAULT_TRADING_POLICY } from './trade-automation.types';

const policy = (targetPercent: number, afterTargetAction: 'STOP_NEW_ENTRIES' | 'PROFIT_PROTECTION' | 'NOTIFY_ONLY') => ({
  enabled: true, targetPercent, afterTargetAction,
});

test('3% target is decided from settled net profit and stop mode resets by the market trading day', () => {
  const before = evaluateDailyProfitTarget({
    market: 'crypto_spot', policy: policy(3, 'STOP_NEW_ENTRIES'), baseCapitalKrw: 500_000,
    realizedNetProfitKrw: 14_999.99, unrealizedPnlKrw: 50_000,
    cumulativeHighNetProfitKrw: 50_000, settlementEvidenceReady: true,
    now: '2026-10-14T14:59:59.000Z',
  });
  assert.equal(before.targetReached, false, 'unrealized profit cannot certify the target');
  assert.equal(before.newEntryAllowed, true);
  const reached = evaluateDailyProfitTarget({
    market: 'crypto_spot', policy: policy(3, 'STOP_NEW_ENTRIES'), baseCapitalKrw: 500_000,
    realizedNetProfitKrw: 15_000, unrealizedPnlKrw: -1_000,
    cumulativeHighNetProfitKrw: 20_000, settlementEvidenceReady: true,
    now: '2026-10-14T14:59:59.000Z',
  });
  assert.equal(reached.tradingDay, '2026-10-14');
  assert.equal(reached.targetReached, true);
  assert.equal(reached.newEntryBlockReason, 'DAILY_PROFIT_TARGET_REACHED_STOP_NEW_ENTRIES');
  assert.equal(tradingDayKeyForMarket('crypto_spot', '2026-10-14T15:00:01.000Z'), '2026-10-15');
  const nextDay = evaluateDailyProfitTarget({
    market: 'crypto_spot', policy: policy(3, 'STOP_NEW_ENTRIES'), baseCapitalKrw: 500_000,
    realizedNetProfitKrw: 0, unrealizedPnlKrw: 0,
    cumulativeHighNetProfitKrw: 20_000, settlementEvidenceReady: true,
    now: '2026-10-14T15:00:01.000Z',
  });
  assert.equal(nextDay.newEntryAllowed, true);
  assert.equal(nextDay.highNetProfitKrw, 20_000, 'daily reset must retain the cumulative high-water profit');
});

test('100% desired target never expands risk and alert-only continues inside existing limits', () => {
  const state = evaluateDailyProfitTarget({
    market: 'crypto_futures', policy: policy(100, 'NOTIFY_ONLY'), baseCapitalKrw: 500_000,
    realizedNetProfitKrw: 500_000, unrealizedPnlKrw: 10_000,
    cumulativeHighNetProfitKrw: 500_000, settlementEvidenceReady: true,
    now: '2026-10-14T23:59:59.000Z', plannedRiskKrw: 50_000,
  });
  assert.equal(state.targetReached, true);
  assert.equal(state.newEntryAllowed, true);
  assert.equal(state.riskLimitsExpanded, false);
  assert.equal(state.protectionRiskBudgetKrw, null);
  assert.equal(tradingDayKeyForMarket('crypto_futures', '2026-10-15T00:00:01.000Z'), '2026-10-15');
});

test('profit protection requires a strengthened signal and risks only settled surplus', () => {
  const base = {
    market: 'us_stock' as const, policy: policy(5, 'PROFIT_PROTECTION'), baseCapitalKrw: 500_000,
    realizedNetProfitKrw: 27_000, unrealizedPnlKrw: -500,
    cumulativeHighNetProfitKrw: 30_000, settlementEvidenceReady: true,
    now: '2026-10-14T15:00:00.000Z', plannedRiskKrw: 500,
  };
  const weak = evaluateDailyProfitTarget({ ...base, strengthenedSignalQualified: false });
  assert.equal(weak.newEntryBlockReason, 'DAILY_PROFIT_TARGET_STRENGTHENED_SIGNAL_REQUIRED');
  const strong = evaluateDailyProfitTarget({ ...base, strengthenedSignalQualified: true });
  assert.equal(strong.protectionRiskBudgetKrw, 1_250);
  assert.equal(strong.newEntryAllowed, true);
  const giveback = evaluateDailyProfitTarget({ ...base, unrealizedPnlKrw: -2_000, strengthenedSignalQualified: true });
  assert.equal(giveback.protectionRiskBudgetKrw, 0);
  assert.equal(giveback.newEntryBlockReason, 'DAILY_PROFIT_TARGET_PROTECTION_RISK_BUDGET_EXCEEDED');
});

test('market day keys are isolated across Seoul, New York and UTC', () => {
  const instant = '2026-10-14T15:30:00.000Z';
  assert.equal(tradingDayKeyForMarket('domestic_stock', instant), '2026-10-15');
  assert.equal(tradingDayKeyForMarket('crypto_spot', instant), '2026-10-15');
  assert.equal(tradingDayKeyForMarket('us_stock', instant), '2026-10-14');
  assert.equal(tradingDayKeyForMarket('crypto_futures', instant), '2026-10-14');
});

test('enabled target fails closed when settled full-cost evidence is missing', () => {
  const state = evaluateDailyProfitTarget({
    market: 'domestic_stock', policy: policy(3.5, 'NOTIFY_ONLY'), baseCapitalKrw: 1_000_000,
    realizedNetProfitKrw: null, unrealizedPnlKrw: null, cumulativeHighNetProfitKrw: null,
    settlementEvidenceReady: false, now: '2026-10-14T00:00:00.000Z',
  });
  assert.equal(state.newEntryAllowed, false);
  assert.equal(state.newEntryBlockReason, 'DAILY_PROFIT_TARGET_SETTLEMENT_EVIDENCE_REQUIRED');
});

test('policy normalization preserves decimal 3% and 100% targets independently across four markets', () => {
  const normalized = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    dailyProfitTargetByMarket: {
      domestic_stock: { enabled: true, targetPercent: 3, afterTargetAction: 'STOP_NEW_ENTRIES' },
      us_stock: { enabled: true, targetPercent: 100, afterTargetAction: 'NOTIFY_ONLY' },
      crypto_spot: { enabled: true, targetPercent: 3.75, afterTargetAction: 'PROFIT_PROTECTION' },
      crypto_futures: { enabled: false, targetPercent: 10.5, afterTargetAction: 'PROFIT_PROTECTION' },
    },
  });
  assert.equal(normalized.dailyProfitTargetByMarket.domestic_stock.targetPercent, 3);
  assert.equal(normalized.dailyProfitTargetByMarket.us_stock.targetPercent, 100);
  assert.equal(normalized.dailyProfitTargetByMarket.crypto_spot.targetPercent, 3.75);
  assert.equal(normalized.dailyProfitTargetByMarket.crypto_futures.enabled, false);
  assert.equal(normalized.maxOrderKrw, DEFAULT_TRADING_POLICY.maxOrderKrw);
  assert.equal(normalized.bitgetLeverage, DEFAULT_TRADING_POLICY.bitgetLeverage);
  assert.equal(normalized.dailyLossLimitPercent, DEFAULT_TRADING_POLICY.dailyLossLimitPercent);
  const legacy = normalizeTradingPolicy({ ...DEFAULT_TRADING_POLICY, dailyProfitTargetByMarket: undefined });
  assert.equal(Object.values(legacy.dailyProfitTargetByMarket).every((row) => row.enabled === false), true);
});

test('short-lived target evidence is exact-market, exact-day and tamper evident at the signed-plan boundary', () => {
  const observedAtMs = Date.parse('2026-10-14T10:00:00.000Z');
  const reason = dailyProfitTargetEvidenceReason({
    market: 'us_stock', tradingDay: '2026-10-14', realizedNetProfitKrw: 15_000,
    unrealizedPnlKrw: -100, strengthenedSignalQualified: true,
    plannedRiskKrw: 400, observedAtMs,
  });
  assert.equal(parseDailyProfitTargetEvidenceReason([reason], observedAtMs + 1_000).market, 'us_stock');
  assert.throws(() => parseDailyProfitTargetEvidenceReason([reason], observedAtMs + 90_001),
    /DAILY_PROFIT_TARGET_EVIDENCE_INVALID/);
  assert.throws(() => parseDailyProfitTargetEvidenceReason([reason, reason], observedAtMs),
    /DAILY_PROFIT_TARGET_EVIDENCE_REQUIRED/);
});
