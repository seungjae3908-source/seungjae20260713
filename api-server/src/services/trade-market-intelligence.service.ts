import {
  fetchMarketIntelligence,
  marketIntelligenceTradeDecision,
  tradingMarket,
  type MarketIntelligenceFetchOptions,
} from './market-intelligence-client.service';
import type { TradingPlanInput } from './trade-automation.types';

function normalize(value: unknown) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/gu, '').slice(0, 40);
}

export function marketIntelligenceSymbolForTradingPlan(
  input: Pick<TradingPlanInput, 'exchange' | 'market' | 'symbol'>,
) {
  const symbol = normalize(input.symbol);
  if (input.exchange !== 'upbit' || !symbol || symbol.includes('-')) return symbol;
  const quote = normalize(input.market).split(/[-_]/u)[0] || 'KRW';
  return `${quote}-${symbol}`;
}

export async function fetchTradingPlanMarketIntelligence(
  input: Pick<TradingPlanInput, 'exchange' | 'market' | 'symbol'>,
  options: MarketIntelligenceFetchOptions = {},
) {
  return fetchMarketIntelligence(
    tradingMarket(input),
    marketIntelligenceSymbolForTradingPlan(input),
    options,
  );
}

export { marketIntelligenceTradeDecision };
