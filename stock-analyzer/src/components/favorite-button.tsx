import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Star } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAuth } from '@/lib/auth';
import {
  isInWatchlist,
  readWatchlistItems,
  toggleWatchlistItem,
  WATCHLIST_CHANGE_EVENT,
  writeWatchlistItems,
  type WatchlistItem,
} from '@/lib/stock-display';
import { cn } from '@/lib/utils';

type FavoriteButtonProps = {
  symbol?: string;
  name?: string;
  assetType?: string;
  market?: string;
  currency?: string;
  item?: Partial<WatchlistItem> & { ticker: string };
  className?: string;
};

function normalizeAsset(
  value: string | undefined,
  market: string | undefined,
): NonNullable<WatchlistItem['assetType']> {
  if (value === 'coinSpot' || value === 'coin_spot') return 'coinSpot';
  if (value === 'coinFutures' || value === 'coin_futures') return 'coinFutures';
  if (value === 'stockUS' || String(market).toUpperCase() === 'US') return 'stockUS';
  return 'stockKR';
}

export function FavoriteButton({
  symbol,
  name,
  assetType,
  market,
  currency,
  item,
  className = '',
}: FavoriteButtonProps) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [, refresh] = useState(0);

  const watchItem = useMemo<WatchlistItem>(() => {
    const ticker = String(item?.ticker ?? symbol ?? '').trim().toUpperCase();
    const resolvedMarket = item?.market ?? market;
    return {
      ticker,
      name: String(item?.name ?? name ?? ticker),
      assetType: normalizeAsset(item?.assetType ?? assetType, resolvedMarket),
      market: resolvedMarket,
      currency: item?.currency ?? currency,
      targetPrice: item?.targetPrice,
    };
  }, [assetType, currency, item, market, name, symbol]);

  useEffect(() => {
    const update = () => refresh((value) => value + 1);
    window.addEventListener(WATCHLIST_CHANGE_EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(WATCHLIST_CHANGE_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);

  const active = Boolean(
    watchItem.ticker &&
      isInWatchlist(watchItem.ticker, watchItem.assetType),
  );

  const toggle = async () => {
    if (!watchItem.ticker || saving) return;
    if (!auth.user) {
      window.alert('관심종목은 로그인 후 사용할 수 있습니다.');
      return;
    }

    const previous = readWatchlistItems();
    const wasActive = active;
    toggleWatchlistItem(watchItem);
    setSaving(true);

    try {
      const response = await authorizedFetch(
        wasActive
          ? `/api/watchlist/${encodeURIComponent(watchItem.ticker)}?asset=${encodeURIComponent(
              watchItem.assetType ?? 'stockKR',
            )}`
          : `/api/watchlist/${encodeURIComponent(watchItem.ticker)}`,
        wasActive
          ? { method: 'DELETE' }
          : {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ticker: watchItem.ticker,
                name: watchItem.name,
                assetType: watchItem.assetType,
                market: watchItem.market ?? null,
                currency: watchItem.currency ?? null,
                targetPrice: watchItem.targetPrice ?? null,
              }),
            },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `HTTP_${response.status}`);
      }
      await queryClient.invalidateQueries({ queryKey: ['watchlist'] });
    } catch {
      writeWatchlistItems(previous);
      window.alert('관심종목 저장에 실패해 이전 상태로 되돌렸습니다.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void toggle();
      }}
      disabled={saving || !watchItem.ticker}
      className={cn(className, 'disabled:cursor-not-allowed disabled:opacity-50')}
      aria-label={active ? '관심종목 해제' : '관심종목 추가'}
      aria-pressed={active}
      title={active ? '관심종목 해제' : '관심종목 추가'}
    >
      {saving ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Star className="h-4 w-4" fill={active ? 'currentColor' : 'none'} />
      )}
    </button>
  );
}
