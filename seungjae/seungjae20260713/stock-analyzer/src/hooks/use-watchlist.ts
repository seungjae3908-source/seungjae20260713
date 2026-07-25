import { useCallback, useEffect, useState } from 'react';
import { getWatchlistItems, getWatchlistTickers, toggleWatchlist, WATCHLIST_CHANGE_EVENT } from '@/lib/watchlist';
import { persistWatchlist } from '@/lib/watchlist-sync';
import { writeWatchlistItems, type WatchlistItem } from '@/lib/stock-display';

export function useWatchlist() {
  const [tickers, setTickers] = useState<string[]>(() => getWatchlistTickers());

  useEffect(() => {
    const handler = () => setTickers(getWatchlistTickers());
    window.addEventListener(WATCHLIST_CHANGE_EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(WATCHLIST_CHANGE_EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  const toggle = useCallback(async (tickerOrItem: string | WatchlistItem) => {
    const previous = getWatchlistItems();
    const ticker = typeof tickerOrItem === 'string' ? tickerOrItem : tickerOrItem.ticker;
    toggleWatchlist(tickerOrItem);
    try {
      await persistWatchlist();
      return !previous.some((item) => item.ticker.toUpperCase() === ticker.toUpperCase());
    } catch (error) {
      writeWatchlistItems(previous);
      throw error;
    }
  }, []);

  const isWatchlisted = useCallback((ticker: string) => tickers.includes(ticker), [tickers]);

  return { tickers, isWatchlisted, toggle };
}
