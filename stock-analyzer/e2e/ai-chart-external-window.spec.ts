import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const candles = Array.from({ length: 48 }, (_, index) => ({
  time: new Date(Date.UTC(2026, 7, 4, 0, index * 5)).toISOString(),
  open: 70000 + index * 20,
  high: 70120 + index * 20,
  low: 69920 + index * 20,
  close: 70060 + index * 20,
  volume: 1000 + index * 10,
  isClosed: index < 47,
}));

type SelectionFixture = {
  assetType: 'stock';
  market: 'KR';
  symbol: string;
  ticker: string;
  displayName: string;
  timeframe: string;
  selectedAt: string;
};

const selection: SelectionFixture = {
  assetType: 'stock',
  market: 'KR',
  symbol: '005930',
  ticker: '005930',
  displayName: '삼성전자',
  timeframe: '5m',
  selectedAt: '2026-08-06T07:00:00.000Z',
};

const initialUrl = '/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m';
const syncId = 'e2e-session';
const pairId = 'e2e-pair';
const externalUrl = `${initialUrl}&chartWindow=external&chartSync=${syncId}&chartPair=${pairId}`;
const channelName = `stock-app-ai-chart-window-v2:${syncId}:${pairId}`;

type RuntimeObservation = {
  consoleErrors: string[];
  pageErrors: string[];
  unexpectedHttp: string[];
  apiMutations: string[];
  orderRequests: string[];
  accountPositionRequests: string[];
  pages: Page[];
};

type MessagePayload = Record<string, unknown>;

async function mockChartApis(context: BrowserContext) {
  await context.route('**/api/stocks/*/chart**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ticker: '005930',
      timeframe: new URL(route.request().url()).searchParams.get('tf') ?? '5m',
      provider: 'external-window-fixture',
      fetchedAt: '2026-08-06T07:00:00.000Z',
      updatedAt: '2026-08-06T07:00:00.000Z',
      candles,
    }),
  }));
  await context.route('**/api/stocks/*/candles**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ candles }),
  }));
  await context.route('**/api/quotes**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ quotes: [{ ticker: '^KS11', changePercent: 0.4 }] }),
  }));
}

async function installUnhandledCapture(context: BrowserContext) {
  await context.addInitScript(() => {
    const store = globalThis as typeof globalThis & { __chartUnhandled?: string[] };
    store.__chartUnhandled = [];
    globalThis.addEventListener('unhandledrejection', (event) => {
      store.__chartUnhandled?.push(String(event.reason));
    });
  });
}

function observeRuntime(context: BrowserContext, page: Page): RuntimeObservation {
  const runtime: RuntimeObservation = {
    consoleErrors: [],
    pageErrors: [],
    unexpectedHttp: [],
    apiMutations: [],
    orderRequests: [],
    accountPositionRequests: [],
    pages: [page],
  };
  const attach = (opened: Page) => {
    if (!runtime.pages.includes(opened)) runtime.pages.push(opened);
    opened.on('console', (message) => {
      if (message.type() === 'error') runtime.consoleErrors.push(message.text());
    });
    opened.on('pageerror', (error) => runtime.pageErrors.push(error.message));
  };
  attach(page);
  context.on('page', attach);
  context.on('response', (response) => {
    if (response.status() >= 400) runtime.unexpectedHttp.push(`${response.status()} ${response.url()}`);
  });
  context.on('request', (request) => {
    const url = request.url();
    if (request.method() !== 'GET' && /\/api\//i.test(url)) runtime.apiMutations.push(`${request.method()} ${url}`);
    if (/\/(orders?|cancel|auto-trad|trade-automation)(?:\/|\?|$)/i.test(url)) {
      runtime.orderRequests.push(`${request.method()} ${url}`);
    }
    if (/\/(accounts?|positions?)(?:\/|\?|$)/i.test(url)) {
      runtime.accountPositionRequests.push(`${request.method()} ${url}`);
    }
  });
  return runtime;
}

async function assertCleanRuntime(runtime: RuntimeObservation) {
  const unhandled: string[] = [];
  for (const page of runtime.pages) {
    if (page.isClosed()) continue;
    const rows = await page.evaluate(() => {
      const store = globalThis as typeof globalThis & { __chartUnhandled?: string[] };
      return store.__chartUnhandled ?? [];
    });
    unhandled.push(...rows);
  }
  expect(runtime.consoleErrors).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
  expect(unhandled).toEqual([]);
  expect(runtime.unexpectedHttp).toEqual([]);
  expect(runtime.apiMutations).toEqual([]);
  expect(runtime.orderRequests).toEqual([]);
  expect(runtime.accountPositionRequests).toEqual([]);
}

async function postChannelMessage(page: Page, payload: MessagePayload) {
  await page.evaluate(async ({ channelName: name, message }) => {
    const channel = new BroadcastChannel(name);
    channel.postMessage(message);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    channel.close();
  }, { channelName, message: payload });
}

async function setDocumentVisibility(page: Page, visibilityState: 'hidden' | 'visible') {
  await page.evaluate((state) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visibilityState);
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe(visibilityState);
}

function mainMessage(input: {
  type: 'ready' | 'closed' | 'selection';
  sourceId: string;
  sequence: number;
  sentAt: number;
  selectionOverride?: Partial<typeof selection>;
  sessionId?: string;
  pairId?: string;
  origin: string;
}): MessagePayload {
  const base: MessagePayload = {
    version: 2,
    type: input.type,
    sessionId: input.sessionId ?? syncId,
    pairId: input.pairId ?? pairId,
    sourceId: input.sourceId,
    sourceRole: 'main',
    origin: input.origin,
    sequence: input.sequence,
    sentAt: input.sentAt,
  };
  if (input.type === 'selection') {
    base.selection = { ...selection, ...input.selectionOverride };
  }
  return base;
}

test('desktop opens one external chart, synchronizes both directions, focuses the existing window, and cleans up', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installUnhandledCapture(context);
  await mockChartApis(context);
  const runtime = observeRuntime(context, page);

  await page.goto(initialUrl);
  await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
  const externalButton = page.getByTestId('open-external-ai-chart');
  await expect(externalButton).toBeVisible();
  await expect(externalButton).toBeEnabled();

  const popupPromise = context.waitForEvent('page');
  await externalButton.click();
  await externalButton.click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  await expect(popup).toHaveURL(/chartWindow=external/);
  await expect(popup).toHaveURL(/chartSync=/);
  await expect(popup).toHaveURL(/chartPair=/);
  await expect(popup.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
  await expect(popup.getByText('외부 AI 차트', { exact: true })).toBeVisible();
  await expect(popup.getByTestId('open-external-ai-chart')).toHaveCount(0);
  await expect.poll(() => context.pages().filter((candidate) => !candidate.isClosed()).length).toBe(2);

  await page.getByRole('button', { name: '15분', exact: true }).click();
  await expect(popup).toHaveURL(/timeframe=15m/);
  await popup.getByRole('button', { name: '30분', exact: true }).click();
  await expect(page).toHaveURL(/timeframe=30m/);

  const pageCount = context.pages().length;
  await externalButton.click();
  await expect.poll(() => context.pages().length).toBe(pageCount);
  await expect(page.getByTestId('external-chart-status')).toContainText('이미 열린 외부 차트 창');

  await popup.reload();
  await expect(popup.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '5분', exact: true }).click();
  await expect(popup).toHaveURL(/timeframe=5m/);

  await popup.close();
  await expect(page.getByTestId('external-chart-status')).toContainText('외부 차트 창이 닫혔습니다.');
  await assertCleanRuntime(runtime);
});

test('strict session, origin, order, close, replacement, and simultaneous-update gates preserve the newest atomic selection', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installUnhandledCapture(context);
  await mockChartApis(context);
  const runtime = observeRuntime(context, page);
  await page.goto(externalUrl);
  await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
  await expect(page.getByText('외부 AI 차트', { exact: true })).toBeVisible();
  const origin = new URL(page.url()).origin;
  const base = Date.now();

  await postChannelMessage(page, mainMessage({ type: 'ready', sourceId: 'main-a', sequence: 1, sentAt: base + 10, origin }));
  await postChannelMessage(page, mainMessage({
    type: 'selection', sourceId: 'main-a', sequence: 2, sentAt: base + 100, origin,
    selectionOverride: { timeframe: '15m' },
  }));
  await expect(page).toHaveURL(/timeframe=15m/);
  const acceptedUrl = page.url();

  const blocked: MessagePayload[] = [
    mainMessage({ type: 'selection', sourceId: 'main-a', sequence: 1, sentAt: base + 90, origin, selectionOverride: { timeframe: '5m' } }),
    mainMessage({ type: 'selection', sourceId: 'main-a', sequence: 3, sentAt: base - 31_000, origin, selectionOverride: { timeframe: '5m' } }),
    mainMessage({ type: 'selection', sourceId: 'main-a', sequence: 3, sentAt: base + 6_000, origin, selectionOverride: { timeframe: '5m' } }),
    mainMessage({ type: 'selection', sourceId: 'main-a', sequence: 3, sentAt: base + 120, origin: 'https://evil.example.test', selectionOverride: { timeframe: '5m' } }),
    mainMessage({ type: 'selection', sourceId: 'main-a', sequence: 3, sentAt: base + 130, origin, sessionId: 'other-session', selectionOverride: { timeframe: '5m' } }),
    mainMessage({ type: 'selection', sourceId: 'main-a', sequence: 3, sentAt: base + 140, origin, pairId: 'other-pair', selectionOverride: { timeframe: '5m' } }),
    { ...mainMessage({ type: 'selection', sourceId: 'main-a', sequence: 3, sentAt: base + 150, origin, selectionOverride: { timeframe: '5m' } }), sentAt: String(base + 150) },
    { ...mainMessage({ type: 'selection', sourceId: 'main-a', sequence: 3, sentAt: base + 160, origin, selectionOverride: { timeframe: '5m' } }), sentAt: Number.NaN },
    { ...mainMessage({ type: 'selection', sourceId: 'main-a', sequence: 3, sentAt: base + 170, origin, selectionOverride: { timeframe: '5m' } }), type: 'order' },
    { version: 2, type: 'selection' },
    mainMessage({ type: 'selection', sourceId: 'unknown-main', sequence: 1, sentAt: base + 180, origin, selectionOverride: { timeframe: '5m' } }),
  ];
  for (const payload of blocked) await postChannelMessage(page, payload);
  await expect(page).toHaveURL(acceptedUrl);

  await postChannelMessage(page, mainMessage({ type: 'closed', sourceId: 'main-a', sequence: 3, sentAt: base + 200, origin }));
  await postChannelMessage(page, mainMessage({
    type: 'selection', sourceId: 'main-a', sequence: 4, sentAt: base + 210, origin,
    selectionOverride: { timeframe: '5m' },
  }));
  await expect(page).toHaveURL(acceptedUrl);

  await postChannelMessage(page, mainMessage({ type: 'ready', sourceId: 'main-b', sequence: 1, sentAt: base + 300, origin }));
  await postChannelMessage(page, mainMessage({
    type: 'selection', sourceId: 'main-b', sequence: 2, sentAt: base + 400, origin,
    selectionOverride: { timeframe: '30m' },
  }));
  await expect(page).toHaveURL(/timeframe=30m/);
  await postChannelMessage(page, mainMessage({ type: 'ready', sourceId: 'main-a', sequence: 99, sentAt: base + 500, origin }));
  await postChannelMessage(page, mainMessage({
    type: 'selection', sourceId: 'main-a', sequence: 100, sentAt: base + 510, origin,
    selectionOverride: { timeframe: '5m' },
  }));
  await expect(page).toHaveURL(/timeframe=30m/);

  const deterministicRemoteWinner = Date.now() + 4_000;
  await Promise.all([
    page.getByRole('button', { name: '15분', exact: true }).click(),
    postChannelMessage(page, mainMessage({
      type: 'selection', sourceId: 'main-b', sequence: 3, sentAt: deterministicRemoteWinner, origin,
      selectionOverride: { timeframe: '30m' },
    })),
  ]);
  await expect(page).toHaveURL(/timeframe=30m/);
  await assertCleanRuntime(runtime);
});

test('hidden state accepts only ordered snapshots and requests current state again when visible', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installUnhandledCapture(context);
  await mockChartApis(context);
  const runtime = observeRuntime(context, page);
  await page.goto(externalUrl);
  const origin = new URL(page.url()).origin;
  const base = Date.now();
  await postChannelMessage(page, mainMessage({ type: 'ready', sourceId: 'main-hidden', sequence: 1, sentAt: base + 10, origin }));

  await setDocumentVisibility(page, 'hidden');
  await postChannelMessage(page, mainMessage({
    type: 'selection', sourceId: 'main-hidden', sequence: 2, sentAt: base + 100, origin,
    selectionOverride: { timeframe: '5m' },
  }));
  await postChannelMessage(page, mainMessage({
    type: 'selection', sourceId: 'main-hidden', sequence: 3, sentAt: base + 200, origin,
    selectionOverride: { timeframe: '15m' },
  }));
  await postChannelMessage(page, mainMessage({
    type: 'selection', sourceId: 'main-hidden', sequence: 2, sentAt: base + 150, origin,
    selectionOverride: { timeframe: '30m' },
  }));
  await setDocumentVisibility(page, 'visible');
  await expect(page).toHaveURL(/timeframe=15m/);
  await expect(page.getByTestId('external-chart-status')).toContainText('안전하게 동기화');
  await assertCleanRuntime(runtime);
});

test('popup blocking is reported and no second chart context is created', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installUnhandledCapture(context);
  await mockChartApis(context);
  const runtime = observeRuntime(context, page);
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await page.goto(initialUrl);
  await page.getByTestId('open-external-ai-chart').click();
  await expect(page.getByTestId('external-chart-status')).toContainText('팝업이 차단되었습니다.');
  expect(context.pages()).toHaveLength(1);
  await assertCleanRuntime(runtime);
});

test('mobile widths do not render or activate the external-window control', async ({ page, context }) => {
  await installUnhandledCapture(context);
  await mockChartApis(context);
  const runtime = observeRuntime(context, page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(initialUrl);
  for (const width of [360, 390, 430, 1023]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByTestId('open-external-ai-chart')).toHaveCount(0);
  }
  await page.setViewportSize({ width: 1024, height: 844 });
  await expect(page.getByTestId('open-external-ai-chart')).toBeVisible();
  await assertCleanRuntime(runtime);
});

test('mobile user agents keep the external-window feature disabled even at desktop width', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installUnhandledCapture(context);
  await mockChartApis(context);
  const runtime = observeRuntime(context, page);
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      get: () => 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    });
  });
  await page.goto(initialUrl);
  await expect(page.getByTestId('open-external-ai-chart')).toHaveCount(0);
  await assertCleanRuntime(runtime);
});

test('invalid, duplicated, unsupported, and incomplete route inputs fail closed without guessing a default chart', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installUnhandledCapture(context);
  await mockChartApis(context);
  const runtime = observeRuntime(context, page);
  const invalidRoutes = [
    `${initialUrl}&market=US`,
    `${initialUrl.replace('timeframe=5m', 'timeframe=2m')}`,
    `${initialUrl.replace('ticker=005930', 'ticker=..%2F005930')}`,
    `${initialUrl.replace('name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90', 'name=%3Cscript%3Ealert(1)%3C%2Fscript%3E')}`,
    `${initialUrl}&chartWindow=external&chartSync=${syncId}`,
    `${initialUrl}&chartWindow=external&chartWindow=external&chartSync=${syncId}&chartPair=${pairId}`,
  ];
  for (const route of invalidRoutes) {
    await page.goto(route);
    await expect(page.getByTestId('external-chart-status')).toContainText('올바르지');
    await expect(page.getByTestId('open-external-ai-chart')).toHaveCount(0);
  }
  await assertCleanRuntime(runtime);
});
