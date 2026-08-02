import { test, expect, type Page } from '@playwright/test';

async function open(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/__phase8-release-candidate-e2e');
  await expect(page.getByTestId('phase8-e2e-page')).toBeVisible();
  return errors;
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflow).toBe(false);
}

async function chooseTier(page: Page, tier: 'pending'|'associate'|'regular'|'admin') {
  await page.getByLabel('회원 등급').selectOption(tier);
}

async function runSteps(page: Page, from: number, to: number) {
  for (let index = from; index <= to; index += 1) {
    await page.getByTestId(`phase8-step-${index}`).click();
    await expect(page.getByTestId(`phase8-step-${index}`)).toContainText('완료');
  }
}

test('pending account sees only approval waiting screen', async ({ page }) => {
  const errors = await open(page);
  await chooseTier(page, 'pending');
  await expect(page.getByTestId('phase8-pending-screen')).toBeVisible();
  await expect(page.getByTestId('phase8-regular-flow')).toHaveCount(0);
  await expect(page.getByTestId('phase8-admin-flow')).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

test('associate gets basic information and all advanced routes remain blocked', async ({ page }) => {
  const errors = await open(page);
  await chooseTier(page, 'associate');
  await expect(page.getByTestId('phase8-associate-screen')).toContainText('기본 정보 접근 성공');
  await expect(page.getByTestId('phase8-associate-denied')).toHaveCount(5);
  await expect(page.getByTestId('phase8-associate-screen')).toContainText('CAPABILITY_REQUIRED');
  await assertNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

test('regular member completes futures to privacy-safe review flow', async ({ page }) => {
  const errors = await open(page);
  await chooseTier(page, 'regular');
  await runSteps(page, 0, 10);
  await expect(page.getByTestId('phase8-sync-status')).toContainText('completed');
  await expect(page.getByTestId('phase8-safety-contract')).toContainText('orderSubmitted=false');
  await expect(page.getByTestId('phase8-safety-contract')).toContainText('exchangeRequestSent=false');
  await expect(page.getByTestId('phase8-safety-contract')).toContainText('externalAiCalled=false');
  await expect(page.getByTestId('phase8-privacy-notice')).toContainText('외부 AI로 전송하지 않습니다');
  await assertNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

test('sync failure remains visible and requires explicit retry', async ({ page }) => {
  const errors = await open(page);
  await chooseTier(page, 'regular');
  await runSteps(page, 0, 7);
  await page.getByText('동기화 실패 모사').check();
  await page.getByTestId('phase8-step-8').click();
  await expect(page.getByTestId('phase8-sync-status')).toContainText('failed');
  await expect(page.getByTestId('phase8-retry')).toBeVisible();
  await page.getByTestId('phase8-retry').click();
  await expect(page.getByTestId('phase8-sync-status')).toContainText('local-only');
  await page.getByTestId('phase8-step-8').click();
  await expect(page.getByTestId('phase8-sync-status')).toContainText('completed');
  expect(errors).toEqual([]);
});

test('account switch uses isolated hashed local namespaces', async ({ page }) => {
  const errors = await open(page);
  await chooseTier(page, 'regular');
  const first = await page.getByTestId('phase8-active-namespace').textContent();
  await runSteps(page, 0, 7);
  await page.getByTestId('phase8-account-switch').click();
  const second = await page.getByTestId('phase8-active-namespace').textContent();
  expect(first).not.toBe(second);
  expect(first).toMatch(/^u_[a-f0-9]{8}$/);
  expect(second).toMatch(/^u_[a-f0-9]{8}$/);
  await expect(page.getByTestId('phase8-step-0')).toContainText('실행');
  expect(errors).toEqual([]);
});

test('admin changes membership with reason and protects last active admin', async ({ page }) => {
  const errors = await open(page);
  await chooseTier(page, 'admin');
  await expect(page.getByTestId('phase8-admin-flow')).toBeVisible();
  await page.getByLabel('대상 회원 등급').selectOption('regular');
  await page.getByLabel('관리자 변경 사유').fill('정회원 검증 승격');
  await page.getByRole('button', { name: '등급·활성 변경' }).click();
  await expect(page.getByTestId('phase8-audit-log')).toContainText('reason=정회원 검증 승격');
  await expect(page.getByTestId('phase8-admin-flow')).toContainText('개인 거래 메모와 원본 거래기록은 표시하지 않습니다');
  await page.getByTestId('phase8-last-admin-protect').click();
  await expect(page.getByRole('alert')).toContainText('LAST_ACTIVE_ADMIN_PROTECTED');
  expect(errors).toEqual([]);
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'small mobile', width: 360, height: 740 },
]) {
  test(`${viewport.name} viewport keeps permission and release controls usable`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const errors = await open(page);
    await chooseTier(page, 'admin');
    await expect(page.getByTestId('phase8-regular-flow')).toBeVisible();
    await expect(page.getByTestId('phase8-admin-flow')).toBeVisible();
    await assertNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });
}
