import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

const chartUrl = '/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m&strategyMode=SCALPING';

function candleRows() {
  const end = Date.now() - 5 * 60_000;
  return Array.from({ length: 90 }, (_, index) => {
    const base = 70_000 + index * 20;
    return {
      time: new Date(end - (89 - index) * 5 * 60_000).toISOString(),
      open: base - 10,
      high: base + 80,
      low: base - 80,
      close: base + 30,
      volume: 1_000 + index * 25,
      isClosed: true,
    };
  });
}

test('AI Chart position panel stays explicit read-only and fail-closed', () => {
  const panel = source('src/components/ai-chart-position-panel.tsx');

  expect(panel).toContain("import { authorizedFetch } from '@/lib/auth-fetch';");
  expect(panel).toContain('authorizedFetch(`/api/accounts/read-only/${provider}`');
  expect(panel).toContain('data-testid="ai-chart-load-position"');
  expect(panel).toContain('onClick={() => void loadPosition()}');
  expect(panel).toContain('차트를 열기만 해서는 계좌를 조회하지 않습니다.');
  expect(panel).not.toContain('void loadPosition();');

  expect(panel).toContain('candidate.provider !== provider');
  expect(panel).toContain("code: 'ACCOUNT_SNAPSHOT_PROVIDER_MISMATCH'");
  expect(panel).toContain('candidate.connected !== true');
  expect(panel).toContain("candidate.errorCode || candidate.status || 'ACCOUNT_NOT_CONNECTED'");
  expect(panel).toContain('snapshot.orderRequests !== 0');
  expect(panel).toContain('snapshot.cancelRequests !== 0');
  expect(panel).toContain('snapshot.amendRequests !== 0');
  expect(panel).toContain('snapshot.transferRequests !== 0');
  expect(panel).toContain('snapshot.withdrawalRequests !== 0');
  expect(panel).toContain('snapshot.liveTradingEnabled !== false');
  expect(panel).toContain('snapshot.autoTradingEnabled !== false');
  expect(panel).toContain("code: 'ACCOUNT_SNAPSHOT_SAFETY_MISMATCH'");

  expect(panel).not.toContain("method: 'POST'");
  expect(panel).not.toContain("method: 'PUT'");
  expect(panel).not.toContain("method: 'PATCH'");
  expect(panel).not.toContain("method: 'DELETE'");
});

test('AI Chart matches four-market positions without inventing missing values', () => {
  const panel = source('src/components/ai-chart-position-panel.tsx');

  expect(panel).toContain("if (market === 'UPBIT') return 'upbit';");
  expect(panel).toContain("if (market === 'BITGET') return 'bitget';");
  expect(panel).toContain("return 'toss';");
  expect(panel).toContain("if (upper.startsWith('KRW-'))");
  expect(panel).toContain('positionMarketMatches(market, position.market)');
  expect(panel).toContain('if (matches.length > 1) return { position: null, ambiguous: true };');
  expect(panel).toContain("code: 'MULTIPLE_MATCHING_POSITIONS'");
  expect(panel).toContain("return parsed == null ? '미제공'");
  expect(panel).toContain('평단 대비 가격은 차트/계좌 가격의 단순 가격거리이며 수수료·레버리지 ROE를 임의 계산하지 않습니다.');
});

test('AI Chart draws only evidence-backed average-entry and liquidation position lines', () => {
  const canvas = source('src/components/pattern-aware-unified-chart-canvas.tsx');

  expect(canvas).toContain('positionPriceLines: IPriceLine[];');
  expect(canvas).toContain('removePriceLines(instance.candle, instance.positionPriceLines);');
  expect(canvas).toContain("title: positionOverlay.stale ? '내 평단 · 오래된 값' : '내 평단'");
  expect(canvas).toContain("market === 'BITGET' && validPlanPrice(liquidation)");
  expect(canvas).toContain("title: positionOverlay.stale ? '청산가 · 오래된 값' : '청산가'");
  expect(canvas).toContain('data-position-average={positionOverlay?.position.averageEntryPrice ?? \'\'}');
  expect(canvas).toContain('data-position-liquidation={positionOverlay?.position.liquidationPrice ?? \'\'}');

  expect(canvas).toContain("title: 'Scanner 손절'");
  expect(canvas).toContain('title: `Scanner 목표 ${index + 1}`');
});

test('desktop AI Chart reads the Toss position only after an explicit click and renders the average line', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  let accountReads = 0;
  const financialMutations: string[] = [];

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (/\/(orders?|cancel|amend|transfer|withdraw)(?:\/|\?|$)/i.test(url.pathname) && request.method() !== 'GET') {
      financialMutations.push(`${request.method()} ${url.pathname}`);
    }
    if (/\/api\/stocks\/[^/]+\/(?:chart|candles)$/.test(url.pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ticker: '005930',
          timeframe: url.searchParams.get('tf') ?? '5m',
          provider: 'position-overlay-fixture',
          fetchedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          candles: candleRows(),
        }),
      });
      return;
    }
    if (url.pathname === '/api/quotes') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ quotes: [] }) });
      return;
    }
    if (url.pathname === '/api/accounts/read-only/toss') {
      accountReads += 1;
      expect(request.method()).toBe('GET');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          provider: 'toss',
          readOnly: true,
          connected: true,
          status: 'CONNECTED',
          positions: [{
            market: 'KR',
            symbol: '005930',
            quantity: 20,
            availableQuantity: 20,
            averageEntryPrice: 70_000,
            currentPrice: 72_100,
            marketValue: 1_442_000,
            unrealizedPnl: 42_000,
            unrealizedPnlPercent: 3,
            leverage: null,
            liquidationPrice: null,
            marginMode: null,
            side: null,
          }],
          checkedAt: new Date().toISOString(),
          lastGoodAt: new Date().toISOString(),
          stale: false,
          errorCode: null,
          orderRequests: 0,
          cancelRequests: 0,
          amendRequests: 0,
          transferRequests: 0,
          withdrawalRequests: 0,
          liveTradingEnabled: false,
          autoTradingEnabled: false,
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(chartUrl);
  const panel = page.getByTestId('ai-chart-position-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('차트를 열기만 해서는 계좌를 조회하지 않습니다.');
  expect(accountReads).toBe(0);

  await page.getByTestId('ai-chart-load-position').click();
  await expect.poll(() => accountReads).toBe(1);
  await expect(panel).toContainText('내 평단');
  await expect(panel).toContainText('70,000원');
  await expect(panel).toContainText('20');
  await expect(panel).toContainText('+42,000원');
  await expect(page.getByTestId('unified-chart-wrapper')).toHaveAttribute('data-position-average', '70000');

  await page.getByTestId('ai-chart-toggle-position-lines').click();
  await expect(page.getByTestId('unified-chart-wrapper')).toHaveAttribute('data-position-average', '');
  expect(financialMutations).toEqual([]);
});
