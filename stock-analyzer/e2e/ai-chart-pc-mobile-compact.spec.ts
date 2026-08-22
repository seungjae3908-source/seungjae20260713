import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

const chartUrl = '/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m&strategyMode=SCALPING';

function selectionFixture() {
  return {
    assetType: 'stock',
    market: 'KR',
    symbol: '005930',
    ticker: '005930',
    displayName: '삼성전자',
    timeframe: '5m',
    signalScore: 82,
    confidence: 71,
    riskLevel: '보통',
    action: 'BUY',
    pricePlan: {
      entryZone: { from: 70_000, to: 70_500 },
      stopLoss: 68_000,
      invalidation: 67_500,
      targets: [74_000, 77_000],
      riskReward: 2.1,
    },
    reasons: ['추세와 거래량 조건이 함께 확인됨'],
    selectedAt: new Date().toISOString(),
  };
}

async function primeSelection(page: Parameters<typeof test>[0]['page']) {
  await page.addInitScript((selection) => {
    window.localStorage.setItem('sa-analysis-selection-v1', JSON.stringify(selection));
  }, selectionFixture());
}

test('AI Chart source keeps desktop dense and mobile summary-first', () => {
  const pageSource = source('src/pages/ai-chart.tsx');

  expect(pageSource).toContain("type MobileChartTab = 'summary' | 'chart' | 'position' | 'details';");
  expect(pageSource).toContain("{ value: 'summary', label: '요약' }");
  expect(pageSource).toContain("{ value: 'chart', label: '차트' }");
  expect(pageSource).toContain("{ value: 'position', label: '내 포지션' }");
  expect(pageSource).toContain("{ value: 'details', label: '상세' }");
  expect(pageSource).toContain("const [mobileTab, setMobileTab] = useState<MobileChartTab>('summary');");
  expect(pageSource).toContain('lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]');
  expect(pageSource).toContain('data-testid="ai-chart-mobile-summary"');
  expect(pageSource).toContain('data-testid="ai-chart-mobile-chart"');
  expect(pageSource).toContain('data-testid="ai-chart-mobile-position"');
  expect(pageSource).toContain('data-testid="ai-chart-mobile-details"');
  expect(pageSource).toContain('읽기 전용 · 주문 실행 없음');
  expect(pageSource).toContain("if (mode === 'SCALPING') return '단타';");
  expect(pageSource).toContain("if (mode === 'SWING') return '스윙';");
  expect(pageSource).not.toContain('<p>{strategyMode} · 공개 시세 읽기 전용</p>');
});

for (const width of [360, 390, 412, 430]) {
  test(`mobile ${width}px opens compact summary without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await primeSelection(page);
    await page.goto(chartUrl);

    await expect(page.getByTestId('ai-chart-mobile-tabs')).toBeVisible();
    await expect(page.getByTestId('ai-chart-mobile-summary')).toBeVisible();
    await expect(page.getByTestId('ai-chart-mobile-summary')).toContainText('매수');
    await expect(page.getByTestId('ai-chart-mobile-summary')).toContainText('진입');
    await expect(page.getByTestId('ai-chart-mobile-summary')).toContainText('손절');
    await expect(page.getByTestId('ai-chart-mobile-summary')).toContainText('목표 1');
    await expect(page.getByTestId('unified-chart-canvas')).toHaveCount(0);

    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      body: document.body.scrollWidth,
      root: document.documentElement.scrollWidth,
    }));
    expect(overflow.body).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.root).toBeLessThanOrEqual(overflow.viewport);
  });
}

test('mobile tabs mount only the selected heavy surface', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await primeSelection(page);
  await page.goto(chartUrl);

  await expect(page.getByTestId('ai-chart-mobile-summary')).toBeVisible();
  await page.getByRole('tab', { name: '차트' }).click();
  await expect(page.getByTestId('ai-chart-mobile-chart')).toBeVisible();
  await expect(page.getByTestId('ai-chart-mobile-summary')).toHaveCount(0);
  await expect(page.getByTestId('ai-chart-position-panel')).toBeHidden();

  await page.getByRole('tab', { name: '내 포지션' }).click();
  await expect(page.getByTestId('ai-chart-mobile-position')).toBeVisible();
  await expect(page.getByTestId('ai-chart-position-panel')).toBeVisible();
  await expect(page.getByTestId('ai-chart-position-panel')).toContainText('내 포지션 확인');
  await expect(page.getByTestId('ai-chart-mobile-chart')).toHaveCount(0);

  await page.getByRole('tab', { name: '상세' }).click();
  await expect(page.getByTestId('ai-chart-mobile-details')).toBeVisible();
  await expect(page.getByText('읽기 전용 · 확정된 근거만 표시 · 주문 실행 없음')).toBeVisible();
});

test('desktop keeps the chart and analysis side by side without mobile tabs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await primeSelection(page);
  await page.goto(chartUrl);

  await expect(page.getByTestId('ai-chart-mobile-tabs')).toHaveCount(0);
  await expect(page.getByText('현재 상태')).toBeVisible();
  await expect(page.getByText('현재 판단')).toBeVisible();
  await expect(page.getByText('단타 · 읽기 전용')).toBeVisible();
});
