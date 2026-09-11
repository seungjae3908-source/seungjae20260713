import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const displayPath = fileURLToPath(new URL('../src/lib/stock-display.ts', import.meta.url));
const homePath = fileURLToPath(new URL('../src/pages/home.tsx', import.meta.url));
const watchlistPath = fileURLToPath(new URL('../src/pages/watchlist.tsx', import.meta.url));

test('watchlist local storage cannot masquerade stale quote evidence as current market truth', async () => {
  const [displaySource, homeSource, watchlistSource] = await Promise.all([
    readFile(displayPath, 'utf8'),
    readFile(homePath, 'utf8'),
    readFile(watchlistPath, 'utf8'),
  ]);

  expect(displaySource).toContain('function stripTransientWatchlistQuote(item: WatchlistItem): WatchlistItem {');
  expect(displaySource).toContain('delete persistent.price;');
  expect(displaySource).toContain('delete persistent.changePercent;');
  expect(displaySource).toContain('return stripTransientWatchlistQuote(item as WatchlistItem);');
  expect(displaySource).toContain('const persistent = stripTransientWatchlistQuote(item);');

  // Home reads the same canonical watchlist storage. After the storage seam strips
  // transient quote fields, an old localStorage price/change can only render as
  // explicit missing evidence rather than a safe-looking current quote.
  expect(homeSource).toContain('readWatchlistItems');
  expect(homeSource).toContain("watchlistPrice == null ? '가격 미확인'");
  expect(homeSource).toContain("watchlistChangePercent == null ? '등락 미확인'");

  // The dedicated Watchlist view overlays current /api/quotes evidence when it
  // exists. If the provider/API is unavailable or a ticker is missing, the
  // stripped local snapshot cannot survive the merge as a fallback quote.
  expect(watchlistSource).toContain('const { data, isLoading } = useQuotes(tickers);');
  expect(watchlistSource).toContain('...(quoteMap.get(item.ticker.toUpperCase()) as AnyObj | undefined)');
  expect(watchlistSource).toContain('"가격 미확인"');
  expect(watchlistSource).toContain('"등락 미확인"');
});
