import { expect, test, type Page } from '@playwright/test';

const PATH = '/__phase7-journal-sync-e2e';

async function open(page: Page) {
  await page.goto(PATH);
  await expect(page.getByTestId('phase7-e2e-page')).toBeVisible();
}

function captureErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('desktop renders sync status and privacy notices', async ({ page }) => {
  const errors = captureErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await expect(page.getByTestId('journal-sync-status')).toContainText('거래일지 동기화');
  await expect(page.getByTestId('review-dataset-status')).toContainText('현재 단계에서는 거래기록을 외부 AI로 전송하지 않습니다.');
  await expect(page.getByTestId('review-dataset-status')).toContainText('개인정보를 제외한 구조화된 복기 데이터만 준비합니다.');
  expect(errors).toEqual([]);
});

test('successful sync reports completion without order fields changing', async ({ page }) => {
  await open(page);
  await page.getByTestId('journal-sync-button').click();
  await expect(page.getByRole('status')).toContainText('동기화했습니다');
  await expect(page.getByTestId('journal-sync-status')).toContainText('동기화 완료');
});

test('sync failure remains visible and local data stays retryable', async ({ page }) => {
  await open(page);
  await page.getByLabel('시나리오').selectOption('failure');
  await page.getByTestId('journal-sync-button').click();
  await expect(page.getByRole('alert')).toContainText('테스트 동기화 실패');
  await expect(page.getByTestId('journal-sync-status')).toContainText('일부 실패');
  await expect(page.getByTestId('journal-sync-button')).toBeEnabled();
});

test('offline mode preserves local workflow and avoids automatic retry', async ({ page, context }) => {
  await open(page);
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText('오프라인입니다. 모의매매와 로컬 거래일지는 계속 사용할 수 있으며 자동 무한 재시도하지 않습니다.')).toBeVisible();
  await page.getByTestId('journal-sync-button').click();
  await expect(page.getByTestId('journal-sync-status')).toContainText('오프라인');
  await expect(page.getByTestId('journal-sync-button')).toBeEnabled();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
});

test('conflict is explicit and server version choice resolves it', async ({ page }) => {
  await open(page);
  await page.getByLabel('시나리오').selectOption('conflict');
  await expect(page.getByTestId('journal-conflicts')).toBeVisible();
  await expect(page.getByTestId('journal-conflicts')).toContainText('note 값이 다릅니다.');
  await page.getByRole('button', { name: '서버 버전 유지' }).click();
  await expect(page.getByTestId('journal-conflicts')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('충돌 해결 결과');
});

test('conflict offers all three non-destructive choices', async ({ page }) => {
  await open(page);
  await page.getByLabel('시나리오').selectOption('conflict');
  await expect(page.getByRole('button', { name: '서버 버전 유지' })).toBeVisible();
  await expect(page.getByRole('button', { name: '이 기기 버전 유지' })).toBeVisible();
  await expect(page.getByRole('button', { name: '둘 다 사본으로 보존' })).toBeVisible();
});

test('analytics displays metrics and separates candidate behavior', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '분석 불러오기' }).click();
  const result = page.getByTestId('journal-analytics-result');
  await expect(result).toContainText('총 거래');
  await expect(result).toContainText('125.5 USDT');
  await expect(result).toContainText('후보');
  await expect(result).toContainText('손실 종료 후 10분 이내');
});

test('insufficient sample does not show fabricated rates', async ({ page }) => {
  await open(page);
  await page.getByLabel('시나리오').selectOption('insufficient');
  await page.getByRole('button', { name: '분석 불러오기' }).click();
  const result = page.getByTestId('journal-analytics-result');
  await expect(result).toContainText('기본 통계 확정에는 최소 5건이 필요합니다.');
  await expect(result).toContainText('표본 부족');
});

test('review dataset shows anonymization and excluded fields', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'AI 복기 데이터 준비' }).click();
  const result = page.getByTestId('review-dataset-result');
  await expect(result).toContainText('대표 거래: 1건');
  await expect(result).toContainText('originalUserNote');
  await expect(result).toContainText('internalDatabaseUuid');
  await expect(page.getByRole('status')).toContainText('외부 전송은 없습니다');
});

test('unified trade journal separates performance, quality, snapshots, and free-only status', async ({ page }) => {
  const errors = captureErrors(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page);
  const journal = page.getByTestId('unified-trade-journal');
  await expect(journal).toContainText('통합 매매일지·매매 품질 복기');
  await expect(page.getByTestId('toss-free-status')).toContainText('MEMBER_CONFIGURED_READ_ONLY');
  await expect(page.getByTestId('journal-zero-cost-status')).toContainText('0_KRW');
  await expect(page.getByTestId('unified-journal-list')).toContainText('BTCUSDT');
  await expect(page.getByTestId('unified-journal-detail')).toContainText('성과 점수');
  await expect(page.getByTestId('unified-journal-detail')).toContainText('매매 품질');
  await expect(page.getByTestId('unified-journal-snapshot')).toContainText('PRE_TRADE_SNAPSHOT');
  await expect(page.getByTestId('unified-journal-monthly')).toContainText('2026-08');
  expect(errors).toEqual([]);
});

test('account switch creates isolated namespaces without exposing UUID', async ({ page }) => {
  await open(page);
  const first = await page.getByTestId('active-account').textContent();
  await page.getByTestId('switch-account').click();
  const second = await page.getByTestId('active-account').textContent();
  expect(first).not.toBe(second);
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('seungjae.paper-trading.v2:')));
  expect(keys.length).toBeGreaterThanOrEqual(2);
  expect(keys.join(' ')).not.toContain('phase7-user-a');
  expect(keys.join(' ')).not.toContain('phase7-user-b');
});

for (const viewport of [
  { name: 'mobile 390x844', width: 390, height: 844 },
  { name: 'small mobile 360x740', width: 360, height: 740 },
  { name: 'wide mobile 430x932', width: 430, height: 932 },
]) {
  test(`${viewport.name} keeps sync, conflict and analysis controls usable`, async ({ page }) => {
    const errors = captureErrors(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await open(page);
    await expect(page.getByTestId('journal-sync-button')).toBeVisible();
    await page.getByLabel('시나리오').selectOption('conflict');
    await expect(page.getByRole('button', { name: '둘 다 사본으로 보존' })).toBeVisible();
    await page.getByLabel('시나리오').selectOption('success');
    await page.getByRole('button', { name: '분석 불러오기' }).click();
    await expect(page.getByTestId('journal-analytics-result')).toBeVisible();
    await expect(page.getByTestId('unified-trade-journal')).toBeVisible();
    await expect(page.getByTestId('unified-journal-detail')).toContainText('BTCUSDT');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
    expect(errors).toEqual([]);
  });
}
