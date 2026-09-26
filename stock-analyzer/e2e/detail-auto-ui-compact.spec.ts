import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('stock detail removes long primary guidance and blocking skeleton UI', () => {
  const detail = source('src/pages/detail.tsx');

  expect(detail).toContain('function LoadingStatus');
  expect(detail).toContain("summaryLoading ? '확인 중' : '미확인'");
  expect(detail).toContain('label="차트 준비 중"');
  expect(detail).toContain('label="뉴스 확인 중"');
  expect(detail).toContain('label="상세 준비 중"');
  expect(detail).toContain('최신 뉴스 없음');
  expect(detail).not.toContain('infoItems={[');
  expect(detail).not.toContain('animate-pulse');
  expect(detail).not.toContain('현재가 정보를 불러오지 못했습니다.');
});

test('trading workspace unifies auto, paper, four markets, journal and selected-market settings', () => {
  const auto = source('src/pages/auto-trading.tsx');
  const paper = source('src/pages/paper-trading.tsx');
  const settings = source('src/components/trade-automation-settings.tsx');
  const journal = source('src/components/unified-trade-journal-panel.tsx');

  expect(auto).toContain('<CenteredPageHeader title="매매" />');
  expect(auto).toContain('data-testid="trading-mode-tabs"');
  expect(auto).toContain('자동매매</SegmentedButton>');
  expect(auto).toContain('모의매매</SegmentedButton>');
  for (const label of ['국내주식', '미국주식', '코인현물', '코인선물']) expect(auto).toContain(label);
  for (const label of ['대시보드', '포지션·주문', '매매일지', '설정']) expect(auto).toContain(label);
  expect(auto).toContain("forcedSource={mode === 'auto' ? 'APP_AUTO' : 'APP_PAPER'}");
  expect(auto).toContain('selectedMarket={market}');
  expect(auto).toContain("initialMode === 'paper' ? 'paper-trading-shell' : 'auto-trading-page'");
  expect(paper).toContain('<AutoTradingPage initialMode="paper" />');
  expect(settings).toContain('selectedMarket?: Market');
  expect(settings).toContain('visibleMarkets');
  expect(settings).toContain('visibleExchanges');
  expect(journal).toContain('forcedMarket?: UnifiedJournalFilters');
  expect(journal).toContain('forcedSource?: UnifiedJournalFilters');
  expect(auto).not.toContain('min-[1200px]:grid-cols-[minmax(0,1.05fr)_minmax(380px,0.95fr)]');
});

for (const width of [360, 390, 412, 430]) {
  test(`trading workspace mobile ${width}px has no horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/__phase12-trade-automation-e2e');

    await expect(page.getByTestId('trading-mode-tabs')).toBeVisible();
    await expect(page.getByTestId('trading-mode-auto')).toContainText('자동매매');
    await expect(page.getByTestId('trading-mode-paper')).toContainText('모의매매');

    const safety = page.getByTestId('auto-trading-safety-summary');
    await expect(safety).toBeVisible();
    await expect(safety).toContainText('자동매매 실행 방식');
    await expect(safety).toContainText('주문별 승인');
    await expect(safety).toContainText('불필요');
    await expect(safety).toContainText('위험검사');

    for (const market of ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures']) {
      await expect(page.getByTestId(`trading-market-${market}`)).toBeVisible();
    }

    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      body: document.body.scrollWidth,
      root: document.documentElement.scrollWidth,
    }));
    expect(overflow.body).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.root).toBeLessThanOrEqual(overflow.viewport);
  });
}

test('desktop settings follow the selected market instead of showing all provider controls at once', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/__phase12-trade-automation-e2e');

  await page.getByTestId('trading-section-settings').click();
  await expect(page.getByTestId('auto-trading-settings-column')).toBeVisible();
  await expect(page.getByTestId('auto-market-domestic_stock')).toBeVisible();
  await expect(page.getByTestId('stock-broker-domestic_stock')).toBeVisible();
  await expect(page.getByTestId('stock-broker-us_stock')).toHaveCount(0);

  await page.getByTestId('trading-market-crypto_futures').click();
  await expect(page.getByTestId('auto-market-crypto_futures')).toBeVisible();
  await expect(page.getByTestId('stock-broker-routing')).toHaveCount(0);
  await expect(page.getByLabel('Bitget 레버리지')).toBeVisible();
  await expect(page.getByTestId('connection-bitget')).toBeVisible();
  await expect(page.getByTestId('connection-kiwoom')).toHaveCount(0);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
