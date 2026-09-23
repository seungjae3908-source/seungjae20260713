import { expect, test } from '@playwright/test';
import {
  calculateAutoTradeSafetySnapshot,
  type AutoTradeSafetyJournalEntry,
} from '../src/lib/auto-trading';

const settings = {
  accountValue: 10_000,
  dailyLossLimitPercent: 20,
  maxOpenPositions: 3,
  maxConsecutiveLosses: 2,
  maxDailyOrders: 10,
};

function closed(overrides: Partial<AutoTradeSafetyJournalEntry> = {}): AutoTradeSafetyJournalEntry {
  const now = new Date().toISOString();
  return {
    market: 'US',
    status: 'MANUAL_CLOSE',
    quantity: 1,
    entryPrice: 100,
    openedAt: now,
    closedAt: now,
    ...overrides,
  };
}

test('auto-trading safety blocks when a closed trade has no trustworthy outcome evidence', () => {
  const snapshot = calculateAutoTradeSafetySnapshot([
    closed({ exitPrice: null, profitPercent: null }),
  ], settings, 'US');

  expect(snapshot.allowed).toBe(false);
  expect(snapshot.blockedReason).toContain('종료 거래 손익 근거가 불완전');
  expect(snapshot.consecutiveLosses).toBe(0);
});

test('auto-trading safety derives a missing percent from valid entry and exit prices', () => {
  const snapshot = calculateAutoTradeSafetySnapshot([
    closed({ exitPrice: 90, profitPercent: null }),
  ], settings, 'US');

  expect(snapshot.allowed).toBe(true);
  expect(snapshot.consecutiveLosses).toBe(1);
  expect(snapshot.dailyLossAmount).toBeCloseTo(10);
  expect(snapshot.dailyLossPercent).toBeCloseTo(0.1);
});

test('auto-trading safety keeps explicit closed-trade loss evidence', () => {
  const snapshot = calculateAutoTradeSafetySnapshot([
    closed({ exitPrice: null, profitPercent: -5 }),
  ], settings, 'US');

  expect(snapshot.allowed).toBe(true);
  expect(snapshot.consecutiveLosses).toBe(1);
  expect(snapshot.dailyLossAmount).toBeCloseTo(5);
});
