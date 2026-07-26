import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Search, X } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { cn } from '@/lib/utils';

type SearchAsset = 'stockKR' | 'stockUS' | 'coinSpot' | 'coinFutures';

export type UnifiedAssetResult = {
  symbol: string;
  name: string;
  asset: SearchAsset;
  marketLabel: string;
  exchange?: string;
};

type AnyObj = Record<string, any>;

function normalize(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()［］\[\]{}·.,_\-]/g, '');
}

function arrayRows(value: unknown, keys: string[]): AnyObj[] {
  if (Array.isArray(value)) return value as AnyObj[];
  if (!value || typeof value !== 'object') return [];
  const record = value as AnyObj;
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as AnyObj[];
  }
  return [];
}

export function UnifiedAssetSearch({
  asset,
  value,
  onChange,
  onSelect,
  className,
  placeholder,
  autoFocus,
}: {
  asset: SearchAsset;
  value: string;
  onChange: (value: string) => void;
  onSelect: (result: UnifiedAssetResult) => void;
  className?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const [debounced, setDebounced] = useState(value.trim());

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [value]);

  const stockMarket = asset === 'stockUS' ? 'US' : 'KR';
  const isStock = asset === 'stockKR' || asset === 'stockUS';
  const isCoin = asset === 'coinSpot' || asset === 'coinFutures';

  const stockQuery = useQuery({
    queryKey: ['unified-asset-search', asset, debounced],
    queryFn: () =>
      apiGet<{ results?: AnyObj[] }>(
        `/search/quotes?q=${encodeURIComponent(debounced)}&market=${stockMarket}&limit=30&enrich=0`,
        { timeoutMs: 12_000 },
      ),
    enabled: isStock && debounced.length > 0,
    staleTime: 30_000,
    retry: 1,
  });

  const spotQuery = useQuery({
    queryKey: ['unified-asset-search', 'coin-spot-directory'],
    queryFn: () => apiGet<AnyObj>('/crypto/spot/markets', { timeoutMs: 15_000 }),
    enabled: isCoin && debounced.length > 0,
    staleTime: 10 * 60_000,
    retry: 1,
  });

  const futuresQuery = useQuery({
    queryKey: ['unified-asset-search', 'coin-futures-directory'],
    queryFn: () => apiGet<AnyObj>('/crypto/futures/tickers', { timeoutMs: 15_000 }),
    enabled: asset === 'coinFutures' && debounced.length > 0,
    staleTime: 60_000,
    retry: 1,
  });

  const results = useMemo<UnifiedAssetResult[]>(() => {
    const needle = normalize(debounced);
    if (!needle) return [];

    if (isStock) {
      return arrayRows(stockQuery.data, ['results'])
        .filter((row) => String(row.market ?? '').toUpperCase() === stockMarket)
        .map((row) => ({
          symbol: String(row.ticker ?? '').trim().toUpperCase(),
          name: String(row.name ?? row.ticker ?? '').trim(),
          asset,
          marketLabel: stockMarket === 'KR' ? '국내주식' : '해외주식',
          exchange: String(row.exchange ?? '').trim() || undefined,
        }))
        .filter((row) => row.symbol && row.name)
        .slice(0, 30);
    }

    const spotRows = arrayRows(spotQuery.data, ['markets']);

    if (asset === 'coinSpot') {
      return spotRows
        .filter((row) =>
          [row.symbol, row.koreanName, row.englishName, row.market].some((item) =>
            normalize(item).includes(needle),
          ),
        )
        .map((row) => ({
          symbol: String(row.symbol ?? String(row.market ?? '').replace(/^KRW-/, ''))
            .trim()
            .toUpperCase(),
          name: String(row.koreanName ?? row.englishName ?? row.symbol ?? '').trim(),
          asset,
          marketLabel: '코인 현물',
          exchange: 'UPBIT',
        }))
        .filter((row) => row.symbol)
        .slice(0, 30);
    }

    const spotNames = new Map(
      spotRows.map((row) => [String(row.symbol ?? '').toUpperCase(), row]),
    );

    return arrayRows(futuresQuery.data, ['tickers'])
      .filter((row) => {
        const symbol = String(row.symbol ?? '').toUpperCase();
        const base = symbol.replace(/USDT$/, '');
        const alias = spotNames.get(base);
        return [
          symbol,
          base,
          alias?.koreanName,
          alias?.englishName,
        ].some((item) => normalize(item).includes(needle));
      })
      .map((row) => {
        const symbol = String(row.symbol ?? '').trim().toUpperCase();
        const base = symbol.replace(/USDT$/, '');
        const alias = spotNames.get(base);
        return {
          symbol,
          name: String(alias?.koreanName ?? alias?.englishName ?? base || symbol).trim(),
          asset,
          marketLabel: '코인 선물',
          exchange: 'BITGET',
        };
      })
      .filter((row) => row.symbol)
      .slice(0, 30);
  }, [asset, debounced, futuresQuery.data, isStock, spotQuery.data, stockMarket, stockQuery.data]);

  const loading = stockQuery.isFetching || spotQuery.isFetching || futuresQuery.isFetching;
  const error = stockQuery.isError || spotQuery.isError || futuresQuery.isError;
  const visible = focused && debounced.length > 0;

  const choose = (result: UnifiedAssetResult) => {
    onChange('');
    setFocused(false);
    onSelect(result);
  };

  return (
    <div className={cn('relative', className)}>
      <label className="flex h-11 items-center gap-2 rounded-2xl border border-card-border bg-card px-3">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 140)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && results[0]) {
              event.preventDefault();
              choose(results[0]);
            }
            if (event.key === 'Escape') setFocused(false);
          }}
          autoFocus={autoFocus}
          autoComplete="off"
          placeholder={
            placeholder ??
            (isStock
              ? '종목명 또는 종목코드 검색'
              : asset === 'coinSpot'
                ? '코인명 또는 심볼 검색'
                : '코인명 또는 선물 심볼 검색')
          }
          className="min-w-0 flex-1 bg-transparent text-left text-sm font-bold outline-none"
        />
        {loading ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : value ? (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="검색어 지우기"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </label>

      {visible && (
        <div className="absolute inset-x-0 top-[calc(100%+6px)] z-[80] max-h-72 overflow-y-auto rounded-2xl border border-card-border bg-background p-1.5 shadow-2xl">
          {loading && results.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs font-bold text-muted-foreground">
              실제 종목을 검색하는 중입니다.
            </p>
          ) : error && results.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs font-bold text-destructive">
              검색 제공기관 연결에 실패했습니다. 잠시 후 다시 입력해 주세요.
            </p>
          ) : results.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs font-bold text-muted-foreground">
              검색 결과가 없습니다.
            </p>
          ) : (
            results.map((result) => (
              <button
                key={`${result.asset}:${result.symbol}`}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(result)}
                className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-secondary active:bg-secondary"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-black">{result.name}</span>
                  <span className="mt-0.5 block truncate text-[10px] font-bold text-muted-foreground">
                    {result.symbol}
                    {result.exchange ? ` · ${result.exchange}` : ''}
                  </span>
                </span>
                <span className="shrink-0 text-[10px] font-black text-primary">
                  {result.marketLabel}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
