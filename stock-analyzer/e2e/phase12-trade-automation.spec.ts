import { test, expect, type Page } from '@playwright/test';

function captureBrowserFailures(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const httpErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      httpErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/')) requestFailures.push(`${request.failure()?.errorText ?? 'failed'} ${request.url()}`);
  });
  return { consoleErrors, pageErrors, httpErrors, requestFailures };
}

async function mockUserIntegrationsApi(page: Page) {
  await page.route(/\/api\/user-integrations(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        brokerConnections: [],
        telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null },
        preferences: {},
      }),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await mockUserIntegrationsApi(page);
});

function expectNoBrowserFailures(failures: ReturnType<typeof captureBrowserFailures>) {
  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
  expect(failures.httpErrors).toEqual([]);
  expect(failures.requestFailures).toEqual([]);
}

for (const width of [360, 390, 430]) {
  test(`four-market unified trading workspace fits ${width}px mobile`, async ({ page }) => {
    const failures = captureBrowserFailures(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/__phase12-trade-automation-e2e');

    await expect(page.getByRole('heading', { name: '자동매매', level: 1 })).toBeVisible();
    await expect(page.getByTestId('trading-mode-auto')).toHaveCount(0);
    await expect(page.getByTestId('trading-mode-paper')).toHaveCount(0);
    await expect(page.getByTestId('trading-market-select')).toBeVisible();

    const safetySummary = page.getByTestId('auto-trading-safety-summary');
    await expect(safetySummary).toContainText('주문별 승인');
    await expect(safetySummary).toContainText('불필요');
    await expect(safetySummary).toContainText('4시장');
    await expect(page.getByTestId('trade-approval-queue')).toHaveCount(0);

    await expect(page.getByTestId('auto-trading-runtime-summary')).toContainText('국내주식');

    await page.getByTestId('trading-section-settings').click();

    await expect(page.getByTestId('auto-trading-telegram-settings')).not.toHaveAttribute('open', '');
    await page.getByTestId('auto-trading-telegram-settings').locator('summary').click();
    await expect(page.getByTestId('user-broker-telegram-panel')).toBeVisible();
    await expect(page.getByTestId('automatic-trading-master-toggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('auto-market-domestic_stock')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('stock-broker-domestic_stock')).toHaveValue('kiwoom');
    await expect(page.getByTestId('stock-broker-us_stock')).toHaveCount(0);

    await page.getByTestId('trading-market-select').selectOption('us_stock');
    await expect(page.getByTestId('auto-market-us_stock')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('stock-broker-us_stock')).toHaveValue('kiwoom');
    await expect(page.getByTestId('stock-broker-us_stock')).toBeDisabled();
    await expect(page.getByTestId('stock-broker-us_stock').locator('option')).toHaveCount(1);
    await expect(page.getByTestId('stock-broker-domestic_stock')).toHaveCount(0);

    await page.getByTestId('trading-market-select').selectOption('crypto_spot');
    await expect(page.getByTestId('auto-market-crypto_spot')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('connection-upbit')).toBeVisible();
    await expect(page.getByTestId('stock-broker-routing')).toHaveCount(0);
    await expect(page.getByLabel('Bitget 레버리지')).toHaveCount(0);

    await page.getByTestId('trading-market-select').selectOption('crypto_futures');
    await expect(page.getByTestId('auto-market-crypto_futures')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('connection-bitget')).toBeVisible();
    await expect(page.getByLabel('Bitget 레버리지')).toBeVisible();
    await expect(page.getByLabel('Bitget 레버리지').locator('option')).toHaveText([
      '2배 (기본)', '3배', '4배', '5배', '6배', '7배 (최대)',
    ]);

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expectNoBrowserFailures(failures);
  });
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'desktop', width: 1440, height: 960 },
]) {
  test(`live order workspace is responsive and fail-closed on ${viewport.name}`, async ({ page }) => {
    const mutationRequests: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET' && request.url().includes('/api/trade-automation/')) {
        mutationRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
      }
    });

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/__phase12-trade-automation-e2e?market=domestic_stock&section=orders');

    await expect(page.getByTestId('live-order-workspace')).toBeVisible();
    await expect(page.getByTestId('live-order-readiness-badge')).toHaveText('주문 전 점검 필요');
    await expect(page.getByText('현재 실제 주문은 전송되지 않습니다.')).toBeVisible();
    await expect(page.getByRole('button', { name: '실전 주문 설정' })).toBeVisible();
    await expect(page.getByTestId('manual-live-order-entry')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(mutationRequests).toEqual([]);
  });
}

test('automatic trading keeps standing authorization while settings follow one selected market', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await page.goto('/__phase12-trade-automation-e2e');
  await page.getByTestId('trading-section-settings').click();

  const master = page.getByTestId('automatic-trading-master-toggle');
  await master.click();
  await expect(master).toHaveAttribute('aria-pressed', 'true');

  const domesticBroker = page.getByTestId('stock-broker-domestic_stock');
  await expect(domesticBroker).toHaveValue('kiwoom');
  await domesticBroker.selectOption('toss');
  await expect(domesticBroker).toHaveValue('toss');

  await page.getByTestId('trading-market-us_stock').click();
  const usBroker = page.getByTestId('stock-broker-us_stock');
  await expect(usBroker).toHaveValue('kiwoom');

  const us = page.getByTestId('auto-market-us_stock');
  await us.click();
  await expect(us).toHaveAttribute('aria-pressed', 'false');

  await page.getByRole('button', { name: '설정 저장' }).click();
  const dialog = page.getByRole('dialog', { name: '자동매매 설정 확인' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('주문마다 묻는 승인이 아닙니다.');
  await expect(dialog).toContainText('국내주식, 코인현물, 코인선물');
  await expect(dialog).not.toContainText('국내주식, 미국주식, 코인현물, 코인선물');
  await expect(dialog).toContainText('국내주식 증권사');
  await expect(dialog).toContainText('Toss');
  await expect(dialog).toContainText('미국주식 증권사');
  await expect(dialog).toContainText('Kiwoom');
  await expect(dialog).toContainText('Upbit 고정');
  await expect(dialog).toContainText('Bitget 고정');
  await expect(dialog).toContainText('거래키 + provider 서버게이트 + 주문 직전 Risk Gate 모두 필요');
  await dialog.getByRole('button', { name: '설정 적용' }).click();
  await expect(page.getByRole('status')).toContainText('테스트 설정이 저장되었습니다.');

  await page.getByRole('button', { name: '긴급정지' }).click();
  await expect(page.getByRole('status')).toContainText('4시장 신규 주문이 모두 차단');
  await expect(master).toHaveAttribute('aria-pressed', 'false');

  for (const market of ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures']) {
    await page.getByTestId(`trading-market-${market}`).click();
    await expect(page.getByTestId(`auto-market-${market}`)).toHaveAttribute('aria-pressed', 'false');
  }
  expectNoBrowserFailures(failures);
});

test('automatic trading surface never exposes per-order approval actions', async ({ page }) => {
  const approvalRequests: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/trade-automation\/plans\/[^/]+\/(approve|approval-status)/u.test(new URL(request.url()).pathname)) {
      approvalRequests.push(`${request.method()} ${request.url()}`);
    }
  });

  await page.goto('/__phase12-trade-automation-e2e');
  await expect(page.getByText('승인형 주문', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /승인/ })).toHaveCount(0);

  await page.getByTestId('trading-section-settings').click();
  await page.getByTestId('automatic-trading-master-toggle').click();
  await page.getByRole('button', { name: '설정 저장' }).click();
  await page.getByRole('dialog', { name: '자동매매 설정 확인' }).getByRole('button', { name: '설정 적용' }).click();
  expect(approvalRequests).toEqual([]);
});

test('paper mode exposes the same four-market navigation without enabling live authority', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await page.goto('/__phase12-trade-automation-e2e?mode=paper');

  await expect(page.getByRole('heading', { name: '모의매매', level: 1 })).toBeVisible();
  await expect(page.getByTestId('trading-mode-paper')).toHaveCount(0);
  await expect(page.getByTestId('paper-trading-dashboard')).toBeVisible();
  await expect(page.getByTestId('paper-trading-dashboard')).toContainText('실제 주문 0');

  for (const market of ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures']) {
    await page.getByTestId(`trading-market-${market}`).click();
    await expect(page.getByTestId(`trading-market-${market}`)).toHaveAttribute('aria-pressed', 'true');
  }

  await expect(page.getByTestId('trading-paper-modes')).toContainText('자동모의매매');
  await expect(page.getByTestId('trading-paper-modes')).toContainText('수동모의매매');
  await expect(page.getByTestId('automatic-trading-master-toggle')).toHaveCount(0);
  expectNoBrowserFailures(failures);
});

for (const width of [360, 390, 768, 1024, 1440]) {
  test('holdings popup uses saved entry evidence and protects manual assets at ' + width + 'px', async ({ page }) => {
    const failures = captureBrowserFailures(page);
    const mutations: string[] = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.url());
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/__phase12-trade-automation-e2e?holdings=true');
    const holdings = page.getByTestId('trading-holdings');
    const samsung = holdings.getByRole('button', { name: /삼성전자/ }).filter({ visible: true });
    await samsung.click();
    const popup = page.getByTestId('holding-detail-dialog');
    await expect(popup).toBeVisible();
    expect(await popup.evaluate(element => getComputedStyle(element).backgroundColor)).not.toMatch(/rgba\(|transparent/);
    await expect(popup).toContainText('기존 보유 — AUTO 진입 기록 없음');
    await expect(popup).toContainText('미설정');
    await expect(popup.getByRole('button', { name: /매도|주문|승인/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(popup).not.toBeVisible();
    await expect(samsung).toBeFocused();
    await holdings.getByRole('button', { name: /SK하이닉스/ }).filter({ visible: true }).click();
    await expect(popup).toContainText('거래량 증가 + 돌파 조건 충족');
    await expect(popup).toContainText('200,000 KRW');
    await expect(popup).toContainText('목표가 · 저장된 계획');
    await popup.getByText('근거 더 보기', { exact: true }).click();
    await expect(popup).toContainText('진입 당시 저장된 추세 정렬 근거');
    await expect(popup).toContainText('test-signal');
    const box = await popup.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(width);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await popup.getByRole('button', { name: '종목상세', exact: true }).click();
    await expect(page).toHaveURL(/\/stock-info\?.*ticker=000660/);
    await page.goto('/__phase12-trade-automation-e2e?holdings=true');
    await page.getByTestId('trading-holdings').getByRole('button', { name: /SK하이닉스/ }).filter({ visible: true }).click();
    await page.getByTestId('holding-detail-dialog').getByRole('button', { name: 'AI차트', exact: true }).click();
    await expect(page).toHaveURL(/\/ai-chart\?.*market=KR.*ticker=000660/);
    expect(mutations).toEqual([]);
    expect(failures.pageErrors).toEqual([]);
  });
}


test('holding popup never substitutes the broker average for missing canonical fill-price evidence', async ({ page }) => {
  await page.goto('/__phase12-trade-automation-e2e?holdings=true&missingFillPrice=true');
  await page.getByTestId('trading-holdings').getByRole('button', { name: /SK하이닉스/ }).filter({ visible: true }).click();
  const popup = page.getByTestId('holding-detail-dialog');
  await expect(popup).toBeVisible();
  await expect(popup.getByText('진입가 · 실제 체결').locator('..')).toContainText('미설정 / 미확인');
  await expect(popup).not.toContainText('200,000 KRW');
  await expect(popup).toContainText('거래량 증가 + 돌파 조건 충족');
  await expect(popup.getByRole('button', { name: /매도|주문|승인/ })).toHaveCount(0);
});

test('auto-trading rehearsal tab proves the safe four-market chain and displays zero real orders', async ({ page }) => {
  await page.unroute(/\/api\/user-integrations(?:\?.*)?$/);
  const forbiddenTradingMutations: string[] = [];
  let rehearsalRequest: Record<string, unknown> | null = null;

  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() !== 'GET'
      && path.startsWith('/api/trade-automation/')
      && path !== '/api/trade-automation/rehearsal/run'
    ) {
      forbiddenTradingMutations.push(`${request.method()} ${path}`);
    }
  });

  await page.route(/\/api\/paper-journal\/snapshot(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        mode: 'journal-sync-only',
        orderSubmitted: false,
        exchangeRequestSent: false,
        records: [],
      }),
    });
  });

  await page.route(/\/api\/user-integrations(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        telegram: { connected: true, status: 'ACTIVE', connectedAt: '2026-10-07T00:00:00.000Z' },
        telegramRuntime: { deliveryReady: true },
        brokerConnections: [],
        preferences: {},
      }),
    });
  });

  await page.route(/\/api\/user-integrations\/telegram\/test$/, async (route) => {
    expect(route.request().method()).toBe('POST');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        privateApiRequests: 0,
        ordersSubmitted: 0,
        ordersCancelled: 0,
      }),
    });
  });

  await page.route(/\/api\/trade-automation\/rehearsal\/run$/, async (route) => {
    expect(route.request().method()).toBe('POST');
    rehearsalRequest = route.request().postDataJSON() as Record<string, unknown>;
    const providers = Object.fromEntries(
      ['toss', 'kiwoom', 'upbit', 'bitget'].map((provider) => [provider, {
        configured: true,
        accountMode: 'live',
        liveConnectionVerified: true,
        reusableReadonlyCredential: true,
        readOnlyVerified: true,
        ready: true,
        lastErrorCode: null,
        credentialsExposed: false,
      }]),
    );
    const market = (
      name: string,
      direction: string,
      strategyId: string,
      providerList: string[],
    ) => ({
      market: name,
      direction,
      strategyId,
      providers: providerList,
      aiDecision: 'PASS',
      status: 'ACTIVE_REHEARSAL',
      wouldActivateLiveAuto: true,
      blockers: [],
      exceptionPolicyApplied: true,
      oosRequiredForRehearsal: false,
      profitabilityPromotionRequiredForRehearsal: false,
      executionAuthority: 'NONE',
      realOrderSubmitted: false,
      productionMutationAllowed: false,
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        schemaVersion: 'formula-ai-auto-rehearsal-runtime-v1',
        mode: 'DRIFT_REHEARSAL',
        exceptionPolicy: 'FORMULA_AI_LIVE_EXCEPTION_V1',
        signal: { source: 'SYNTHETIC_REHEARSAL_SIGNAL', deterministicRuleReady: true, productionSignalCreated: false },
        ai: {
          positiveDecision: 'PASS',
          vetoDecision: 'VETO',
          vetoBlocked: true,
          vetoBlockers: ['FORMULA_AI_AI_PASS_REQUIRED'],
          liveAiProviderInvokedByThisEndpoint: false,
        },
        providers,
        credentialReuse: Object.fromEntries(
          ['toss', 'kiwoom', 'upbit', 'bitget'].map((provider) => [provider, {
            configured: true,
            reusable: true,
            readOnlyVerified: true,
            errorCode: null,
            credentialsExposed: false,
          }]),
        ),
        paper: {
          paperAutoReady: true,
          paperFillReady: true,
          journalReady: true,
          riskReady: true,
          orderState: 'filled',
          fillCount: 1,
          journalEntryCount: 1,
          executionAuthority: 'NONE',
          realOrderSubmitted: false,
          exchangeRequestSent: false,
          providerMutationRequests: 0,
          productionMutationAllowed: false,
        },
        journal: {
          paperJournalProjectionReady: true,
          journalEndpointReadReady: true,
          ready: true,
          persistentMutationPerformedByThisEndpoint: false,
        },
        telegram: { ready: true, testMessageRequestedByThisEndpoint: false },
        futures: { marginMode: 'isolated', maxLeverage: 7, isolatedReady: true, leverageReady: true },
        markets: [
          market('KR_STOCK', 'BUY', 'KR_PRESSURE_BREAKOUT_V1', ['toss', 'kiwoom']),
          market('US_STOCK', 'BUY', 'US_STOCKS_IN_PLAY_ORB_RETEST_V1', ['kiwoom']),
          market('CRYPTO_SPOT', 'BUY', 'CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1', ['upbit']),
          market('CRYPTO_FUTURES', 'LONG', 'CRYPTO_FUTURES_FLOW_TREND_WAVE_V1', ['bitget']),
          market('CRYPTO_FUTURES', 'SHORT', 'CRYPTO_FUTURES_FLOW_TREND_WAVE_V1', ['bitget']),
        ],
        allProvidersReady: true,
        allCredentialReuseReady: true,
        wouldActivateLiveAuto: true,
        executionAuthority: 'NONE',
        realOrderSubmitted: false,
        actualOrderSubmitted: false,
        exchangeRequestSent: false,
        providerMutationRequests: 0,
        productionMutationAllowed: false,
        liveTradingActivated: false,
        automaticLiveExecutionActivated: false,
      }),
    });
  });

  await page.goto('/__phase12-trade-automation-e2e');
  await page.getByTestId('trading-section-settings').click();
  await page.getByTestId('auto-trading-rehearsal-settings').locator('summary').click();
  await expect(page.getByTestId('formula-ai-auto-rehearsal-panel')).toBeVisible();
  await expect(page.getByTestId('run-auto-rehearsal')).toContainText('자동매매 활성화 리허설 실행');

  await page.getByTestId('run-auto-rehearsal').click();

  await expect(page.getByTestId('auto-rehearsal-final-verdict')).toContainText('자동매매 활성화 가능');
  await expect(page.getByTestId('auto-rehearsal-final-verdict')).toContainText('실주문 권한:');
  await expect(page.getByTestId('auto-rehearsal-final-verdict')).toContainText('OFF');
  await expect(page.getByTestId('auto-rehearsal-final-verdict')).toContainText('실주문:');
  await expect(page.getByTestId('auto-rehearsal-final-verdict')).toContainText('0건');
  await expect(page.getByTestId('rehearsal-provider-grid')).toContainText('toss');
  await expect(page.getByTestId('rehearsal-provider-grid')).toContainText('bitget');
  expect(rehearsalRequest).toEqual({
    confirmed: true,
    journalReadReady: true,
    telegramReady: true,
  });
  expect(forbiddenTradingMutations).toEqual([]);
});
