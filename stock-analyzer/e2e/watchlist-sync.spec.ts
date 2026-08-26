import { expect, test, type Page, type Route } from '@playwright/test';

const WATCHLIST_KEY = 'seungjae_watchlist_v1';
const CHANGE_EVENT = 'seungjae-watchlist-changed';

type ServerItem = {
  ticker: string;
  name: string;
  market: string | null;
  currency: string | null;
  targetPrice: number | null;
};

type SyncPayload = {
  items: ServerItem[];
};

async function loadWatchlistSync(page: Page) {
  await page.evaluate(async () => {
    const load = new Function(
      'return import("/src/lib/watchlist-sync.ts")',
    ) as () => Promise<{ ensureWatchlistSync(): void }>;
    const module = await load();
    module.ensureWatchlistSync();
  });
}

async function installWatchlistApi(
  page: Page,
  serverItems: ServerItem[],
  posts: SyncPayload[],
  reads: { count: number },
) {
  await page.route('**/api/member-watchlist**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['/api/member-watchlist', '/api/member-watchlist/sync'].includes(url.pathname)) {
      await route.continue();
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/member-watchlist') {
      reads.count += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, items: serverItems, identitySource: 'AUTHENTICATED_MEMBER' }),
      });
      return;
    }

    if (request.method() === 'POST' && url.pathname === '/api/member-watchlist/sync') {
      posts.push(request.postDataJSON() as SyncPayload);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, items: posts.at(-1)?.items ?? [], identitySource: 'AUTHENTICATED_MEMBER' }),
      });
      return;
    }

    await route.fulfill({ status: 405, body: 'method not allowed' });
  });
}

async function openCleanPage(page: Page) {
  await page.goto('/login');
  await page.evaluate((watchlistKey) => {
    localStorage.removeItem(watchlistKey);
  }, WATCHLIST_KEY);
}

test('unchanged empty state does not POST on initial load or hard reload', async ({ page }) => {
  const posts: SyncPayload[] = [];
  const reads = { count: 0 };
  await installWatchlistApi(page, [], posts, reads);
  await openCleanPage(page);

  await loadWatchlistSync(page);
  await expect.poll(() => reads.count).toBe(1);
  await page.waitForTimeout(1_000);
  expect(posts).toEqual([]);

  await page.reload();
  await loadWatchlistSync(page);
  await expect.poll(() => reads.count).toBe(2);
  await page.waitForTimeout(1_000);
  expect(posts).toEqual([]);
});

test('server canonical stock markets restore legacy local UI aliases without echoing a POST', async ({ page }) => {
  const posts: SyncPayload[] = [];
  const reads = { count: 0 };
  const serverItems: ServerItem[] = [
    {
      ticker: '005930',
      name: 'Samsung Electronics',
      market: 'KR_STOCK',
      currency: 'KRW',
      targetPrice: 90_000,
    },
    {
      ticker: 'AAPL',
      name: 'Apple',
      market: 'US_STOCK',
      currency: 'USD',
      targetPrice: 225,
    },
  ];
  await installWatchlistApi(page, serverItems, posts, reads);
  await openCleanPage(page);

  await loadWatchlistSync(page);
  await expect.poll(() => reads.count).toBe(1);
  await expect.poll(async () => page.evaluate((key) => localStorage.getItem(key), WATCHLIST_KEY))
    .toContain('AAPL');
  await page.waitForTimeout(1_000);

  expect(posts).toEqual([]);
  const localItems = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]'), WATCHLIST_KEY);
  expect(localItems).toEqual([
    {
      ticker: '005930',
      name: 'Samsung Electronics',
      market: 'KR',
      currency: 'KRW',
      targetPrice: 90_000,
    },
    {
      ticker: 'AAPL',
      name: 'Apple',
      market: 'US',
      currency: 'USD',
      targetPrice: 225,
    },
  ]);
});

test('rapid local changes coalesce into one member-owned canonical POST with no client identity', async ({ page }) => {
  const posts: SyncPayload[] = [];
  const reads = { count: 0 };
  await installWatchlistApi(page, [], posts, reads);
  await openCleanPage(page);
  await loadWatchlistSync(page);
  await expect.poll(() => reads.count).toBe(1);

  await page.evaluate(({ key, eventName }) => {
    localStorage.setItem(key, JSON.stringify([
      { ticker: 'aapl', name: 'Apple old', market: 'US', currency: 'USD' },
    ]));
    window.dispatchEvent(new Event(eventName));

    localStorage.setItem(key, JSON.stringify([
      { ticker: 'aapl', name: 'Apple old', market: 'US', currency: 'USD' },
      { ticker: 'AAPL', name: 'Apple', market: 'US', currency: 'USD', targetPrice: 230 },
      { ticker: 'msft', name: 'Microsoft', market: 'US', currency: 'USD' },
    ]));
    window.dispatchEvent(new Event(eventName));
  }, { key: WATCHLIST_KEY, eventName: CHANGE_EVENT });

  await expect.poll(() => posts.length, { timeout: 5_000 }).toBe(1);
  await page.waitForTimeout(1_000);
  expect(posts).toHaveLength(1);
  expect(posts[0]).not.toHaveProperty('deviceId');
  expect(posts[0]).not.toHaveProperty('userId');
  expect(posts[0]?.items).toEqual([
    {
      ticker: 'AAPL',
      name: 'Apple',
      market: 'US_STOCK',
      currency: 'USD',
      targetPrice: 230,
    },
    {
      ticker: 'MSFT',
      name: 'Microsoft',
      market: 'US_STOCK',
      currency: 'USD',
      targetPrice: null,
    },
  ]);
});
