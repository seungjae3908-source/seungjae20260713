import type { Page } from '@playwright/test';
import { expect, test } from './support/full-product-evidence';
import { ageBrowserSession, installFullProductFixtures } from './support/full-product-fixtures';

async function openMenuItem(page: Page, group: string, item: string) {
  const trigger = page.getByRole('button', { name: group, exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const menuItem = page.getByRole('menuitem', { name: item, exact: true });
  await expect(menuItem).toBeVisible();
  await menuItem.click();
}

test('real user path stays coherent from login through session expiry', async ({ page }) => {
  const fixtures = await installFullProductFixtures(page);

  await page.goto('/login');
  await expect(page.locator('#login-name')).toBeVisible();
  await page.locator('#login-name').fill('full-product-e2e');
  await page.locator('#login-password').fill('Browser-E2E-911!');
  await page.locator('form').getByRole('button', { name: '로그인', exact: true }).click();

  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByRole('navigation', { name: '주요 메뉴' })).toBeVisible();

  await openMenuItem(page, '종목', '통합검색');
  await expect(page).toHaveURL(/\/stocks$/u);
  await expect(page.getByTestId('unified-asset-search-page')).toBeVisible();
  const search = page.getByRole('combobox', { name: '통합 자산 검색' });
  await search.fill('삼성전자');
  const samsung = page.getByRole('option').filter({ hasText: '삼성전자' }).first();
  await expect(samsung).toBeVisible();
  await expect(samsung).toContainText('005930');

  await openMenuItem(page, '기술', 'AI 차트');
  await expect(page).toHaveURL(/\/ai-chart/u);
  const chartTab = page.getByRole('tab', { name: '차트', exact: true });
  await expect(chartTab).toBeVisible();
  await chartTab.click();
  await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();

  await openMenuItem(page, '설정', '계정');
  await expect(page).toHaveURL(/\/account$/u);
  await expect(page.getByTestId('brokerage-account-connections')).toBeVisible();
  await expect(page.getByTestId('connection-toss')).toContainText('연결됨');
  await expect(page.getByTestId('connection-upbit')).toContainText('연결됨');
  await expect(page.getByTestId('connection-bitget')).toContainText('연결됨');
  await expect(page.getByTestId('brokerage-account-connections')).toContainText('실주문/취소/이체/출금 0건');

  await openMenuItem(page, '정보', '포트폴리오');
  await expect(page).toHaveURL(/\/portfolio$/u);
  await expect(page.getByRole('heading', { name: '내 포트폴리오', exact: true })).toBeVisible();
  await expect(page.getByTestId('portfolio-data-quality')).toContainText('PARTIAL');

  await openMenuItem(page, '기술', '모의매매');
  await expect(page).toHaveURL(/\/paper-trading$/u);
  await expect(page.getByTestId('paper-trading-shell')).toBeVisible();

  await openMenuItem(page, '정보', '연구센터');
  await expect(page).toHaveURL(/\/research-center$/u);
  await expect(page.getByRole('navigation', { name: '연구센터 작업 영역' })).toBeVisible();
  await expect(page.getByTestId('research-overview-tab')).toBeVisible();
  await expect(page.getByText('수익성 검증', { exact: true })).toBeVisible();
  await expect(page.getByText('미검증', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/research-center$/u);
  await expect(page.getByTestId('research-overview-tab')).toBeVisible();

  await openMenuItem(page, '정보', '포트폴리오');
  await expect(page.getByRole('heading', { name: '내 포트폴리오', exact: true })).toBeVisible();

  fixtures.expireSession();
  await ageBrowserSession(page);
  await page.reload();
  await expect(page).toHaveURL(/\/login$/u);
  await expect(page.locator('#login-name')).toBeVisible();
});
