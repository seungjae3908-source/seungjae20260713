import { test, expect } from '@playwright/test';

for (const width of [360, 390, 430]) {
  test(`trade approval queue fits ${width}px mobile and fails closed`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/__phase12-trade-automation-e2e');
    await expect(page.getByRole('heading', { name: '승인형 주문', exact: true })).toBeVisible();
    await expect(page.getByText('기본값은 모두 OFF이며 AI 채팅은 주문 권한이 없습니다.')).toBeVisible();
    await expect(page.getByTestId('connection-bitget')).toContainText('Paper 연결됨');
    await expect(page.getByTestId('approval-plan-ready-plan')).toContainText('승인 가능');
    await expect(page.getByTestId('approval-plan-invalid-plan')).toContainText('신호 무효');
    await expect(page.getByTestId('approve-plan-ready-plan')).toBeEnabled();
    await expect(page.getByTestId('approve-plan-invalid-plan')).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

test('automatic mode requires a detailed confirmation and emergency stop returns to off', async ({ page }) => {
  await page.goto('/__phase12-trade-automation-e2e');
  await page.getByRole('button', { name: /자동매매/ }).click();
  await page.getByRole('button', { name: 'Bitget 선물 활성화' }).click();
  await page.getByLabel('Bitget 선물 허용 자산').fill('BTC');
  await page.getByLabel('Bitget 레버리지').selectOption('3');
  await page.getByRole('button', { name: '설정 저장' }).click();
  const dialog = page.getByRole('dialog', { name: '자동매매 최종 확인' });
  await expect(dialog).toContainText('실제 자금');
  await expect(dialog).toContainText('Bitget 선물');
  await expect(dialog).toContainText('1,000,000원');
  await expect(dialog).toContainText('3배');
  await expect(dialog).toContainText('긴급정지');
  await dialog.getByRole('button', { name: '위험 확인 및 저장' }).click();
  await expect(page.getByRole('status')).toContainText('저장');
  await page.getByRole('button', { name: '긴급정지' }).click();
  await expect(page.getByRole('status')).toContainText('신규 주문이 차단');
});
