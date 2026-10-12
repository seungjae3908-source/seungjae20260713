import type { AnalysisAssetType, AnalysisMarket, AnalysisTradeAction, AnalysisSelection } from './analysis-selection';

export type TradeFocus = 'entry' | 'exit';

export type TradeChartNavigationInput = {
  assetType: AnalysisAssetType;
  market: AnalysisMarket;
  symbol: string;
  displayName: string;
  action: AnalysisTradeAction;
  focus: TradeFocus;
  timeframe?: string;
};

function clean(value: string, maximum: number) {
  return value.trim().slice(0, maximum);
}

function assertCanonicalPair(input: TradeChartNavigationInput) {
  const pairValid = input.assetType === 'stock'
    ? input.market === 'KR' || input.market === 'US'
    : input.assetType === 'coin_spot'
      ? input.market === 'UPBIT'
      : input.market === 'BITGET';
  if (!pairValid) throw new Error('TRADE_NAVIGATION_MARKET_ASSET_MISMATCH');

  if (input.market === 'BITGET') {
    if (input.focus !== 'entry' || (input.action !== 'LONG' && input.action !== 'SHORT')) {
      throw new Error('TRADE_NAVIGATION_FUTURES_DIRECTION_INVALID');
    }
    return;
  }

  if (input.focus === 'entry' && input.action !== 'BUY') {
    throw new Error('TRADE_NAVIGATION_ENTRY_DIRECTION_INVALID');
  }
  if (input.focus === 'exit' && input.action !== 'SELL') {
    throw new Error('TRADE_NAVIGATION_EXIT_DIRECTION_INVALID');
  }
}

export function tradeChartPath(input: TradeChartNavigationInput): string {
  assertCanonicalPair(input);
  const symbol = clean(input.symbol, 32).toUpperCase();
  const displayName = clean(input.displayName || symbol, 120);
  const timeframe = clean(input.timeframe || '5m', 12);
  if (!symbol) throw new Error('TRADE_NAVIGATION_SYMBOL_REQUIRED');
  if (!displayName) throw new Error('TRADE_NAVIGATION_NAME_REQUIRED');
  if (!timeframe) throw new Error('TRADE_NAVIGATION_TIMEFRAME_REQUIRED');

  const params = new URLSearchParams({
    assetType: input.assetType,
    market: input.market,
    symbol,
    ticker: symbol,
    name: displayName,
    timeframe,
    action: input.action,
    trade: input.focus,
    source: 'stock-info',
  });
  return `/ai-chart?${params.toString()}`;
}

export function tradeFocusFromSearch(search: string): TradeFocus | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const value = params.get('trade');
  return value === 'entry' || value === 'exit' ? value : null;
}

export function tradeActionFromSearch(search: string): AnalysisTradeAction | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const focus = tradeFocusFromSearch(search);
  const market = params.get('market');
  const action = params.get('action') as AnalysisTradeAction | null;
  if (!focus || !market || !action) return null;

  if (market === 'BITGET') {
    return focus === 'entry' && (action === 'LONG' || action === 'SHORT') ? action : null;
  }
  if (!['KR', 'US', 'UPBIT'].includes(market)) return null;
  if (focus === 'entry') return action === 'BUY' ? action : null;
  return action === 'SELL' ? action : null;
}

// A fresh trade intent is not a scanner signal. Never copy cached search IDs,
// stale targets, confidence, or reasons into a manually opened trade cockpit.
export function isolateTradeChartSelection(route: AnalysisSelection, action: AnalysisTradeAction): AnalysisSelection {
  return {
    assetType: route.assetType,
    market: route.market,
    symbol: route.symbol,
    ticker: route.ticker,
    displayName: route.displayName,
    timeframe: route.timeframe,
    selectedAt: route.selectedAt,
    action,
  };
}
