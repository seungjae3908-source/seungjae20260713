import type { CanonicalTradingMarket, CanonicalTradingProvider } from './three-provider-predeploy-readiness.service';

export type CanonicalProviderAction =
  | 'ACCOUNT_READ'
  | 'HOLDINGS_OR_POSITIONS_READ'
  | 'ORDER_CREATE'
  | 'ORDER_QUERY'
  | 'ORDER_CANCEL'
  | 'ORDER_MODIFY'
  | 'ORDER_CANCEL_REPLACE';

export type CanonicalProviderActionContract = {
  provider: CanonicalTradingProvider;
  markets: readonly CanonicalTradingMarket[];
  actions: readonly CanonicalProviderAction[];
  directions: readonly ('BUY' | 'SELL' | 'LONG' | 'SHORT')[];
  sellRequiresExistingPosition: boolean;
  futuresOnly: boolean;
};

export const CANONICAL_PROVIDER_ACTIONS: Readonly<Record<CanonicalTradingProvider, CanonicalProviderActionContract>> = Object.freeze({
  toss: Object.freeze({
    provider: 'toss',
    markets: ['KR_STOCK', 'US_STOCK'] as const,
    actions: ['ACCOUNT_READ', 'HOLDINGS_OR_POSITIONS_READ', 'ORDER_CREATE', 'ORDER_QUERY', 'ORDER_CANCEL', 'ORDER_MODIFY'] as const,
    directions: ['BUY', 'SELL'] as const,
    sellRequiresExistingPosition: true,
    futuresOnly: false,
  }),
  upbit: Object.freeze({
    provider: 'upbit',
    markets: ['CRYPTO_SPOT'] as const,
    actions: ['ACCOUNT_READ', 'HOLDINGS_OR_POSITIONS_READ', 'ORDER_CREATE', 'ORDER_QUERY', 'ORDER_CANCEL', 'ORDER_CANCEL_REPLACE'] as const,
    directions: ['BUY', 'SELL'] as const,
    sellRequiresExistingPosition: true,
    futuresOnly: false,
  }),
  bitget: Object.freeze({
    provider: 'bitget',
    markets: ['CRYPTO_FUTURES'] as const,
    actions: ['ACCOUNT_READ', 'HOLDINGS_OR_POSITIONS_READ', 'ORDER_CREATE', 'ORDER_QUERY', 'ORDER_CANCEL', 'ORDER_MODIFY'] as const,
    directions: ['LONG', 'SHORT'] as const,
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
