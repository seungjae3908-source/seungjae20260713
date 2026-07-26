import { useMemo } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { BottomNav } from '@/components/bottom-nav';
import { authorizedFetch } from '@/lib/auth-fetch';
import { displayStockName, formatAppPercent, formatAppPrice, readWatchlistItems } from '@/lib/stock-display';
import { cn } from '@/lib/utils';

type AssetKind = 'stockKR' | 'stockUS' | 'coinSpot' | 'coinFutures';
type ViewKind = 'watchlist' | 'alerts';
type AnyObj = Record<string, any>;

function queryState() {
  const params = new URLSearchParams(window.location.search);
  const view: ViewKind = params.get('view') === 'alerts' ? 'alerts' : 'watchlist';
  const rawAsset = params.get('asset');
  const asset: AssetKind = rawAsset === 'stockUS' || rawAsset === 'coinSpot' || rawAsset === 'coinFutures'
    ? rawAsset
    : 'stockKR';
  return { view, asset };
}

function assetLabel(asset: AssetKind) {
  if (asset === 'stockKR') return '국내주식';
  if (asset === 'stockUS') return '해외주식';
  if (asset === 'coinSpot') return '코인 현물';
  return '코인 선물';
}

function matchesAsset(row: AnyObj, asset: AssetKind) {
  const type = String(row.assetType ?? row.asset_type ?? '').toLowerCase();
  const market = String(row.market ?? '').toUpperCase();
  if (asset === 'coinSpot') return type.includes('coinspot') || type === 'spot';
  if (asset === 'coinFutures') return type.includes('coinfutures') || type === 'futures';
  if (asset === 'stockUS') return !type.includes('coin') && (type.includes('stockus') || market === 'US');
  return !type.includes('coin') && !type.includes('stockus') && market !== 'US';
}

async function fetchApi(path: string): Promise<AnyObj> {
  const response = await authorizedFetch(`/api${path}`, { cache: 'no-store' });
  const body = (await response.json().catch(() => ({}))) as AnyObj;
  if (!response.ok) throw new Error(String(body.message ?? body.error ?? response.status));
  return body;
}

export default function WatchlistAssetsPage() {
  const [, navigate] = useLocation();
  const { view, asset } = queryState();
  const storedItems = useMemo(() => readWatchlistItems().filter((row) => matchesAsset(row, asset)), [asset]);

  const alerts = useQuery({
    queryKey: ['watchlist-assets-alerts'],
    queryFn: () => fetchApi('/notifications/price-alerts'),
    retry: false,
  });

  const alertRows = useMemo(
    () => ((alerts.data?.alerts ?? []) as AnyObj[]).filter((row) => matchesAsset(row, asset)),
    [alerts.data, asset],
  );

  const symbols = useMemo(() => {
    const rows = view === 'watchlist' ? storedItems : alertRows;
    return Array.from(new Set(rows.map((row: AnyObj) => String(row.ticker ?? row.symbol ?? '').toUpperCase()).filter(Boolean)));
  }, [alertRows, storedItems, view]);

  const quotes = useQuery({
    queryKey: ['watchlist-assets-quotes', asset, symbols.join(',')],
    enabled: symbols.length > 0,
    retry: false,
    queryFn: async () => {
      if (asset === 'coinSpot') return fetchApi(`/crypto/spot/tickers?markets=${encodeURIComponent(symbols.join(','))}`);
      if (asset === 'coinFutures') {
        const payloads = await Promise.all(symbols.map((symbol) => fetchApi(`/crypto/futures/tickers?symbol=${encodeURIComponent(symbol)}`).catch(() => ({ tickers: [] }))));
        return { tickers: payloads.flatMap((payload) => payload.tickers ?? []) };
      }
      return fetchApi(`/quotes?tickers=${encodeURIComponent(symbols.join(','))}`);
    },
  });

  const quoteMap = useMemo(() => {
    const rows = (quotes.data?.quotes ?? quotes.data?.tickers ?? []) as AnyObj[];
    return new Map<string, AnyObj>(rows.map((row): [string, AnyObj] => [
      String(row.ticker ?? row.symbol ?? row.market ?? '').replace(/^KRW-/, '').toUpperCase(),
      row,
    ]));
  }, [quotes.data]);

  const rows = view === 'watchlist' ? storedItems : alertRows;

  function openRow(row: AnyObj) {
    const ticker = String(row.ticker ?? row.symbol ?? '').toUpperCase();
    if (!ticker) return;
    if (asset === 'stockKR' || asset === 'stockUS') {
      navigate(`/stock/${encodeURIComponent(ticker)}?back=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    navigate(`/stock-info?asset=coin&coinMarket=${asset === 'coinSpot' ? 'spot' : 'futures'}&symbol=${encodeURIComponent(ticker)}`);
  }

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background pb-24 text-center">
      <header className="border-b border-card-border px-4 pb-4 pt-5">
        <h1 className="text-2xl font-extrabold">{view === 'watchlist' ? '관심종목' : '지정가알림'}</h1>
        <p className="mt-1 text-sm font-bold text-muted-foreground">{assetLabel(asset)}</p>
      </header>

      <main className="px-4 py-4">
        {(view === 'alerts' && alerts.isLoading) || quotes.isLoading ? (
          <p className="rounded-3xl border border-card-border bg-card p-8 text-sm font-bold text-muted-foreground">실제 데이터를 불러오는 중입니다.</p>
        ) : rows.length === 0 ? (
          <p className="rounded-3xl border border-card-border bg-card p-8 text-sm font-bold text-muted-foreground">등록된 항목이 없습니다.</p>
        ) : (
          <div className="space-y-3">
            {rows.map((row: AnyObj, index: number) => {
              const ticker = String(row.ticker ?? row.symbol ?? '').toUpperCase();
              const quote = quoteMap.get(ticker);
              const price = Number(quote?.price ?? quote?.currentPrice ?? quote?.markPrice);
              const change = Number(quote?.changePercent ?? quote?.changePercent24h);
              const currency = asset === 'stockUS' ? 'USD' : asset === 'coinFutures' ? 'USDT' : 'KRW';
              const name = asset === 'stockKR' || asset === 'stockUS'
                ? displayStockName(ticker, String(row.name ?? ticker), asset === 'stockUS' ? 'US' : 'KR')
                : ticker;
              return (
                <button
                  key={String(row.id ?? `${ticker}:${index}`)}
                  type="button"
                  onClick={() => openRow(row)}
                  className="w-full rounded-3xl border border-card-border bg-card p-4 text-center shadow-sm"
                >
                  <p className="truncate text-base font-extrabold">{name}</p>
                  <p className="mt-1 text-xs font-bold text-muted-foreground">{ticker} · {assetLabel(asset)}</p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="rounded-2xl bg-secondary/60 p-3 text-center">
                      <p className="text-[10px] font-bold text-muted-foreground">현재가</p>
                      <p className="mt-1 text-sm font-black">{Number.isFinite(price) ? formatAppPrice(price, currency) : '데이터 없음'}</p>
                    </div>
                    <div className="rounded-2xl bg-secondary/60 p-3 text-center">
                      <p className="text-[10px] font-bold text-muted-foreground">{view === 'alerts' ? '지정가' : '등락률'}</p>
                      <p className={cn('mt-1 text-sm font-black', view === 'watchlist' && Number.isFinite(change) ? change >= 0 ? 'text-positive' : 'text-destructive' : '')}>
                        {view === 'alerts'
                          ? formatAppPrice(row.target_price ?? row.targetPrice, currency)
                          : Number.isFinite(change) ? formatAppPercent(change) : '데이터 없음'}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {(alerts.isError || quotes.isError) && (
          <p className="mt-4 rounded-2xl bg-destructive/10 p-4 text-sm font-bold text-destructive">일부 실제 데이터를 불러오지 못했습니다. 임시 값은 표시하지 않습니다.</p>
        )}
      </main>
      <BottomNav />
    </div>
  );
}
