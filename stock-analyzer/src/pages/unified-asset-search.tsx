import { useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { CenteredPageHeader } from '@/components/centered-page-header';
import { UnifiedAssetSearch } from '@/components/unified-asset-search';
import { useAssetMode } from '@/lib/asset-mode';
import {
  unifiedAssetDetailPath,
  type UnifiedAssetFilter,
  type UnifiedAssetSuggestion,
  type UnifiedMarketFilter,
} from '@/lib/unified-asset-search';
import { cn } from '@/lib/utils';

const MARKET_FILTERS: Array<{ key: UnifiedMarketFilter | null; label: string }> = [
  { key: null, label: '전체' },
  { key: 'KR', label: '국내' },
  { key: 'US', label: '미국' },
  { key: 'spot', label: '코인 현물' },
  { key: 'futures', label: '코인 선물' },
];

function assetForMarket(market: UnifiedMarketFilter | null): UnifiedAssetFilter {
  if (market === 'KR' || market === 'US') return 'stock';
  if (market === 'spot' || market === 'futures') return 'coin';
  return 'all';
}

export default function UnifiedAssetSearchPage() {
  const [location, navigate] = useLocation();
  const assetMode = useAssetMode();
  const [market, setMarket] = useState<UnifiedMarketFilter | null>(null);
  const asset = useMemo(() => assetForMarket(market), [market]);
  const backPath = location.startsWith('/__phase11-unified-search-e2e')
    ? '/search'
    : location.startsWith('/search')
      ? '/search'
      : '/stocks';

  const selectMarket = (nextMarket: UnifiedMarketFilter | null) => {
    setMarket(nextMarket);
    if (nextMarket === 'KR' || nextMarket === 'US') {
      assetMode.setAsset('stock');
      assetMode.setStockMarket(nextMarket);
    }
    if (nextMarket === 'spot' || nextMarket === 'futures') {
      assetMode.setAsset('coin');
      assetMode.setCoinMarket(nextMarket);
    }
  };

  const openAsset = (item: UnifiedAssetSuggestion) => {
    if (item.assetType === 'stock') {
      assetMode.setAsset('stock');
      assetMode.setStockMarket(item.market === 'US' ? 'US' : 'KR');
    } else {
      assetMode.setAsset('coin');
      assetMode.setCoinMarket(item.market === 'futures' ? 'futures' : 'spot');
    }
    navigate(unifiedAssetDetailPath(item, backPath));
  };

  return (
    <div data-testid="unified-asset-search-page" className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <CenteredPageHeader
        title="종목"
        infoTitle="통합 종목 검색"
        infoItems={[
          '국내주식·미국주식·코인 현물·코인 선물을 한 검색창에서 찾습니다.',
          '종목명, 코드, 티커와 BTC/KRW·BTCUSDT 형식을 지원합니다.',
        ]}
      />

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-28 pt-4 sm:px-4">
        <div className="mx-auto w-full max-w-4xl">
          <nav className="mb-4 flex snap-x gap-2 overflow-x-auto pb-1" aria-label="종목 시장 필터" data-testid="unified-market-tabs">
            {MARKET_FILTERS.map((item) => (
              <button
                key={item.label}
                type="button"
                aria-pressed={market === item.key}
                onClick={() => selectMarket(item.key)}
                className={cn(
                  'min-h-11 shrink-0 snap-start rounded-xl border px-4 text-sm font-black transition',
                  market === item.key
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-card-border bg-card text-muted-foreground hover:text-foreground',
                )}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <section data-testid="unified-search-single-input" className="rounded-2xl border border-card-border bg-card p-3 sm:p-4">
            <UnifiedAssetSearch asset={asset} market={market} autoFocus onSelect={openAsset} />
          </section>

          <button
            type="button"
            onClick={() => navigate('/market-rankings')}
            className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-card-border bg-card px-4 text-sm font-black text-primary"
          >
            <BarChart3 className="h-4 w-4" />시장 순위 보기
          </button>
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
