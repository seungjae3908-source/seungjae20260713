import { selectionQuery, type AnalysisMarket, type AnalysisSelection } from './analysis-selection';

/** Read-only navigation only. Never infer a recommendation, position or order direction. */
const MARKET_MAP: Record<string, AnalysisMarket> = {
  KR: 'KR', US: 'US', UPBIT: 'UPBIT', BITGET: 'BITGET',
  KR_STOCK: 'KR', US_STOCK: 'US', CRYPTO_SPOT: 'UPBIT', CRYPTO_FUTURES: 'BITGET',
};

export function readOnlyChartTarget(marketInput: string, symbolInput: string, displayName?: string): { selection: AnalysisSelection; href: string } | null {
  const market = MARKET_MAP[String(marketInput ?? '').trim().toUpperCase()];
  if (!market || typeof symbolInput !== 'string') return null;
  let symbol = symbolInput.trim().toUpperCase();
  // Upbit's canonical public chart symbol uses BTC, not KRW-BTC.
  if (market === 'UPBIT' && symbol.startsWith('KRW-')) symbol = symbol.slice(4);
  if (!/^[A-Z0-9^][A-Z0-9._^-]{0,31}$/.test(symbol)) return null;
  if (market === 'KR' && !/^[0-9]{6}$/.test(symbol)) return null;
  if (market === 'BITGET' && !/^[A-Z0-9]{3,32}$/.test(symbol)) return null;
  const name = typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 120) : symbol;
  const selection: AnalysisSelection = {
    assetType: market === 'UPBIT' ? 'coin_spot' : market === 'BITGET' ? 'coin_futures' : 'stock',
    market, symbol, ticker: symbol, displayName: name,
    timeframe: market === 'KR' || market === 'US' ? '1D' : '15m',
    selectedAt: new Date().toISOString(),
  };
  return { selection, href: `/ai-chart?${selectionQuery(selection)}` };
}
