import type { PaperTradeResult } from './research-center-product';

export type PaperPromotionTradesReadback = Readonly<{
  trades: readonly PaperTradeResult[];
  closedPaperCycles: number;
  excludedCostIncomplete: number;
  generatedAt: string | null;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Pure: validate the API payload; malformed rows are dropped and counted as excluded, never invented. */
export function parsePaperPromotionTrades(body: unknown): PaperPromotionTradesReadback | null {
  const envelope = record(body);
  const result = record(envelope?.result);
  if (!envelope || envelope.ok !== true || !result || result.executionAuthority !== 'NONE' || !Array.isArray(result.trades)) return null;
  const trades: PaperTradeResult[] = [];
  let malformed = 0;
  for (const raw of result.trades) {
    const row = record(raw);
    if (row && typeof row.symbol === 'string' && row.symbol.length > 0
      && typeof row.netReturnPct === 'number' && Number.isFinite(row.netReturnPct)) {
      trades.push({ symbol: row.symbol, netReturnPct: row.netReturnPct });
    } else malformed += 1;
  }
  const closed = Number.isInteger(result.closedPaperCycles) ? Number(result.closedPaperCycles) : trades.length + malformed;
  const excluded = Number.isInteger(result.excludedCostIncomplete) ? Number(result.excludedCostIncomplete) : 0;
  return Object.freeze({
    trades: Object.freeze(trades),
    closedPaperCycles: closed,
    excludedCostIncomplete: excluded + malformed,
    generatedAt: typeof result.generatedAt === 'string' ? result.generatedAt : null,
  });
}
