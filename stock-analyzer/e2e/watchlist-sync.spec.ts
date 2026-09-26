import { expect, test, type Page, type Route } from '@playwright/test';

const WATCHLIST_KEY = 'seungjae_watchlist_v1';
const CHANGE_EVENT = 'seungjae-watchlist-changed';
const MEMBER_CACHE_PREFIX = 'seungjae_member_watchlist_v1:';
const LEGACY_QUARANTINE_KEY = 'seungjae_watchlist_legacy_quarantine_v1';

type ServerItem = {
  ticker: string;
  name: string;
  market: 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES' | 'UNRESOLVED';
  currency: string | null;
  targetPrice: number | null;
};

type SyncPayload = { items: ServerItem[] };

type MemberEnvelope = {
  ok: true;
  items: ServerItem[];
  identitySource: 'AUTHENTICATED_MEMBER';
};

function envelope(items: ServerItem[]): MemberEnvelope {
  return { ok: true, items, identitySource: 'AUTHENTICATED_MEMBER' };
}

async function useWatchlistSync(page: Page, memberId: string | null) {
  await page.evaluate(async (id) => {
    const load = new Function(
      'return import("/src/lib/watchlist-sync.ts")',
    ) as () => Promise<{
      ensureWatchlistSync(memberIdOverride?: string | null): void;
      stopWatchlistSync(): void;
    }>;
    const module = await load();
    module.ensureWatchlistSync(id);
  }, memberId);
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
        body: JSON.stringify(envelope(serverItems)),
      });
      return;
    }

    if (request.method() === 'POST' && url.pathname === '/api/member-watchlist/sync') {
      posts.push(request.postDataJSON() as SyncPayload);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(envelope(posts.at(-1)?.items ?? [])),
      });
      return;
    }

    await route.fulfill({ status: 405, body: 'method not allowed' });
  });
}

async function openCleanPage(page: Page) {
  await page.goto('/login');
  await page.evaluate(({ watchlistKey, cachePrefix, quarantineKey }) => {
    localStorage.removeItem(watchlistKey);
    localStorage.removeItem(quarantineKey);
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(cachePrefix)) localStorage.removeItem(key);
    }
  }, { watchlistKey: WATCHLIST_KEY, cachePrefix: MEMBER_CACHE_PREFIX, quarantineKey: LEGACY_QUARANTINE_KEY });
}

async function localItems(page: Page) {
  return await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]'), WATCHLIST_KEY) as Array<Record<string, unknown>>;
}

test('unchanged empty member state does not POST on initial load or hard reload', async ({ page }) => {
  const posts: SyncPayload[] = [];
  const reads = { count: 0 };
  await installWatchlistApi(page, [], posts, reads);
  await openCleanPage(page);

  await useWatchlistSync(page, 'member-a');
  await expect.poll(() => reads.count).toBe(1);
  await page.waitForTimeout(1_000);
  expect(posts).toEqual([]);

  await page.reload();
  await useWatchlistSync(page, 'member-a');
  await expect.poll(() => reads.count).toBe(2);
  await page.waitForTimeout(1_000);
  expect(posts).toEqual([]);
});

test('server canonical stock markets restore local aliases without echoing a POST', async ({ page }) => {
  const posts: SyncPayload[] = [];
  const reads = { count: 0 };
  const serverItems: ServerItem[] = [
    { ticker: '005930', name: 'Samsung Electronics', market: 'KR_STOCK', currency: 'KRW', targetPrice: 90_000 },
    { ticker: 'AAPL', name: 'Apple', market: 'US_STOCK', currency: 'USD', targetPrice: 225 },
  ];
  await installWatchlistApi(page, serverItems, posts, reads);
  await openCleanPage(page);

  await useWatchlistSync(page, 'member-a');
  await expect.poll(() => reads.count).toBe(1);
  await expect.poll(async () => JSON.stringify(await localItems(page))).toContain('AAPL');
  await page.waitForTimeout(1_000);

  expect(posts).toEqual([]);
  expect(await localItems(page)).toEqual([
    { ticker: '005930', name: 'Samsung Electronics', market: 'KR', currency: 'KRW', targetPrice: 90_000 },
    { ticker: 'AAPL', name: 'Apple', market: 'US', currency: 'USD', targetPrice: 225 },
  ]);
});

test('rapid local changes coalesce into one member-owned canonical POST with no client identity', async ({ page }) => {
  const posts: SyncPayload[] = [];
  const reads = { count: 0 };
  await installWatchlistApi(page, [], posts, reads);
  await openCleanPage(page);
  await useWatchlistSync(page, 'member-a');
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
    { ticker: 'AAPL', name: 'Apple', market: 'US_STOCK', currency: 'USD', targetPrice: 230 },
    { ticker: 'MSFT', name: 'Microsoft', market: 'US_STOCK', currency: 'USD', targetPrice: null },
  ]);
});

test('A logout B transition clears working state and restores only the new member namespace', async ({ page }) => {
  const reads: string[] = [];
  let memberRead = 0;
  await page.route('**/api/member-watchlist**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || url.pathname !== '/api/member-watchlist') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope([])) });
      return;
    }
    memberRead += 1;
    const items: ServerItem[] = memberRead === 1
      ? [{ ticker: 'AAPL', name: 'Apple A', market: 'US_STOCK', currency: 'USD', targetPrice: 220 }]
      : [{ ticker: 'MSFT', name: 'Microsoft B', market: 'US_STOCK', currency: 'USD', targetPrice: 510 }];
    reads.push(memberRead === 1 ? 'A' : 'B');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope(items)) });
  });
  await openCleanPage(page);

  await useWatchlistSync(page, 'member-a');
  await expect.poll(async () => JSON.stringify(await localItems(page))).toContain('AAPL');
  await useWatchlistSync(page, null);
  await expect.poll(async () => (await localItems(page)).length).toBe(0);
  await useWatchlistSync(page, 'member-b');
  await expect.poll(async () => JSON.stringify(await localItems(page))).toContain('MSFT');

  const final = await localItems(page);
  expect(JSON.stringify(final)).not.toContain('AAPL');
  expect(reads).toEqual(['A', 'B']);
  const cacheTruth = await page.evaluate(({ prefix }) => ({
    a: localStorage.getItem(`${prefix}${encodeURIComponent('member-a')}`),
    b: localStorage.getItem(`${prefix}${encodeURIComponent('member-b')}`),
  }), { prefix: MEMBER_CACHE_PREFIX });
  expect(cacheTruth.a).toContain('AAPL');
  expect(cacheTruth.b).toContain('MSFT');
});

test('a superseded slow member response cannot overwrite the new member state', async ({ page }) => {
  let readCount = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  await page.route('**/api/member-watchlist**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || url.pathname !== '/api/member-watchlist') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope([])) });
      return;
    }
    readCount += 1;
    if (readCount === 1) {
      await firstGate;
      try {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(envelope([{ ticker: 'AAPL', name: 'Late A', market: 'US_STOCK', currency: 'USD', targetPrice: 200 }])),
        });
      } catch {
        // Expected when the member switch aborts the superseded A request.
      }
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(envelope([{ ticker: 'MSFT', name: 'Current B', market: 'US_STOCK', currency: 'USD', targetPrice: 500 }])),
    });
  });
  await openCleanPage(page);

  await useWatchlistSync(page, 'member-a');
  await expect.poll(() => readCount).toBe(1);
  await useWatchlistSync(page, 'member-b');
  await expect.poll(() => readCount, { timeout: 5_000 }).toBe(2);
  releaseFirst();
  await expect.poll(async () => JSON.stringify(await localItems(page))).toContain('MSFT');
  await page.waitForTimeout(100);
  expect(JSON.stringify(await localItems(page))).not.toContain('Late A');
});

test('malformed member response is not accepted as empty or canonical state', async ({ page }) => {
  const posts: SyncPayload[] = [];
  await page.route('**/api/member-watchlist**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname === '/api/member-watchlist') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          identitySource: 'AUTHENTICATED_MEMBER',
          items: [{ ticker: 'AAPL', name: 'Apple', market: 'US_STOCK', currency: 'USD', targetPrice: '220' }],
        }),
      });
      return;
    }
    if (route.request().method() === 'POST') posts.push(route.request().postDataJSON() as SyncPayload);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope([])) });
  });
  await openCleanPage(page);
  await page.evaluate(({ key, prefix }) => {
    localStorage.setItem(`${prefix}${encodeURIComponent('member-a')}`, JSON.stringify([
      { ticker: 'MSFT', name: 'Cached', market: 'US_STOCK', currency: 'USD', targetPrice: 500 },
    ]));
    localStorage.removeItem(key);
  }, { key: WATCHLIST_KEY, prefix: MEMBER_CACHE_PREFIX });

  await useWatchlistSync(page, 'member-a');
  await expect.poll(async () => JSON.stringify(await localItems(page))).toContain('MSFT');
  await page.waitForTimeout(1_000);
  expect(JSON.stringify(await localItems(page))).not.toContain('AAPL');
  expect(posts).toEqual([]);
});

test('same ticker from two different markets is rejected instead of silently collapsed', async ({ page }) => {
  const posts: SyncPayload[] = [];
  await page.route('**/api/member-watchlist**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname === '/api/member-watchlist') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(envelope([
          { ticker: 'ABC', name: 'ABC US', market: 'US_STOCK', currency: 'USD', targetPrice: null },
          { ticker: 'ABC', name: 'ABC Crypto', market: 'CRYPTO_SPOT', currency: 'USDT', targetPrice: null },
        ])),
      });
      return;
    }
    if (route.request().method() === 'POST') posts.push(route.request().postDataJSON() as SyncPayload);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope([])) });
  });
  await openCleanPage(page);

  await useWatchlistSync(page, 'member-a');
  await page.waitForTimeout(500);
  expect(await localItems(page)).toEqual([]);
  expect(posts).toEqual([]);
});
