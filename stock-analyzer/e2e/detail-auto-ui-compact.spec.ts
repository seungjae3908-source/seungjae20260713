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

test('auto trading uses Korean-first compact copy and desktop two-column layout', () => {
  const auto = source('src/pages/auto-trading.tsx');

  expect(auto).toContain('<CenteredPageHeader title="자동매매" />');
  expect(auto).not.toContain('eyebrow="승인형 주문"');
  expect(auto).toContain('label="위험검사" value="매 주문 재검증"');
  expect(auto).toContain('<h2 className="text-base font-bold">자동매매 실행 방식</h2>');
  expect(auto).toContain('min-[1200px]:grid-cols-[minmax(0,1.05fr)_minmax(380px,0.95fr)]');
  expect(auto).toContain('data-testid="auto-trading-settings-column"');
  expect(auto).toContain('<span>자동매매 · 시장별 설정</span>');
  expect(auto).toContain('<span>알림 · 텔레그램</span>');
  expect(auto).not.toContain('Risk Engine');
  expect(auto).not.toContain('infoItems={[');
  expect(auto).not.toContain('화면 버튼만으로 실전 주문이 제출되지 않습니다.');
});

for (const width of [360, 390, 412, 430]) {
  test(`auto trading mobile ${width}px has no horizontal overflow or status overlap`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/__phase12-trade-automation-e2e');

    const safety = page.getByTestId('auto-trading-safety-summary');
    await expect(safety).toBeVisible();
    await expect(safety).toContainText('자동매매 실행 방식');
    await expect(safety).toContainText('주문별 승인');
    await expect(safety).toContainText('불필요');
    await expect(safety).toContainText('위험검사');
    await expect(safety).not.toContainText('Risk Engine');

    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      body: document.body.scrollWidth,
      root: document.documentElement.scrollWidth,
    }));
    expect(overflow.body).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.root).toBeLessThanOrEqual(overflow.viewport);
  });
}

test('auto trading desktop places settings beside the safety and runtime column', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/__phase12-trade-automation-e2e');

  const layout = page.getByTestId('auto-trading-responsive-layout');
  const safety = page.getByTestId('auto-trading-safety-summary');
  const settings = page.getByTestId('auto-trading-settings-column');

  await expect(layout).toBeVisible();
  await expect(safety).toBeVisible();
  await expect(settings).toBeVisible();

  const safetyBox = await safety.boundingBox();
  const settingsBox = await settings.boundingBox();
  expect(safetyBox).not.toBeNull();
  expect(settingsBox).not.toBeNull();
  if (safetyBox && settingsBox) {
    expect(settingsBox.x).toBeGreaterThan(safetyBox.x + safetyBox.width - 1);
  }
});
