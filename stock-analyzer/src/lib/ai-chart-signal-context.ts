import type { AnalysisSelection } from './analysis-selection';

/** URL-linked scanner identifiers belong ONLY to the exact chart identity.
 * Browser history can retain old ?signalId= when the user edits ticker or
 * switches market/timeframe inside the AI chart.
 */
export function signalIdFromMatchingChartRoute(
  selection: Pick<AnalysisSelection, 'market' | 'ticker' | 'timeframe'>,
  search: string,
): string | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  for (const key of ['signalId', 'market', 'ticker', 'symbol', 'timeframe']) {
    if (params.getAll(key).length > 1) return null;
  }
  const id = params.get('signalId')?.trim() ?? '';
  const market = params.get('market');
  const ticker = params.get('ticker');
  const symbol = params.get('symbol');
  const timeframe = params.get('timeframe');
  if (!id || id.length > 120 || /[<>\u0000-\u001f]/u.test(id)) return null;
  if (market !== selection.market || timeframe !== selection.timeframe) return null;
  if (ticker && symbol && ticker.toUpperCase() !== symbol.toUpperCase()) return null;
  const routeSymbol = (ticker || symbol || '').toUpperCase();
  return routeSymbol === selection.ticker.toUpperCase() ? id : null;
}
