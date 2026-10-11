import { expect, test } from '@playwright/test';

const fixturePath = '/__original-minute-backtest-e2e';
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 360, height: 800 }]) {
  test(`original minute research: ${viewport.width}px selected period, cost assumptions and source-only result`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const apiCalls: string[] = []; page.on('request', request => { if (request.url().includes('/api/backtests')) apiCalls.push(request.url()); });
    await page.goto(fixturePath);
    await expect(page.getByRole('heading', { name: '원본 1분봉 기간 연구' })).toBeVisible();
    await expect(page.getByTestId('original-minute-no-result')).toContainText('아직 수익률이나 거래 수를 계산하지 않았습니다');
    await expect(page.getByTestId('original-minute-omitted-costs')).toContainText('0%로 미반영된 비용');
    await page.getByLabel('기간 선택', { exact: true }).selectOption('10y');
    const start = await page.getByLabel('시작일 (포함)', { exact: true }).inputValue();
    const end = await page.getByLabel('종료일 (포함)', { exact: true }).inputValue();
    expect(Date.parse(end) - Date.parse(start)).toBeGreaterThan(9 * 365 * 86400000);
    await page.getByLabel('기간 선택', { exact: true }).selectOption('1m');
    await page.getByRole('button', { name: '원본 연구 수동 실행', exact: true }).click();
    await expect(page.getByTestId('original-minute-status')).toHaveText('연구 모델 계산 완료');
    await expect(page.getByTestId('original-minute-modeled-return')).toHaveText('1.5%');
    await expect(page.getByTestId('original-minute-source-kind')).toContainText('테스트용 원본');
    await expect(page.getByTestId('original-minute-research-hold')).toContainText('자동모의매매 진입 차단');
    await expect(page.getByTestId('original-minute-horizons')).toContainText('미확인 · 자료 부족');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]); expect(apiCalls).toEqual([]);
  });
}

test('cash market direction/funding constraints and explicit non-KRW FX', async ({ page }) => {
  await page.goto(fixturePath);
  await page.getByLabel('시장', { exact: true }).selectOption('CRYPTO_FUTURES');
  await page.getByLabel('진입 방향', { exact: true }).selectOption('SHORT');
  await expect(page.getByLabel('고정 환율 (1 USDT당 원)', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '원본 연구 수동 실행', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('빈 값은 0으로 처리하지 않습니다');
  await page.getByLabel('시장', { exact: true }).selectOption('KR_STOCK');
  await expect(page.getByLabel('진입 방향', { exact: true })).toHaveValue('LONG');
  await expect(page.getByLabel('진입 방향', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('레버리지 (배)', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('재생 시간봉', { exact: true }).locator('option[value="1d"]')).toHaveCount(0);
});
test('source gap is visible without a fabricated zero return or result', async ({ page }) => {
  await page.goto(`${fixturePath}?scenario=blocked`);
  await page.getByRole('button', { name: '원본 연구 수동 실행', exact: true }).click();
  await expect(page.getByTestId('original-minute-status')).toHaveText('자료 확인 필요 · 실행 차단');
  await expect(page.getByTestId('original-minute-unverified-result')).toContainText('수익률 · 거래 수: 미확인');
  await expect(page.getByTestId('original-minute-modeled-return')).toHaveCount(0);
  await expect(page.getByTestId('original-minute-result')).toContainText('ORIGINAL_PERIOD_PRIVATE_SESSION_INDEX_UNAVAILABLE');
});
test('manual cancel waits for terminal state and changing selection discards a late response', async ({ page }) => {
  await page.goto(`${fixturePath}?scenario=slow`);
  await page.getByRole('button', { name: '원본 연구 수동 실행', exact: true }).click();
  await expect(page.getByTestId('original-minute-status')).toHaveText('원본 검증·연구 실행 중');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(page.getByTestId('original-minute-status')).toHaveText('실행 취소됨');
  await page.goto(`${fixturePath}?scenario=slow-accept`);
  await page.getByRole('button', { name: '원본 연구 수동 실행', exact: true }).click();
  await page.getByLabel('원본 종목 코드', { exact: true }).fill('KRW-ETH');
  await expect(page.getByTestId('original-minute-no-result')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('original-minute-result')).toHaveCount(0);
});
test('a response that promotes profitability is rejected before rendering', async ({ page }) => {
  await page.goto(`${fixturePath}?scenario=invalid`);
  await page.getByRole('button', { name: '원본 연구 수동 실행', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('응답의 연구·권한 계약이 일치하지 않아');
  await expect(page.getByTestId('original-minute-modeled-return')).toHaveCount(0);
  await expect(page.getByTestId('original-minute-status')).toHaveText('원본 검증·연구 실행 중');
});
