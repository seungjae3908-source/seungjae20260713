import type { CanonicalTradingMarket, CanonicalTradingProvider } from './three-provider-predeploy-readiness.service';

export type CanonicalProviderAction =
  | 'ACCOUNT_READ'
  | 'HOLDINGS_OR_POSITIONS_READ'
  | 'ORDER_CREATE'
  | 'ORDER_QUERY'
  | 'ORDER_CANCEL'
  | 'ORDER_MODIFY';

export type CanonicalProviderActionContract = {
  provider: CanonicalTradingProvider;
  markets: CanonicalTradingMarket[];
  actions: CanonicalProviderAction[];
  directions: Array<'BUY' | 'SELL' | 'LONG' | 'SHORT'>;
  sellRequiresExistingPosition: boolean;
  futuresOnly: boolean;
};

export const CANONICAL_PROVIDER_ACTIONS: Readonly<Record<CanonicalTradingProvider, CanonicalProviderActionContract>> = Object.freeze({
  toss: Object.freeze({
    provider: 'toss',
    markets: ['KR_STOCK', 'US_STOCK'],
    actions: ['ACCOUNT_READ', 'HOLDINGS_OR_POSITIONS_READ', 'ORDER_CREATE', 'ORDER_QUERY', 'ORDER_CANCEL', 'ORDER_MODIFY'],
    directions: ['BUY', 'SELL'],
    sellRequiresExistingPosition: true,
    futuresOnly: false,
  }),
  upbit: Object.freeze({
    provider: 'upbit',
    markets: ['CRYPTO_SPOT'],
    actions: ['ACCOUNT_READ', 'HOLDINGS_OR_POSITIONS_READ', 'ORDER_CREATE', 'ORDER_QUERY', 'ORDER_CANCEL'],
    directions: ['BUY', 'SELL'],
    sellRequiresExistingPosition: true,
    futuresOnly: false,
  }),
  bitget: Object.freeze({
    provider: 'bitget',
    markets: ['CRYPTO_FUTURES'],
    actions: ['ACCOUNT_READ', 'HOLDINGS_OR_POSITIONS_READ', 'ORDER_CREATE', 'ORDER_QUERY', 'ORDER_CANCEL'],
    directions: ['LONG', 'SHORT'],
    sellRequiresExistingPosition: false,
    futuresOnly: true,
  }),
});

export function providerSupportsAction(provider: CanonicalTradingProvider, action: CanonicalProviderAction): boolean {
  return CANONICAL_PROVIDER_ACTIONS[provider].actions.includes(action);
}

export function providerSupportsMarket(provider: CanonicalTradingProvider, market: CanonicalTradingMarket): boolean {
  return CANONICAL_PROVIDER_ACTIONS[provider].markets.includes(market);
}

export function providerSupportsDirection(
  provider: CanonicalTradingProvider,
  direction: 'BUY' | 'SELL' | 'LONG' | 'SHORT',
): boolean {
  return CANONICAL_PROVIDER_ACTIONS[provider].directions.includes(direction);
}
