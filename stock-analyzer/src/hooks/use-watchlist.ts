import { useCallback, useEffect, useState } from 'react';
import { getWatchlistTickers, toggleWatchlist, WATCHLIST_CHANGE_EVENT } from '@/lib/watchlist';

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

  const toggle = useCallback((ticker: string) => {
    toggleWatchlist(ticker);
  }, []);

  const isWatchlisted = useCallback((ticker: string) => tickers.includes(ticker), [tickers]);

  return { tickers, isWatchlisted, toggle };
}
