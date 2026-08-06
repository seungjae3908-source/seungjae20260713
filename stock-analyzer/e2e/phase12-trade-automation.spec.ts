import { expect, test, type Page } from '@playwright/test';

const MUTATION_PATH = /\/api\/(?:trade-automation|stocks\/auto-trade|crypto\/.*(?:order|execute|cancel))/i;

function monitor(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const unhandledRejections: string[] = [];
  const unexpectedHttpErrors: string[] = [];
  const mutationRequests: string[] = [];
  const privateRequests: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (message.text().startsWith('[e2e-unhandledrejection]')) unhandledRejections.push(message.text());
    else consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) unexpectedHttpErrors.push(`${response.status()} ${response.url()}`);
  });
  page.on('request', (request) => {
    const method = request.method();
    const url = request.url();
    if (method !== 'GET' && MUTATION_PATH.test(url)) mutationRequests.push(`${method} ${url}`);
    if (/\/api\/crypto\/(?:spot\/accounts|futures\/(?:account|positions|orders?))/i.test(url)) privateRequests.push(`${method} ${url}`);
  });
  return { consoleErrors, pageErrors, unhandledRejections, unexpectedHttpErrors, mutationRequests, privateRequests };
}

async function installUnhandledRejectionMonitor(page: Page) {
  await page.addInitScript(() => {
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
      console.error(`[e2e-unhandledrejection] ${reason}`);
    });
  });
}

function expectClean(evidence: ReturnType<typeof monitor>) {
  expect(evidence.consoleErrors).toEqual([]);
  expect(evidence.pageErrors).toEqual([]);
  expect(evidence.unhandledRejections).toEqual([]);
  expect(evidence.unexpectedHttpErrors).toEqual([]);
  expect(evidence.mutationRequests).toEqual([]);
  expect(evidence.privateRequests).toEqual([]);
}

for (const width of [360, 390, 430]) {
  test(`read-only approval waiting UI fits ${width}px mobile`, async ({ page }) => {
    await installUnhandledRejectionMonitor(page);
    const evidence = monitor(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/__phase12-trade-automation-e2e');

    await expect(page.getByRole('heading', { name: '신호 승인 대기 · 읽기 전용' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '모바일 승인 대기 정보' })).toBeVisible();
    const ready = page.getByTestId('approval-item-ready');
    await expect(ready).toContainText('005930 · BUY');
    await expect(ready).toContainText('KR · 15m');
    await expect(ready).toContainText('신호 시각');
    await expect(ready).toContainText('만료 시각');
    await expect(ready).toContainText('데이터 상태');
    await expect(ready).toContainText('신뢰도');
    await expect(ready).toContainText('위험점수');
    await expect(ready).toContainText('추격 위험');
    await expect(ready).toContainText('주문 생성 false · 거래소 요청 false');
    await expect(page.getByTestId('approval-item-partial')).toContainText('부분 데이터');
    await expect(page.getByTestId('approval-item-invalid')).toContainText('급등 추격 위험');
    await expect(page.getByTestId('approval-item-expired')).toContainText('신호 만료');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expectClean(evidence);
  });
}

test('detail dialog has an accessible name, Escape and browser back restore focus', async ({ page }) => {
  await installUnhandledRejectionMonitor(page);
  const evidence = monitor(page);
  await page.goto('/__phase12-trade-automation-e2e');
  const opener = page.getByTestId('approval-item-ready').getByRole('button', { name: '대기 정보 보기' });
  await opener.focus();
  await opener.press('Enter');
  const dialog = page.getByRole('dialog', { name: '005930 승인 대기 상세' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('가격·보유 수량·신호 상태는 아직 최종 확정이 아닙니다.');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expectClean(evidence);
});

test('WEAKENED INVALIDATED and EXPIRED transitions lock the waiting card without mutations', async ({ page }) => {
  await installUnhandledRejectionMonitor(page);
  const evidence = monitor(page);
  await page.goto('/__phase12-trade-automation-e2e');
  for (const state of ['WEAKENED', 'INVALIDATED', 'EXPIRED'] as const) {
    await page.getByRole('button', { name: state, exact: true }).click();
    await expect(page.getByTestId('approval-item-ready')).toContainText(state === 'WEAKENED' ? '신호 약화' : state === 'INVALIDATED' ? '신호 무효' : '신호 만료');
    await expect(page.getByTestId('approval-item-ready')).toContainText('승인 대기 정보가 잠겼습니다.');
  }
  expectClean(evidence);
});

test('loading empty error and authentication expiry states are explicit', async ({ page }) => {
  await installUnhandledRejectionMonitor(page);
  const evidence = monitor(page);
  await page.goto('/__phase12-trade-automation-e2e');
  await page.getByRole('button', { name: 'loading', exact: true }).click();
  await expect(page.getByText('승인 대기 정보를 불러오는 중입니다.')).toBeVisible();
  await page.getByRole('button', { name: 'empty', exact: true }).click();
  await expect(page.getByText('승인 대기 신호가 없습니다.')).toBeVisible();
  await page.getByRole('button', { name: 'error', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('승인 대기 정보를 불러오지 못했습니다.');
  await page.getByRole('button', { name: 'auth-expired', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('인증이 만료됐습니다.');
  expectClean(evidence);
});

test('saved search save alert toggle and delete stay local and user scoped', async ({ page }) => {
  await installUnhandledRejectionMonitor(page);
  const evidence = monitor(page);
  await page.goto('/__phase12-trade-automation-e2e');
  const manager = page.getByTestId('scanner-saved-search-manager');
  await manager.getByRole('button', { name: '현재 조건 저장' }).click();
  const saved = manager.getByTestId('saved-search-fixture-kr-15m');
  await expect(saved).toContainText('국내주식 15분 검색');
  await expect(saved).toContainText('알림 ON');
  await saved.getByRole('button', { name: '알림 끄기' }).click();
  await expect(saved).toContainText('알림 OFF');
  await saved.getByRole('button', { name: '삭제' }).click();
  await expect(manager).toContainText('저장된 검색이 없습니다.');
  expectClean(evidence);
});
