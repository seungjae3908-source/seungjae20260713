import { test, expect } from '@playwright/test';

for (const width of [360, 390, 430]) {
  test(`trade automation defaults off and fits ${width}px mobile`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/__phase12-trade-automation-e2e');
    await expect(page.getByTestId('auto-trading-admin-only')).toHaveText('관리자 전용');
    await expect(page.getByRole('heading', { name: '자동매매', exact: true })).toBeVisible();
    await expect(page.getByText('기본값은 모두 OFF이며 AI 채팅은 주문 권한이 없습니다.')).toBeVisible();
    await expect(page.getByTestId('connection-bitget')).toContainText('Paper 연결됨');
    const safety = page.getByTestId('optimization-safety-summary');
    await expect(safety).toContainText('첫 20건 승인형');
    await expect(safety).toContainText('+0.15R');
    await expect(safety).toContainText('50건');
    await expect(safety).toContainText('선물 1회 위험');
    await expect(page.getByTestId('trade-recovery-control')).toContainText('재주문하지 않고');
    await expect(page.getByTestId('trade-approval-queue')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

test('query-only recovery control never reports an order resubmission', async ({ page }) => {
  await page.goto('/__phase12-trade-automation-e2e');
  const recovery = page.getByTestId('trade-recovery-control');
  await recovery.getByRole('button', { name: '거래소 상태 조회·복구' }).click();
  await expect(recovery.getByRole('status')).toContainText('재주문 0건');
  await expect(recovery).toContainText('주문 생성·재전송·취소를 수행하지 않습니다.');
});

test('approval queue enables valid paper plan and disables weakened live plan', async ({ page }) => {
  await page.goto('/__phase12-trade-automation-e2e');
  const paper = page.getByTestId('approval-plan-paper-plan');
  const live = page.getByTestId('approval-plan-live-plan');

  await expect(paper).toContainText('현재 표시 조건 통과');
  await expect(paper.getByRole('button', { name: 'Paper 승인 실행' })).toBeEnabled();
  await expect(live).toContainText('신호가 약화 상태');
  await expect(live.getByRole('button', { name: 'Live 재검증 대기' })).toBeDisabled();

  await paper.getByRole('button', { name: 'Paper 승인 실행' }).click();
  await expect(page.getByTestId('trade-approval-queue').getByRole('status')).toContainText('Paper 주문을 승인');
  await expect(paper.getByRole('button', { name: 'Paper 승인 실행' })).toBeDisabled();
});

test('automatic mode requires detailed risk confirmation and safe emergency resume', async ({ page }) => {
  await page.goto('/__phase12-trade-automation-e2e');
  await page.getByRole('button', { name: /자동매매/ }).click();
  await page.getByRole('button', { name: 'Bitget 선물 활성화' }).click();
  await page.getByLabel('Bitget 선물 허용 자산').fill('BTC');
  await page.getByLabel('Bitget 레버리지').selectOption('3');
  await page.getByRole('button', { name: '설정 저장' }).click();
  const dialog = page.getByRole('dialog', { name: '자동매매 최종 확인' });
  await expect(dialog).toContainText('첫 20건 승인형');
  await expect(dialog).toContainText('현재 단계에서는 차단');
  await expect(dialog).toContainText('1,000,000원');
  await expect(dialog).toContainText('+0.15R');
  await expect(dialog).toContainText('첫 20건 1배');
  await expect(dialog).toContainText('최대 3배');
  await dialog.getByRole('button', { name: '위험 확인 및 저장' }).click();
  await expect(page.getByRole('status')).toContainText('저장');

  await page.getByRole('button', { name: '긴급정지' }).click();
  await expect(page.getByRole('status')).toContainText('신규 주문이 차단');
  const stopped = page.getByTestId('trading-stopped-banner');
  await expect(stopped).toContainText('신규 주문 전면 차단');
  await stopped.getByRole('button', { name: '정지 해제 후 신호 재검사' }).click();
  await expect(page.getByRole('status')).toContainText('자동매매는 OFF');
  await expect(page.getByTestId('trading-stopped-banner')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Bitget 선물 활성화' })).toBeDisabled();
});
