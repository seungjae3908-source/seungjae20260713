import type { AnalysisSelection } from './analysis-selection';

export function aiChatSelectionContext(selection: AnalysisSelection | null) {
  return selection ? {
    market: selection.market, symbol: selection.symbol, ticker: selection.ticker,
    displayName: selection.displayName, timeframe: selection.timeframe,
    action: selection.action ?? null, selectedAt: selection.selectedAt,
  } : undefined;
}

type ChatSelectionContext = ReturnType<typeof aiChatSelectionContext>;
const identityFields = ['market', 'symbol', 'ticker', 'timeframe', 'action', 'selectedAt'] as const;

export function aiChatSelectionKey(selection: AnalysisSelection | null): string {
  const context = aiChatSelectionContext(selection);
  return JSON.stringify(identityFields.map(field => context?.[field] ?? null));
}

export function acceptAiChatSelectionReply(echo: unknown, expected: ChatSelectionContext, signal: AbortSignal): boolean {
  if (signal.aborted || !echo || typeof echo !== 'object' || Array.isArray(echo)) return false;
  const actual = echo as Record<string, unknown>;
  return identityFields.every(field => (actual[field] ?? null) === (expected?.[field] ?? null));
}
