/** Canonical stock-analysis route defaults to analysis; explicit user tabs win. */
export type StockDetailRouteTab = 'summary' | 'chart' | 'news' | 'analysis';
export function resolveStockDetailTab(pathname: string, requested: string | null): StockDetailRouteTab {
  if (requested === 'summary' || requested === 'chart' || requested === 'news' || requested === 'analysis') return requested;
  return (pathname.replace(/\/+$/, '') || '/') === '/stock-info/analysis' ? 'analysis' : 'summary';
}
