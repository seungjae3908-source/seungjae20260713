import { test, expect, type Page } from '@playwright/test';

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function openAt(page: Page, width: number, height: number, path = '/__phase6-paper-trading-e2e') {
  await page.setViewportSize({ width, height });
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(path);
  await expect(page.getByTestId('paper-trading-page')).toBeVisible();
  await expect(page.getByText('모의매매입니다. 실제 거래소 주문은 전송되지 않습니다.')).toBeVisible();
  await expect.poll(() => errors).toEqual([]);
  await assertNoHorizontalOverflow(page);
  return errors;
}

test('desktop creates, partially closes, fully closes and journals a paper position', async ({ page }) => {
  const errors = await openAt(page, 1440, 900);
  await page.getByTestId('paper-submit').click();
  await expect(page.getByRole('dialog', { name: '모의주문 확인' })).toBeVisible();
  await page.getByTestId('confirm-paper-order').click();
  await expect(page.getByTestId('paper-positions').getByText('BTCUSDT 롱')).toBeVisible();
  await page.getByTestId('paper-positions').getByRole('button', { name: '25%' }).click();
  await expect(page.getByTestId('paper-positions').getByText('partially_closed')).toBeVisible();
  await page.getByTestId('paper-positions').getByRole('button', { name: '전체청산' }).click();
  await expect(page.getByTestId('paper-positions').getByText('열린 모의포지션이 없습니다.')).toBeVisible();
  await expect(page.getByTestId('paper-journal').getByText(/BTCUSDT long/)).toBeVisible();
  await expect.poll(() => errors).toEqual([]);
  await assertNoHorizontalOverflow(page);
});

test('limit paper order stays pending and can be cancelled', async ({ page }) => {
  await openAt(page, 1440, 900);
  await page.getByLabel('주문 유형').selectOption('limit');
  await page.getByTestId('paper-submit').click();
  await page.getByTestId('confirm-paper-order').click();
  await expect(page.getByTestId('paper-orders').getByText(/pending/)).toBeVisible();
  await page.getByTestId('paper-orders').getByRole('button', { name: '취소' }).click();
  await expect(page.getByTestId('paper-orders').getByText(/cancelled/)).toBeVisible();
});

test('state restores after reload', async ({ page }) => {
  await openAt(page, 1440, 900);
  await page.getByTestId('paper-submit').click();
  await page.getByTestId('confirm-paper-order').click();
  await expect(page.getByText('BTCUSDT 롱')).toBeVisible();
  await page.reload();
  await expect(page.getByText('BTCUSDT 롱')).toBeVisible();
});

test('JSON export creates a download', async ({ page }) => {
  await openAt(page, 1440, 900);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON 내보내기' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^paper-trading-.*\.json$/);
});

for (const viewport of [
  { name: 'mobile 390x844', width: 390, height: 844 },
  { name: 'small mobile 360x740', width: 360, height: 740 },
]) {
  test(`${viewport.name} keeps order dialog and controls usable`, async ({ page }) => {
    const errors = await openAt(page, viewport.width, viewport.height);
    await page.getByTestId('paper-submit').tap();
    const dialog = page.getByRole('dialog', { name: '모의주문 확인' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('confirm-paper-order')).toBeInViewport();
    await dialog.getByTestId('confirm-paper-order').tap();
    await expect(page.getByText('BTCUSDT 롱')).toBeVisible();
    await expect.poll(() => errors).toEqual([]);
    await assertNoHorizontalOverflow(page);
  });
}

test('short paper position uses valid directional risk fields', async ({ page }) => {
  await openAt(page, 1440, 900);
  await page.getByLabel('롱·숏').selectOption('short');
  await expect(page.getByText('숏 손절가는 진입가보다 높아야 합니다.')).toHaveCount(0);
  await page.getByTestId('paper-submit').click();
  await page.getByTestId('confirm-paper-order').click();
  await expect(page.getByTestId('paper-positions').getByText('BTCUSDT 숏')).toBeVisible();
});

test('direct quantity closes only the requested portion', async ({ page }) => {
  await openAt(page, 1440, 900);
  await page.getByTestId('paper-submit').click();
  await page.getByTestId('confirm-paper-order').click();
  await page.getByLabel('BTCUSDT 직접 청산 수량').fill('0.002');
  await page.getByRole('button', { name: '수량 청산' }).click();
  await expect(page.getByTestId('paper-positions').getByText('partially_closed')).toBeVisible();
});

test('execution error clears busy state and renders safe alert', async ({ page }) => {
  await openAt(page, 390, 844, '/__phase6-paper-trading-e2e?mode=error');
  await page.getByTestId('paper-submit').tap();
  await page.getByTestId('confirm-paper-order').tap();
  await expect(page.getByRole('alert')).toContainText('모의거래 fixture 오류입니다.');
  await expect(page.getByTestId('paper-submit')).toBeEnabled();
});

test('invalid stop blocks confirmation path', async ({ page }) => {
  await openAt(page, 390, 844);
  await page.getByLabel('손절가').fill('200000');
  await expect(page.getByText('롱 손절가는 진입가보다 낮아야 합니다.')).toBeVisible();
  await expect(page.getByTestId('paper-submit')).toBeDisabled();
});

test('two-step reset clears restored state', async ({ page }) => {
  await openAt(page, 390, 844);
  await page.getByTestId('paper-submit').tap(); await page.getByTestId('confirm-paper-order').tap();
  await page.getByRole('button', { name: '전체 초기화' }).tap();
  const dialog = page.getByRole('dialog', { name: '전체 초기화 확인' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '2단계 초기화' }).tap();
  await expect(page.getByTestId('paper-orders').getByText('모의주문이 없습니다.')).toBeVisible();
});
