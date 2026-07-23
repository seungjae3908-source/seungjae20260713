import {
  isInWatchlist,
  readWatchlistItems,
  toggleWatchlistItem,
  WATCHLIST_CHANGE_EVENT,
  writeWatchlistItems,
  type WatchlistItem,
} from '@/lib/stock-display';

export function getWatchlistItems(): WatchlistItem[] {
  return readWatchlistItems();
}

export function getWatchlistTickers(): string[] {
  return readWatchlistItems().map((item) => item.ticker);
}

export function isWatchlisted(ticker: string): boolean {
  return isInWatchlist(ticker);
}

export function setWatchlistItems(items: WatchlistItem[]): void {
  writeWatchlistItems(items);
}

export function toggleWatchlist(tickerOrItem: string | WatchlistItem): string[] {
  const item =
    typeof tickerOrItem === 'string'
      ? {
          ticker: tickerOrItem,
          name: tickerOrItem,
        }
      : tickerOrItem;

  toggleWatchlistItem(item);

  return getWatchlistTickers();
}

export { WATCHLIST_CHANGE_EVENT };