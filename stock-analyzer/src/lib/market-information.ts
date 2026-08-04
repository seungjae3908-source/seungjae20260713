import type { MemberCapability } from '../../../packages/member-access/src/index.js';

export type MarketInformationId = 'stocks-kr' | 'stocks-us' | 'coins-spot' | 'coins-futures';
export type MarketInformationAsset = 'stock' | 'coin';
export type MarketInformationGroup = '주식' | '코인';

export type MarketInformationRoute = {
  id: MarketInformationId;
  href: string;
  group: MarketInformationGroup;
  label: string;
  shortLabel: string;
  asset: MarketInformationAsset;
  market: 'KR' | 'US' | 'spot' | 'futures';
  exchange: 'KRX' | 'US' | 'UPBIT' | 'BITGET';
  currency: 'KRW' | 'USD' | 'USDT';
  capability: MemberCapability;
};

export const MARKET_INFORMATION_ROUTES: readonly MarketInformationRoute[] = [
  {
    id: 'stocks-kr',
    href: '/stocks/kr',
    group: '주식',
    label: '국내주식 정보',
    shortLabel: '국내',
    asset: 'stock',
    market: 'KR',
    exchange: 'KRX',
    currency: 'KRW',
    capability: 'canAccessBasicInfo',
  },
  {
    id: 'stocks-us',
    href: '/stocks/us',
    group: '주식',
    label: '미국주식 정보',
    shortLabel: '해외',
    asset: 'stock',
    market: 'US',
    exchange: 'US',
    currency: 'USD',
    capability: 'canAccessBasicInfo',
  },
  {
    id: 'coins-spot',
    href: '/coins/spot',
    group: '코인',
    label: '코인 현물 정보',
    shortLabel: '현물',
    asset: 'coin',
    market: 'spot',
    exchange: 'UPBIT',
    currency: 'KRW',
    capability: 'canAccessSpot',
  },
  {
    id: 'coins-futures',
    href: '/coins/futures',
    group: '코인',
    label: '코인 선물 정보',
    shortLabel: '선물',
    asset: 'coin',
    market: 'futures',
    exchange: 'BITGET',
    currency: 'USDT',
    capability: 'canAccessFutures',
  },
] as const;

export function marketInformationRoute(pathname: string): MarketInformationRoute | null {
  const cleanPath = pathname.split('?')[0] || '/';
  return MARKET_INFORMATION_ROUTES.find((route) => cleanPath === route.href) ?? null;
}

export function marketInformationDetailPath(route: MarketInformationRoute, symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (route.asset === 'stock') {
    const params = new URLSearchParams({ asset: 'stock', market: route.market, ticker: normalized });
    return `/stock-info?${params.toString()}`;
  }
  const params = new URLSearchParams({ asset: 'coin', coinMarket: route.market, symbol: normalized });
  return `/stock-info?${params.toString()}`;
}
