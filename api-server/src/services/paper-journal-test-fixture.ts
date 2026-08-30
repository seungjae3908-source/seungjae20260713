import type { PaperJournalEntry } from './paper-trading.types';

// Historical synthetic test fixture, never provider or account evidence.
export function paperJournalFixture(id: string, at: string, overrides: Partial<PaperJournalEntry> = {}): PaperJournalEntry {
  return {
    id, tradeId: `position-${id}`, orderId: `order-${id}`, positionId: `position-${id}`,
    symbol: 'BTCUSDT', side: 'long', orderType: 'market', strategyName: 'fixture', marketRegimeAtEntry: 'fixture',
    submittedAt: at, filledAt: at, closedAt: at, entryPrice: 100, entryReferencePrice: 100, stopLossPrice: 95,
    takeProfitPrice1: null, takeProfitPrice2: null, exitPrice: 101, initialQuantity: 1, closedQuantity: 1,
    remainingQuantity: 0, leverage: 1, notionalValue: 100, requiredMargin: 100, entryFee: 0.1, exitFee: 0.1,
    slippageCost: 0, fundingCost: 0, grossPnl: 1, netPnl: 0.8, rMultiple: 0.16, exitReason: 'manual_close',
    maximumFavorableExcursion: 0, maximumAdverseExcursion: 0,
    dataStatusAtEntry: 'delayed', riskBlocked: false, ruleViolation: false, warnings: [], status: 'closed', note: '',
    ...overrides,
  };
}
