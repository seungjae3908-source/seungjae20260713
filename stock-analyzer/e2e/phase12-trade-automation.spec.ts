import { test, expect, type Page } from '@playwright/test';

function captureBrowserFailures(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const httpErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      httpErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/')) requestFailures.push(`${request.failure()?.errorText ?? 'failed'} ${request.url()}`);
  });
  return { consoleErrors, pageErrors, httpErrors, requestFailures };
}

type ApprovalApiOptions = {
  invalidateAfterFirstStatus?: boolean;
  approveDelayMs?: number;
};

async function mockApprovalApi(page: Page, options: ApprovalApiOptions = {}) {
  const counts = { status: 0, approve: 0, invalidate: 0 };
  await page.route(/\/api\/trade-automation\/plans\/[^/]+\/approval-status(?:\?.*)?$/, async (route) => {
    counts.status += 1;
    const invalid = options.invalidateAfterFirstStatus === true && counts.status > 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        plan: {
          state: invalid ? 'EXPIRED' : 'APPROVAL_PENDING',
          signalState: invalid ? 'INVALIDATED' : 'READY_FOR_APPROVAL',
          signalInvalidationReason: invalid ? 'SIGNAL_CORE_CONDITION_BROKEN' : null,
          approvalExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          updatedAt: new Date().toISOString(),
        },
        approval: {
          approvalEnabled: !invalid,
          signalState: invalid ? 'INVALIDATED' : 'READY_FOR_APPROVAL',
          planState: invalid ? 'EXPIRED' : 'APPROVAL_PENDING',
          reasonCode: invalid ? 'SIGNAL_INVALIDATED' : null,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          lastValidatedAt: new Date().toISOString(),
        },
        orderSubmitted: false,
      }),
    });
  });
  await page.route(/\/api\/trade-automation\/plans\/[^/]+\/approve(?:\?.*)?$/, async (route) => {
    counts.approve += 1;
    if (options.approveDelayMs) await new Promise((resolve) => setTimeout(resolve, options.approveDelayMs));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, order: { state: 'SUBMITTED', lastErrorCode: null } }),
    });
  });
  await page.route(/\/api\/trade-automation\/plans\/[^/]+\/invalidate(?:\?.*)?$/, async (route) => {
    counts.invalidate += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
  return counts;
}

function expectNoBrowserFailures(failures: ReturnType<typeof captureBrowserFailures>) {
  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
  expect(failures.httpErrors).toEqual([]);
  expect(failures.requestFailures).toEqual([]);
}

for (const width of [360, 390, 430]) {
  test(`trade approval queue fits ${width}px mobile and fails closed`, async ({ page }) => {
    const failures = captureBrowserFailures(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/__phase12-trade-automation-e2e');
    await expect(page.getByRole('heading', { name: '승인형 주문', exact: true })).toBeVisible();
    await expect(page.getByText('실전 계좌 주문 비활성')).toBeVisible();
    await expect(page.getByText('기본값은 모두 OFF이며 AI 채팅은 주문 권한이 없습니다.')).toBeVisible();
    await expect(page.getByTestId('connection-bitget')).toContainText('Paper 연결됨');
    await expect(page.getByTestId('trade-signal-alerts')).toContainText('BTC 조건 유지 확인');
    await expect(page.getByTestId('trade-signal-alerts')).toContainText('005930 조건 해제');
    await expect(page.getByTestId('trade-signal-alerts')).not.toContainText('SIGNAL_CORE_CONDITION_BROKEN');
    await expect(page.getByTestId('signal-alert-condition_maintained')).toContainText('현재 승인 가능');
    await expect(page.getByTestId('signal-alert-condition_released')).toContainText('현재 신호 무효');
    await expect(page.getByTestId('approval-plan-ready-plan')).toContainText('승인 가능');
    await expect(page.getByTestId('approval-plan-invalid-plan')).toContainText('신호 무효');
    await expect(page.getByTestId('approval-plan-live-plan')).toContainText('실전 주문 차단');
    await expect(page.getByTestId('approve-plan-ready-plan')).toBeEnabled();
    await expect(page.getByTestId('approve-plan-invalid-plan')).toBeDisabled();
    await expect(page.getByTestId('approve-plan-live-plan')).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expectNoBrowserFailures(failures);
  });
}

test('approval dialog is accessible, cancellable, and restores focus without mutation', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  const counts = await mockApprovalApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__phase12-trade-automation-e2e');
  const opener = page.getByTestId('approve-plan-ready-plan');
  await opener.focus();
  await opener.press('Enter');

  const dialog = page.getByRole('dialog', { name: '주문 승인 최종 확인' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('BTC');
  await expect(dialog).toContainText('매수');
  await expect(dialog).toContainText('Upbit 현물');
  await expect(dialog).toContainText('Paper 모의');
  await expect(dialog).toContainText('100,000원');
  await expect(dialog).toContainText('50% / 30% / 20%');
  await expect(dialog).toContainText('90,000');
  await expect(dialog).toContainText('108,000 / 112,000');
  await expect(dialog).toContainText('82점 · 78%');
  await expect(dialog.getByTestId('confirm-trade-approval')).toBeEnabled();
  await expect(dialog).toContainText(/남은 시간 \d{2}:\d{2}/);

  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => {
    const active = document.activeElement;
    const dialogElement = document.querySelector('[role="dialog"]');
    return Boolean(active && dialogElement?.contains(active));
  })).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expect(counts.approve).toBe(0);

  await opener.press('Space');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expect(counts.approve).toBe(0);
  expectNoBrowserFailures(failures);
});

test('rapid duplicate approval clicks create one mutation only', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  const counts = await mockApprovalApi(page, { approveDelayMs: 150 });
  await page.goto('/__phase12-trade-automation-e2e');
  await page.getByTestId('approve-plan-ready-plan').click();
  const confirm = page.getByTestId('confirm-trade-approval');
  await expect(confirm).toBeEnabled();
  await confirm.evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect(page.getByRole('status')).toContainText('승인 처리 완료');
  expect(counts.approve).toBe(1);
  expectNoBrowserFailures(failures);
});

test('dialog locks immediately when server reports signal invalidation', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  const counts = await mockApprovalApi(page, { invalidateAfterFirstStatus: true });
  await page.goto('/__phase12-trade-automation-e2e');
  await page.getByTestId('approve-plan-ready-plan').click();
  const dialog = page.getByRole('dialog', { name: '주문 승인 최종 확인' });
  const confirm = dialog.getByTestId('confirm-trade-approval');
  await expect(confirm).toBeEnabled();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(confirm).toBeDisabled();
  await expect(dialog).toContainText('핵심 진입 조건이 깨져 승인이 차단됐습니다.');
  expect(counts.approve).toBe(0);
  expectNoBrowserFailures(failures);
});

test('approval expiry warns, disables the button, and sends zero API requests', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  const counts = await mockApprovalApi(page);
  await page.goto('/__phase12-trade-automation-e2e');
  const card = page.getByTestId('approval-plan-soon-plan');
  await expect(card).toContainText(/남은 시간 00:0[1-4]/);
  await expect(page.getByTestId('approve-plan-soon-plan')).toBeEnabled();
  await expect(page.getByTestId('approve-plan-soon-plan')).toBeDisabled({ timeout: 6_000 });
  await expect(card).toContainText('승인 가능 시간이 지났습니다.');
  expect(counts.status).toBe(0);
  expect(counts.approve).toBe(0);
  expectNoBrowserFailures(failures);
});

test('automatic mode requires a detailed confirmation and emergency stop returns to off', async ({ page }) => {
  const failures = captureBrowserFailures(page);
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
  expectNoBrowserFailures(failures);
});
