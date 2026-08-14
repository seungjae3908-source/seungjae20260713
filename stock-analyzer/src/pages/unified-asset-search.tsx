import { useEffect, useState } from 'react';
import { BarChart3, Search } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { UnifiedAssetSearch } from '@/components/unified-asset-search';
import { useAuth } from '@/lib/auth';
import {
  unifiedAssetDetailPath,
  type UnifiedAssetFilter,
  type UnifiedAssetSuggestion,
  type UnifiedMarketFilter,
} from '@/lib/unified-asset-search';
import {
  ALL_UNIFIED_SEARCH_MARKETS,
  allowedUnifiedSearchMarkets,
  isUnifiedSearchMarketAllowed,
} from '@/lib/unified-search-capability';
import { cn } from '@/lib/utils';

const ASSET_FILTERS: Array<{ key: UnifiedAssetFilter; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'stock', label: '주식' },
  { key: 'coin', label: '코인' },
];

const MARKET_FILTERS: Array<{ key: UnifiedMarketFilter | null; label: string }> = [
  { key: null, label: '모든 시장' },
  { key: 'KR', label: '국내주식' },
  { key: 'US', label: '해외주식' },
  { key: 'spot', label: '현물' },
  { key: 'futures', label: '선물' },
];

export default function UnifiedAssetSearchPage() {
  const [location, navigate] = useLocation();
  const auth = useAuth();
  const [asset, setAsset] = useState<UnifiedAssetFilter>('all');
  const [market, setMarket] = useState<UnifiedMarketFilter | null>(null);
  const e2eAllMarkets = location.startsWith('/__phase11-unified-search-e2e');
  const allowedMarkets = e2eAllMarkets
    ? ALL_UNIFIED_SEARCH_MARKETS
    : allowedUnifiedSearchMarkets({
        canAccessSpot: auth.permissions.canAccessSpot,
        canAccessFutures: auth.permissions.canAccessFutures,
      });
  const canSearchCoin = allowedMarkets.includes('spot') || allowedMarkets.includes('futures');
  const canSearchFutures = allowedMarkets.includes('futures');
  const visibleAssetFilters = ASSET_FILTERS.filter((item) => item.key !== 'coin' || canSearchCoin);
  const visibleMarketFilters = MARKET_FILTERS.filter(
    (item) => item.key == null || isUnifiedSearchMarketAllowed(item.key, allowedMarkets),
  );

  useEffect(() => {
    if (market && !isUnifiedSearchMarketAllowed(market, allowedMarkets)) setMarket(null);
    if (asset === 'coin' && !canSearchCoin) setAsset('all');
  }, [asset, canSearchCoin, market, auth.membershipLevel, e2eAllMarkets]);

  const selectAsset = (next: UnifiedAssetFilter) => {
    if (next === 'coin' && !canSearchCoin) return;
    setAsset(next);
    if (next === 'stock' && (market === 'spot' || market === 'futures')) setMarket(null);
    if (next === 'coin' && (market === 'KR' || market === 'US')) setMarket(null);
  };

  const selectMarket = (next: UnifiedMarketFilter | null) => {
    if (next && !isUnifiedSearchMarketAllowed(next, allowedMarkets)) return;
    setMarket(next);
    if (next === 'KR' || next === 'US') setAsset('stock');
    if (next === 'spot' || next === 'futures') setAsset('coin');
  };

  const openAsset = (item: UnifiedAssetSuggestion) => {
    if (!isUnifiedSearchMarketAllowed(item.market, allowedMarkets)) return;
    navigate(unifiedAssetDetailPath(item, '/search'));
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="shrink-0 border-b border-card-border bg-background/95 px-4 pb-4 pt-5 backdrop-blur">
        <div className="flex items-center justify-center gap-2">
          <Search className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-black">통합 자산 검색</h1>
        </div>
        <p className="mt-1 text-center text-xs font-bold text-muted-foreground">
          {canSearchFutures
            ? '국내·해외주식과 코인 현물·선물을 한 번에 찾습니다.'
            : canSearchCoin
              ? '국내·해외주식과 코인 현물을 한 번에 찾습니다.'
              : '국내·해외주식을 한 번에 찾습니다.'}
        </p>

        <div
          className={cn('mt-4 grid gap-2', visibleAssetFilters.length === 3 ? 'grid-cols-3' : 'grid-cols-2')}
          aria-label="자산 종류 필터"
        >
          {visibleAssetFilters.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={asset === item.key}
              onClick={() => selectAsset(item.key)}
              className={cn(
                'h-11 rounded-xl border px-3 text-sm font-black',
                asset === item.key ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-card text-muted-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="mt-3 flex snap-x gap-2 overflow-x-auto pb-1" aria-label="시장 필터">
          {visibleMarketFilters.map((item) => (
            <button
              key={item.label}
              type="button"
              aria-pressed={market === item.key}
              onClick={() => selectMarket(item.key)}
              className={cn(
                'h-11 shrink-0 snap-start rounded-xl border px-4 text-sm font-black',
                market === item.key ? 'border-primary bg-primary/10 text-primary' : 'border-card-border bg-card text-muted-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-28 pt-5">
        <UnifiedAssetSearch
          asset={asset}
          market={market}
          allowedMarkets={allowedMarkets}
          autoFocus
          onSelect={openAsset}
        />

        <section className="mt-6 rounded-2xl border border-card-border bg-card p-4">
          <h2 className="text-sm font-black">검색 가능한 입력</h2>
          <p className="mt-2 break-keep text-xs font-bold leading-relaxed text-muted-foreground">
            {canSearchFutures
              ? '한글명, 영문명, 종목코드, 티커, 코인 심볼, BTC/KRW·BTC-KRW·BTCUSDT 형태와 한글 초성을 지원합니다.'
              : canSearchCoin
                ? '한글명, 영문명, 종목코드, 티커, 코인 심볼, BTC/KRW·BTC-KRW 형태와 한글 초성을 지원합니다.'
                : '한글명, 영문명, 종목코드, 티커와 한글 초성을 지원합니다.'}
          </p>
        </section>

        <button
          type="button"
          onClick={() => navigate('/market-rankings')}
          className="mt-4 flex min-h-14 w-full items-center gap-3 rounded-2xl border border-card-border bg-card px-4 text-left"
        >
          <BarChart3 className="h-5 w-5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-black">시장 순위 보기</span>
            <span className="mt-0.5 block text-xs font-bold text-muted-foreground">시가총액·거래량·급상승 종목은 별도 목록에서 확인합니다.</span>
          </span>
        </button>
      </main>
      <BottomNav />
    </div>
  );
}
