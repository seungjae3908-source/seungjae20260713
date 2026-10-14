import type { AnalysisMarket } from './analysis-selection';
import type { AiChartPositionOverlay } from '@/components/ai-chart-position-panel';

// Bind display-only price lines to the exact verified account instrument.
// This function neither reads private APIs nor grants order authority.
function canonicalSymbol(value: string, market: AnalysisMarket): string {
  const normalized = value.trim().toUpperCase();
  const base = market === 'UPBIT' ? normalized.replace(/^KRW[-/]/, '') : normalized;
  return base.replace(/[^A-Z0-9]/g, '');
}

export function positionOverlayForChart(
  candidate: AiChartPositionOverlay | null | undefined,
  market: AnalysisMarket,
  symbol: string,
): AiChartPositionOverlay | null {
  if (!candidate || !symbol.trim() || candidate.position.market.trim().toUpperCase() !== market) return null;
  if (market === 'UPBIT' && candidate.provider !== 'upbit') return null;
  if (market === 'BITGET' && candidate.provider !== 'bitget') return null;
  if ((market === 'KR' || market === 'US') && candidate.provider !== 'toss' && candidate.provider !== 'kiwoom') return null;
  const expected = canonicalSymbol(symbol, market);
  const observed = canonicalSymbol(candidate.position.symbol, market);
  if (!expected || !observed || expected !== observed) return null;
  const quantity = candidate.position.quantity;
  if (quantity == null || !Number.isFinite(quantity) || Math.abs(quantity) <= 0) return null;
  return candidate;
}
