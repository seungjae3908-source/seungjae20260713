import type { PaperJournalEntry, PaperOrder, PaperFill } from './paper-trading';

// Historical synthetic record, used only by storage/sync tests, never runtime data.
export function paperJournalFixture(id: string, at: string, overrides: Partial<PaperJournalEntry> = {}): PaperJournalEntry {
  return {
    id, tradeId: `position-${id}`, orderId: `order-${id}`, positionId: `position-${id}`,
    symbol: 'BTCUSDT', side: 'long', orderType: 'market', strategyName: 'fixture', marketRegimeAtEntry: 'fixture',
    submittedAt: at, filledAt: at, closedAt: at, entryPrice: 100, stopLossPrice: 95,
    takeProfitPrice1: null, takeProfitPrice2: null, exitPrice: 101, initialQuantity: 1, closedQuantity: 1,
    remainingQuantity: 0, leverage: 1, notionalValue: 100, requiredMargin: 100, entryFee: 0.1, exitFee: 0.1,
    slippageCost: 0, fundingCost: 0, grossPnl: 1, netPnl: 0.8, rMultiple: 0.16, exitReason: 'manual_close',
    dataStatusAtEntry: 'delayed', riskBlocked: false, ruleViolation: false, warnings: [], status: 'closed', note: '',
    ...overrides,
  };
}

export function paperOrderFixture(id: string, at: string): PaperOrder {
  return { id, symbol: 'BTCUSDT', side: 'long', orderType: 'limit', status: 'pending', requestedPrice: 100,
    triggerPrice: null, quantity: 1, leverage: 1, stopLossPrice: 95, takeProfitPrice1: null, takeProfitPrice2: null,
    submittedAt: at, filledAt: null, cancelledAt: null, rejectionCodes: [], warnings: [], riskResult: null,
    mode: 'paper-only', orderSubmitted: false, exchangeRequestSent: false };
}

export function paperFillFixture(id: string, at: string): PaperFill {
  return { id, orderId: `order-${id}`, positionId: `position-${id}`, side: 'long', fillReason: 'market',
    price: 100, quantity: 1, grossValue: 100, referencePrice: 100, fee: 0.1, slippageCost: 0, fundingCost: 0,
    grossPnl: 0, netPnl: -0.1, filledAt: at };
}
