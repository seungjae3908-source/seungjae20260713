import { expect, test, type Page } from '@playwright/test';

const FIXED_AT = '2026-08-02T00:00:00.000Z';

function candleRows() {
  const end = Date.parse(FIXED_AT);
  return Array.from({ length: 80 }, (_, index) => {
    const close = 99 + index * 0.02;
    return {
      time: end - (79 - index) * 15 * 60_000,
      open: close - 0.1,
      high: close + 0.3,
      low: close - 0.3,
      close,
      volume: 100 + index,
      quoteVolume: (100 + index) * close,
    };
  });
}

function riskResult(side: 'long' | 'short') {
  const blocked = side === 'short';
  return {
    allowed: !blocked,
    blockCodes: blocked ? ['RISK_REWARD_TOO_LOW'] : [],
    warnings: [
      '실제 청산가격은 거래소 유지증거금, 계정 모드 및 포지션 상태에 따라 달라질 수 있습니다.',
      '유지증거금률 정보가 없어 0.50%를 적용한 단순 근사입니다.',
    ],
    maximumRiskAmount: 5,
    stopDistance: 1.5,
    stopDistancePercent: 1.5,
    rawQuantity: 3.111,
    recommendedQuantity: 3.111,
    notionalValue: 311.1,
    requiredMargin: 155.55,
    estimatedEntryFee: 0.18666,
    estimatedExitFeeAtStop: 0.18386,
    estimatedSlippageCost: 0.309,
    estimatedFundingCost: 0.03111,
    estimatedMaximumLoss: 4.999,
    actualRiskPercent: 0.4999,
    estimatedProfit1: blocked ? 2 : 6.1,
    estimatedProfit2: null,
    riskReward1: blocked ? 0.4 : 1.22,
    riskReward2: null,
    breakEvenPrice: side === 'long' ? 100.22 : 99.78,
    estimatedLiquidationPrice: side === 'long' ? 50.5 : 149.5,
    stopToLiquidationDistancePercent: 48,
    effectiveQuantityStep: 0.001,
    appMaximumLeverage: 10,
    exchangeMaximumLeverage: 125,
    calculatedAt: FIXED_AT,
  };
}

async function installFixtures(page: Page) {
  const riskBodies: Record<string, unknown>[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;

    if (pathname.endsWith('/trading/risk/preview')) {
      const body = request.postDataJSON() as Record<string, unknown>;
      riskBodies.push(body);
      const side = body.side === 'short' ? 'short' : 'long';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          mode: 'preview-only',
          orderSubmitted: false,
          result: riskResult(side),
        }),
      });
      return;
    }

    if (pathname.endsWith('/crypto/futures/status')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          provider: 'bitget',
          market: 'crypto-futures',
          status: 'live',
          connection: 'live',
          publicDataOnly: true,
          orderCapability: false,
          symbolCount: 1,
          updatedAt: FIXED_AT,
          warnings: [],
        }),
      });
      return;
    }

    if (pathname.endsWith('/crypto/futures/BTCUSDT/snapshot')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            symbol: 'BTCUSDT',
            price: 100,
            markPrice: 100,
            indexPrice: 99.9,
            change24hPercent: 1.2,
            volume24h: 1000,
            quoteVolume24h: 100000,
            bidPrice: 99.9,
            askPrice: 100.1,
            spreadPercent: 0.2,
            openInterest: 2000,
            previousOpenInterest: 1900,
            openInterestChangePercent: 5.26,
            fundingRate: 0.0001,
            nextFundingAt: '2026-08-02T08:00:00.000Z',
            basis: 0.1,
            basisPercent: 0.1001,
            source: 'bitget',
            status: 'live',
            isDelayed: false,
            updatedAt: FIXED_AT,
            warnings: [],
          },
        }),
      });
      return;
    }

    if (pathname.endsWith('/crypto/futures/BTCUSDT/contract-rules')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          publicDataOnly: true,
          orderCapability: false,
          data: {
            symbol: 'BTCUSDT',
            source: 'bitget',
            quantityStep: 0.001,
            minimumQuantity: 0.001,
            minimumNotional: 5,
            quantityPrecision: 3,
            pricePrecision: 1,
            priceStep: 0.1,
            minimumLeverage: 1,
            maximumLeverage: 125,
            maintenanceMarginRate: null,
            contractSize: null,
            status: 'live',
            updatedAt: FIXED_AT,
            warnings: Array.from({ length: 12 }, (_, index) => `계약 규칙 테스트 경고 ${index + 1}`),
          },
        }),
      });
      return;
    }

    if (pathname.endsWith('/crypto/futures/tickers')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tickers: [{
            symbol: 'BTCUSDT',
            price: 100,
            markPrice: 100,
            indexPrice: 99.9,
            changePercent24h: 1.2,
            high24h: 105,
            low24h: 95,
            volume24h: 1000,
            tradingValue24h: 100000,
            fundingRate: 0.0001,
            openInterest: 2000,
            bidPrice: 99.9,
            askPrice: 100.1,
          }],
        }),
      });
      return;
    }

    if (pathname.includes('/crypto/futures/candles')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ candles: candleRows(), status: 'live', warnings: [] }),
      });
      return;
    }

    if (pathname.endsWith('/crypto/status')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ bitget: { ok: true, privateKeyConfigured: false } }),
      });
      return;
    }

    if (pathname.endsWith('/crypto/futures/auto/status')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, serverTradingEnabled: false, positions: [], latestJournal: [] }),
      });
      return;
    }

    if (pathname.endsWith('/crypto/futures/account')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accounts: [], updatedAt: FIXED_AT }) });
      return;
    }

    if (pathname.endsWith('/crypto/futures/positions')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ positions: [] }) });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: [], warnings: [] }),
    });
  });
  return riskBodies;
}

async function assertNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewport);
}

async function openWorkspace(page: Page) {
  await page.goto('/__phase4-risk-e2e');
  await expect(page.getByTestId('phase4-coin-futures-workspace')).toBeVisible();
  await expect(page.getByText('선물 공개 시장 데이터', { exact: true })).toBeVisible();
  await expect(page.getByTestId('trading-risk-preview-panel')).toBeVisible();
  await page.getByTestId('trading-risk-preview-panel').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('contract-rules-card')).toBeVisible();
}

test('desktop 1440x900 renders contract rules and completes long and short risk flows', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const networkErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      networkErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  const riskBodies = await installFixtures(page);

  await openWorkspace(page);
  await expect(page.getByText('분석용 리스크 미리보기입니다. 실제 주문은 전송되지 않습니다.')).toBeVisible();
  await expect(page.getByTestId('quantity-step')).toContainText('0.001');
  await expect(page.getByText('최대 10배')).toBeVisible();
  await expect(page.getByText('125배')).toBeVisible();
  await expect(page.getByLabel('진입가 · markPrice 기준')).toHaveValue('100');
  await expect(page.getByLabel('예상 펀딩비율 (소수)')).toHaveValue('0.0001');

  await page.getByRole('button', { name: '리스크 미리보기 계산' }).click();
  await expect(page.getByText('분석 시나리오 진입 가능')).toBeVisible();
  await expect(page.getByTestId('recommended-quantity')).toContainText('3.111');
  await expect(page.getByText('계산 불가', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: '숏', exact: true }).click();
  await page.getByRole('button', { name: '리스크 미리보기 계산' }).click();
  await expect(page.getByText('분석 시나리오 진입 차단')).toBeVisible();
  await expect(page.getByText('순손익 기준 손익비가 1.0 미만입니다.')).toBeVisible();

  expect(riskBodies).toHaveLength(2);
  expect(riskBodies[0]).toMatchObject({
    side: 'long',
    quantityStep: 0.001,
    quantityPrecision: 3,
    minimumQuantity: 0.001,
    minimumNotional: 5,
    maximumLeverage: 125,
    appMaximumLeverage: 10,
    contractRulesStatus: 'live',
  });
  expect(riskBodies[1]).toMatchObject({ side: 'short' });

  const inputCount = await page.locator('input').count();
  for (let index = 0; index < inputCount; index += 1) {
    const input = page.locator('input').nth(index);
    const id = await input.getAttribute('id');
    expect(id).toBeTruthy();
    await expect(page.locator(`label[for="${id}"]`)).toHaveCount(1);
  }

  await page.locator('body').press('Tab');
  const activeTag = await page.evaluate(() => document.activeElement?.tagName ?? '');
  expect(activeTag).not.toBe('BODY');
  await assertNoHorizontalOverflow(page);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(networkErrors).toEqual([]);
});

for (const viewport of [
  { name: 'mobile 390x844', width: 390, height: 844 },
  { name: 'small mobile 360x740', width: 360, height: 740 },
]) {
  test(`${viewport.name} keeps fields readable, scrollable and touchable`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await installFixtures(page);

    await openWorkspace(page);
    await assertNoHorizontalOverflow(page);

    const panel = page.getByTestId('trading-risk-preview-panel');
    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox!.x).toBeGreaterThanOrEqual(0);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(viewport.width + 1);

    const entry = page.getByLabel('진입가 · markPrice 기준');
    await entry.fill('101.25');
    await expect(entry).toHaveValue('101.25');
    await entry.fill('1e3');
    await expect(entry).toHaveValue('13');
    await entry.fill('101.25');

    const dailyPnl = page.getByLabel('일일 실현손익');
    await dailyPnl.fill('-4.5');
    await expect(dailyPnl).toHaveValue('-4.5');

    const calculateButton = page.getByRole('button', { name: '리스크 미리보기 계산' });
    await calculateButton.scrollIntoViewIfNeeded();
    await calculateButton.tap();
    await expect(page.getByTestId('risk-result')).toBeVisible();
    await expect(page.getByText('차단 이유').or(page.getByText('분석 시나리오 진입 가능'))).toBeVisible();

    const buttonBox = await calculateButton.boundingBox();
    expect(buttonBox).not.toBeNull();
    const hitTarget = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return element?.closest('button')?.textContent ?? '';
    }, {
      x: buttonBox!.x + buttonBox!.width / 2,
      y: Math.min(viewport.height - 1, buttonBox!.y + buttonBox!.height / 2),
    });
    expect(hitTarget).toContain('리스크 미리보기');

    const warningRegion = page.getByRole('status', { name: '계약 규칙 경고' });
    await expect(warningRegion).toBeVisible();
    const warningScroll = await warningRegion.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(warningScroll.scrollHeight).toBeGreaterThanOrEqual(warningScroll.clientHeight);

    await assertNoHorizontalOverflow(page);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}

test('contract rule error and null values are visible without stale results', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/crypto/futures/BTCUSDT/contract-rules')) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'FUTURES_CONTRACT_RULES_UNAVAILABLE' }) });
      return;
    }
    if (url.pathname.endsWith('/crypto/futures/BTCUSDT/snapshot')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { symbol: 'BTCUSDT', markPrice: 100, fundingRate: null, status: 'live', warnings: [], source: 'bitget', updatedAt: FIXED_AT } }) });
      return;
    }
    if (url.pathname.endsWith('/crypto/futures/status')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, provider: 'bitget', market: 'crypto-futures', status: 'live', connection: 'live', publicDataOnly: true, orderCapability: false, symbolCount: 1, updatedAt: FIXED_AT, warnings: [] }) });
      return;
    }
    if (url.pathname.endsWith('/crypto/futures/tickers')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tickers: [{ symbol: 'BTCUSDT', markPrice: 100, price: 100 }] }) });
      return;
    }
    if (url.pathname.includes('/candles')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candles: candleRows() }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: [], positions: [], accounts: [] }) });
  });

  await page.goto('/__phase4-risk-e2e');
  await page.getByTestId('trading-risk-preview-panel').scrollIntoViewIfNeeded();
  await expect(page.getByText('거래소 계약 규칙을 불러오지 못했습니다.')).toBeVisible();
  await expect(page.getByText('거래소 최소 주문 규칙을 확인할 수 없습니다.')).toBeVisible();
  await expect(page.getByTestId('contract-rules-card').getByText('확인 불가').first()).toBeVisible();
  await expect(page.getByTestId('risk-result')).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
});
