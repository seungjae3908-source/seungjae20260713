import type { PaperJournalEntry, PaperTradingAction, PaperTradingActionResult, PaperTradingState, PaperTradingStatistics } from './paper-trading.types';
import { MODE, PaperTradingError, cloneState, markEvent, normalizedRiskState, validateEventId, validateState } from './paper-trading-core.service';
import { cancelOrder, evaluatePlacePaperOrder, markPrice } from './paper-trading-position.service';
import { closePosition, processCandle } from './paper-trading-candle.service';
export type * from './paper-trading.types';
export { PaperTradingError, createPaperTradingState } from './paper-trading-core.service';
export { transitionPaperOrder } from './paper-trading-position.service';

export function applyPaperTradingAction(
  inputState: PaperTradingState,
  action: PaperTradingAction,
  now = new Date(),
): PaperTradingActionResult {
  validateState(inputState);
  validateEventId(action.eventId);
  const state = cloneState(inputState);
  state.riskState = normalizedRiskState(state.riskState, now);
  if (state.processedEventIds.includes(action.eventId)) {
    return {
      ok: true,
      mode: MODE,
      orderSubmitted: false,
      exchangeRequestSent: false,
      state,
      order: null,
      position: null,
      fills: [],
      warnings: ['이미 처리된 이벤트이므로 중복 체결하지 않았습니다.'],
      duplicateEvent: true,
    };
  }

  let result: PaperTradingActionResult;
  if (action.type === 'place_order') result = evaluatePlacePaperOrder(state, action, now);
  else if (action.type === 'cancel_order') result = cancelOrder(state, action, now);
  else if (action.type === 'process_candle') result = processCandle(state, action, now);
  else if (action.type === 'mark_price') result = markPrice(state, action, now);
  else result = closePosition(state, action, now);

  markEvent(result.state, action.eventId);
  result.state.updatedAt = now.toISOString();
  assertFinitePaperState(result.state);
  return result;
}

export function assertFinitePaperState(state: PaperTradingState) {
  const visit = (value: unknown, path: string) => {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new PaperTradingError('NON_FINITE_CALCULATION', `${path} 계산값이 유한수가 아닙니다.`, 500);
    }
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`));
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) visit(item, `${path}.${key}`);
    }
  };
  visit(state, 'state');
}

function groupStatistics(entries: PaperJournalEntry[], selector: (entry: PaperJournalEntry) => string) {
  const map = new Map<string, PaperJournalEntry[]>();
  for (const entry of entries) {
    const key = selector(entry);
    map.set(key, [...(map.get(key) ?? []), entry]);
  }
  return [...map.entries()]
    .map(([key, items]) => {
      const wins = items.filter((item) => item.netPnl > 0).length;
      const losses = items.filter((item) => item.netPnl < 0).length;
      return {
        key,
        trades: items.length,
        wins,
        losses,
        winRate: items.length ? wins / items.length * 100 : 0,
        netPnl: items.reduce((sum, item) => sum + item.netPnl, 0),
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

export function calculatePaperTradingStatistics(journal: readonly PaperJournalEntry[]): PaperTradingStatistics {
  const entries = journal.filter((entry) => entry.status === 'closed');
  const profits = entries.filter((entry) => entry.netPnl > 0);
  const losses = entries.filter((entry) => entry.netPnl < 0);
  const grossProfit = profits.reduce((sum, entry) => sum + entry.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, entry) => sum + entry.netPnl, 0));
  let winStreak = 0;
  let lossStreak = 0;
  let maximumConsecutiveWins = 0;
  let maximumConsecutiveLosses = 0;
  for (const entry of [...entries].sort((a, b) => Date.parse(a.closedAt ?? a.filledAt) - Date.parse(b.closedAt ?? b.filledAt))) {
    if (entry.netPnl > 0) {
      winStreak += 1;
      lossStreak = 0;
    } else if (entry.netPnl < 0) {
      lossStreak += 1;
      winStreak = 0;
    } else {
      winStreak = 0;
      lossStreak = 0;
    }
    maximumConsecutiveWins = Math.max(maximumConsecutiveWins, winStreak);
    maximumConsecutiveLosses = Math.max(maximumConsecutiveLosses, lossStreak);
  }
  const total = entries.length;
  const net = entries.reduce((sum, entry) => sum + entry.netPnl, 0);
  return {
    totalTrades: total,
    wins: profits.length,
    losses: losses.length,
    winRate: total ? profits.length / total * 100 : 0,
    averageProfit: profits.length ? grossProfit / profits.length : 0,
    averageLoss: losses.length ? -grossLoss / losses.length : 0,
    expectancy: total ? net / total : 0,
    averageR: total ? entries.reduce((sum, entry) => sum + (entry.rMultiple ?? 0), 0) / total : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    maximumConsecutiveWins,
    maximumConsecutiveLosses,
    cumulativeNetPnl: net,
    totalFees: entries.reduce((sum, entry) => sum + entry.entryFee + entry.exitFee, 0),
    totalSlippage: entries.reduce((sum, entry) => sum + entry.slippageCost, 0),
    totalFunding: entries.reduce((sum, entry) => sum + entry.fundingCost, 0),
    bySide: groupStatistics(entries, (entry) => entry.side),
    bySymbol: groupStatistics(entries, (entry) => entry.symbol),
    byHour: groupStatistics(entries, (entry) => String(new Date(entry.filledAt).getUTCHours()).padStart(2, '0')),
    byExitReason: groupStatistics(entries, (entry) => entry.exitReason ?? 'unknown'),
  };
}

export function sanitizePaperJournalNote(value: unknown) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, 2_000);
}
