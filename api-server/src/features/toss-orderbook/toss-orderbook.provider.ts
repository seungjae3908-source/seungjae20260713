import { normalizeTossOrderbook, type InstrumentOrderbookPayload } from '../../routes/stock-orderbook-core';

export type TossOrderbookVenue = 'auto' | 'kiwoom' | 'toss';
export type TossMarket = 'KR' | 'US';
export type TossMarketTokenProvider = { token(signal?: AbortSignal): Promise<string> };
export type TossMarketTransport = (request: { method: 'GET'; path: '/api/v1/orderbook'; query: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; headers?: Record<string, string>; body: unknown }>;

export function resolveStockVenue(market: TossMarket, requestedVenue: TossOrderbookVenue) {
  if (market === 'KR') return requestedVenue === 'auto' ? 'kiwoom' : requestedVenue;
  if (requestedVenue === 'kiwoom') return null;
  return 'toss' as const;
}

export class TossOrderbookProvider {
  constructor(private readonly tokens: TossMarketTokenProvider, private readonly transport: TossMarketTransport, private readonly now = () => new Date()) {}
  async load(market: TossMarket, symbol: string, signal?: AbortSignal): Promise<InstrumentOrderbookPayload> {
    const token = await this.tokens.token(signal);
    const response = await this.transport({ method: 'GET', path: '/api/v1/orderbook', query: `symbol=${encodeURIComponent(symbol)}`, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal });
    if (response.status === 401) throw new Error('TOSS_ORDERBOOK_AUTH_FAILED');
    if (response.status === 429) throw new Error('TOSS_ORDERBOOK_RATE_LIMITED');
    if (response.status >= 400) throw new Error(`TOSS_ORDERBOOK_HTTP_${response.status}`);
    return normalizeTossOrderbook(market, symbol, response.body, this.now());
  }
}
