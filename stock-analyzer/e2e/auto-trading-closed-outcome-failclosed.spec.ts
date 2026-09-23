import { expect, test, type Page } from '@playwright/test';

type AutoTradeSafetyJournalEntry = {
  market: 'US';
  status: 'MANUAL_CLOSE';
  quantity: number;
  entryPrice: number;
  exitPrice?: number | null;
  profitPercent?: number | null;
  openedAt: string;
  closedAt?: string | null;
};

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

async function calculateSnapshot(page: Page, entries: AutoTradeSafetyJournalEntry[]) {
  await page.goto('/');
  return page.evaluate(async ({ entries, settings }) => {
    const modulePath = '/src/lib/auto-trading.ts';
    const module = await import(modulePath) as {
      calculateAutoTradeSafetySnapshot: (
        entries: AutoTradeSafetyJournalEntry[],
        settings: typeof settings,
        market: 'US',
      ) => {
        allowed: boolean;
        blockedReason: string | null;
        consecutiveLosses: number;
        dailyLossAmount: number;
        dailyLossPercent: number;
      };
    };

    return module.calculateAutoTradeSafetySnapshot(entries, settings, 'US');
  }, { entries, settings });
}

test('auto-trading safety blocks when a closed trade has no trustworthy outcome evidence', async ({ page }) => {
  const snapshot = await calculateSnapshot(page, [
    closed({ exitPrice: null, profitPercent: null }),
  ]);

  expect(snapshot.allowed).toBe(false);
  expect(snapshot.blockedReason).toContain('종료 거래 손익 근거가 불완전');
  expect(snapshot.consecutiveLosses).toBe(0);
});

test('auto-trading safety derives a missing percent from valid entry and exit prices', async ({ page }) => {
  const snapshot = await calculateSnapshot(page, [
    closed({ exitPrice: 90, profitPercent: null }),
  ]);

  expect(snapshot.allowed).toBe(true);
  expect(snapshot.consecutiveLosses).toBe(1);
  expect(snapshot.dailyLossAmount).toBeCloseTo(10);
  expect(snapshot.dailyLossPercent).toBeCloseTo(0.1);
});

test('auto-trading safety keeps explicit closed-trade loss evidence', async ({ page }) => {
  const snapshot = await calculateSnapshot(page, [
    closed({ exitPrice: null, profitPercent: -5 }),
  ]);

  expect(snapshot.allowed).toBe(true);
  expect(snapshot.consecutiveLosses).toBe(1);
  expect(snapshot.dailyLossAmount).toBeCloseTo(5);
});
