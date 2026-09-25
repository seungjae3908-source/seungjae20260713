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

test('default unified-ledger transport accepts reconciled non-zero read-only provider request counts', async ({ page }) => {
  const errors = captureErrors(page);
  const result = {
    integrationBaseSha: 'transport-e2e',
    generatedAt: '2026-09-25T00:00:00.000Z',
    trades: [],
    integrityIssues: [],
    toss: {
      provider: 'TOSS',
      officialSpecVersion: '1.2.13',
      paidStatus: 'PAID_STATUS_UNVERIFIED',
      liveReadIntegration: 'BLOCKED_BY_FREE_STATUS_UNVERIFIED',
      contractNormalizerAvailable: true,
      executionGranularity: 'ORDER_CUMULATIVE_AGGREGATE_NO_FILL_ID',
      livePrivateRequests: 0,
      actualOrders: 0,
    },
    aiReviewStatus: 'AI_EXTERNAL_REVIEW_DISABLED_FREE_ONLY',
    safety: {
      finalCostDelta: '0_KRW',
      actualOrderRequests: 0,
      cancelRequests: 0,
      amendRequests: 0,
      transferRequests: 0,
      withdrawalRequests: 0,
      privateBrokerRequests: 5,
    },
    liveAccountHistory: {
      requestedRange: '30D',
      effectiveDays: 30,
      rangeCapped: false,
      persisted: false,
      privateProviderRequests: 5,
      truncated: false,
      providers: [
        { provider: 'upbit', configured: true, enabled: true, status: 'READY', records: 2, privateProviderRequests: 4, truncated: false, errorCode: null },
        { provider: 'bitget', configured: true, enabled: true, status: 'READY', records: 1, privateProviderRequests: 1, truncated: false, errorCode: null },
      ],
      safety: {
        orderRequests: 0,
        cancelRequests: 0,
        amendRequests: 0,
        transferRequests: 0,
        withdrawalRequests: 0,
        credentialsReturned: false,
        liveTradingEnabled: false,
        autoTradingEnabled: false,
      },
    },
    analytics: {
      sampleSize: 0,
      openTrades: 0,
      closedTrades: 0,
      winRate: null,
      profitFactor: null,
      averageReturnPercent: null,
      maximumConsecutiveLosses: null,
      netPnlByCurrency: [],
      totalCostsByCurrency: [],
      byMarket: [],
      bySource: [],
      byStrategy: [],
      byTimeframe: [],
      byGrade: [],
      mistakes: [],
      monthlyReport: [],
      warnings: [],
    },
  };

  await page.route('**/api/paper-journal/unified-ledger**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mode: 'analysis-only', externalAiCalled: false, ok: true, result }),
    });
  });

  await page.goto(`${PATH}?unifiedTransport=api`);
  await expect(page.getByTestId('phase7-e2e-page')).toBeVisible();
  await expect(page.getByTestId('journal-zero-cost-status')).toContainText('실계좌 조회 8회');
  await expect(page.getByTestId('live-account-history-status')).toContainText('UPBIT READY · 2건 · 요청 4회');
  await expect(page.getByTestId('live-account-history-status')).toContainText('BITGET READY · 1건 · 요청 1회');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('unified trade journal separates performance, quality, snapshots, and free-only status', async ({ page }) => {
  const errors = captureErrors(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page);
  const journal = page.getByTestId('unified-trade-journal');
  await expect(journal).toContainText('통합 매매일지·매매 품질 복기');
  await expect(page.getByTestId('toss-free-status')).toContainText('BLOCKED_BY_FREE_STATUS_UNVERIFIED');
  await expect(page.getByTestId('journal-zero-cost-status')).toContainText('0_KRW');
  await expect(page.getByTestId('journal-zero-cost-status')).toContainText('실계좌 조회 5회');
  const liveHistory = page.getByTestId('live-account-history-status');
  await expect(liveHistory).toContainText('실계좌 거래이력 · READ-ONLY');
  await expect(liveHistory).toContainText('최근 30일');
  await expect(liveHistory).toContainText('KIWOOM READY · 2건 · 요청 3회');
  await expect(liveHistory).toContainText('UPBIT READY · 2건 · 요청 4회');
  await expect(liveHistory).toContainText('BITGET READY · 1건 · 요청 1회');
  await expect(page.getByTestId('kiwoom-realized-evidence')).toContainText('Kiwoom 국내 현금 실현손익 증거 · 1건');
  await expect(page.getByTestId('kiwoom-realized-evidence')).toContainText('canonical 승률·Profit Factor·평균수익률 통계에는 넣지 않습니다.');
  await expect(page.getByTestId('kiwoom-realized-evidence')).toContainText('8,500 KRW');
  await expect(page.getByLabel('출처')).toContainText('Upbit 실계좌');
  await expect(page.getByLabel('출처')).toContainText('Bitget 실계좌');
  await expect(page.getByLabel('출처')).toContainText('Kiwoom 실계좌');

  const linkage = page.getByTestId('journal-paper-linkage');
  await expect(linkage).toContainText('Paper 기록 연결 상태');
  await expect(linkage).toContainText('APP_PAPER 연결 관측');
  await expect(linkage).toContainText('Paper 출처');
  await expect(linkage).toContainText('3건');
  await expect(linkage).toContainText('3 / 0');
  await expect(linkage).toContainText('3/3');
  await expect(linkage).toContainText('fees + tax 기준 · 8개 Full Cost와 별개');
  await expect(linkage).toContainText('100%');
  await expect(page.getByTestId('journal-candidate-binding-gap')).toContainText('Research 후보 직접 연결 · 부분/미확인');
  await expect(page.getByTestId('journal-candidate-binding-gap')).toContainText('검증 1/3');
  await expect(page.getByTestId('journal-candidate-binding-gap')).toContainText('불일치 1');
  await expect(page.getByTestId('journal-candidate-binding-gap')).toContainText('미확인 1');
  await expect(page.getByTestId('journal-candidate-binding-gap')).toContainText('AUTHENTICATED_PAPER_STATE');
  await expect(page.getByTestId('journal-candidate-binding-gap')).toContainText('candidate-authenticated-1');
  await expect(page.getByTestId('journal-link-paper-trading')).toHaveAttribute('href', '/paper-trading');
  await expect(page.getByTestId('journal-link-research-center')).toHaveAttribute('href', '/research-center');

  await expect(page.getByTestId('unified-journal-list')).toContainText('BTCUSDT');
  await expect(page.getByTestId('unified-journal-detail')).toContainText('성과 점수');
  await expect(page.getByTestId('unified-journal-detail')).toContainText('매매 품질');
  await expect(page.getByTestId('unified-journal-detail')).toContainText('0.2 USDT');
  const researchBinding = page.getByTestId('unified-journal-research-binding');
  await expect(researchBinding).toContainText('Research lineage');
  await expect(researchBinding).toContainText('VERIFIED');
  await expect(researchBinding).toContainText('candidate-authenticated-1');
  await expect(researchBinding).toContainText('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  await expect(researchBinding).toContainText('Settlement binding');
  await expect(researchBinding).toContainText('Trigger binding');
  await expect(researchBinding).toContainText('exitTriggerId');
  await expect(researchBinding).toContainText('exit-trigger-1');
  await expect(researchBinding).toContainText('검증됨');
  await expect(researchBinding).toContainText('AUTHENTICATED_PAPER_STATE_IDENTITY_MATCHED');
  await expect(page.getByTestId('unified-journal-snapshot')).toContainText('진입 전 판단 근거');
  await expect(page.getByTestId('unified-journal-monthly')).toContainText('2026-08');
  expect(errors).toEqual([]);
});

test('binding, Trigger and search filters isolate journal verification states without rewriting analytics', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page);

  const list = page.getByTestId('unified-journal-list');
  const analytics = page.getByTestId('unified-journal-analytics');
  await expect(list).toContainText('거래 목록 4 / 4건');
  await expect(list).toContainText('AAPL');
  await expect(list).toContainText('Research 해당없음');
  await expect(analytics).toContainText('종료 거래');
  await expect(analytics).toContainText('4');

  await page.getByLabel('Research binding').selectOption('VERIFIED');
  await expect(list).toContainText('거래 목록 1 / 4건');
  await expect(list).toContainText('BTCUSDT');
  await expect(list).toContainText('Research 검증');
  await expect(list).toContainText('Trigger 검증');
  await expect(list).not.toContainText('ETHUSDT');
  await expect(list).not.toContainText('SOLUSDT');
  await expect(list).not.toContainText('AAPL');
  await expect(analytics).toContainText('4');

  await page.getByLabel('Research binding').selectOption('MISMATCH');
  await expect(list).toContainText('거래 목록 1 / 4건');
  await expect(list).toContainText('ETHUSDT');
  await expect(list).toContainText('Research 불일치');
  await expect(list).not.toContainText('BTCUSDT');
  await expect(list).not.toContainText('AAPL');

  await page.getByLabel('Research binding').selectOption('NOT_AVAILABLE');
  await expect(list).toContainText('거래 목록 1 / 4건');
  await expect(list).toContainText('SOLUSDT');
  await expect(list).toContainText('Research 미확인');
  await expect(list).not.toContainText('AAPL');

  await page.getByLabel('Research binding').selectOption('ALL');
  await page.getByLabel('Trigger binding filter').selectOption('VERIFIED');
  await expect(list).toContainText('거래 목록 1 / 4건');
  await expect(list).toContainText('BTCUSDT');
  await expect(list).not.toContainText('AAPL');

  await page.getByLabel('Trigger binding filter').selectOption('UNVERIFIED');
  await expect(list).toContainText('거래 목록 2 / 4건');
  await expect(list).toContainText('ETHUSDT');
  await expect(list).toContainText('SOLUSDT');
  await expect(list).toContainText('Trigger 미검증');
  await expect(list).not.toContainText('BTCUSDT');
  await expect(list).not.toContainText('AAPL');

  await page.getByLabel('Trigger binding filter').selectOption('ALL');
  await page.getByLabel('거래 목록 검색').fill('candidate-authenticated-1');
  await expect(list).toContainText('거래 목록 1 / 4건');
  await expect(list).toContainText('BTCUSDT');

  await page.getByLabel('거래 목록 검색').fill('exit-trigger-1');
  await expect(list).toContainText('거래 목록 1 / 4건');
  await expect(list).toContainText('BTCUSDT');

  await page.getByLabel('거래 목록 검색').fill('exit-execution-1');
  await expect(list).toContainText('거래 목록 1 / 4건');
  await expect(list).toContainText('BTCUSDT');

  await page.getByLabel('거래 목록 검색').fill('AUTHENTICATED_PAPER_STATE_IDENTITY_MATCHED');
  await expect(list).toContainText('거래 목록 1 / 4건');
  await expect(list).toContainText('BTCUSDT');

  await page.getByLabel('거래 목록 검색').fill('ETHUSDT');
  await expect(list).toContainText('거래 목록 1 / 4건');
  await expect(list).toContainText('ETHUSDT');

  await page.getByLabel('거래 목록 검색').fill('AAPL');
  await expect(list).toContainText('거래 목록 1 / 4건');
  await expect(list).toContainText('AAPL');
  await expect(list).toContainText('Research 해당없음');

  await page.getByLabel('거래 목록 검색').fill('does-not-exist');
  const empty = page.getByTestId('unified-journal-empty-filter-result');
  await expect(empty).toContainText('해당하는 거래가 없습니다');
  await expect(empty).toContainText('Search=does-not-exist');
  await page.getByTestId('unified-journal-empty-filter-reset').click();
  await expect(list).toContainText('거래 목록 4 / 4건');
  await expect(page.getByLabel('Research binding')).toHaveValue('ALL');
  await expect(page.getByLabel('Trigger binding filter')).toHaveValue('ALL');
  await expect(page.getByLabel('거래 목록 검색')).toHaveValue('');

  await page.getByLabel('Research binding').selectOption('VERIFIED');
  await page.getByTestId('unified-journal-binding-filter-reset').click();
  await expect(list).toContainText('거래 목록 4 / 4건');
  await expect(page.getByLabel('Research binding')).toHaveValue('ALL');
  await expect(page.getByLabel('Trigger binding filter')).toHaveValue('ALL');
  await expect(page.getByLabel('거래 목록 검색')).toHaveValue('');
});

test('binding issue drilldown groups canonical reasons and narrows only the trade list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page);

  const issues = page.getByTestId('unified-journal-binding-issues');
  const list = page.getByTestId('unified-journal-list');
  const analytics = page.getByTestId('unified-journal-analytics');

  await expect(issues).toContainText('Research 연결 문제 빠른 진단');
  await expect(issues).toContainText('원인 2종');
  await expect(issues).toContainText('SYNCED_JOURNAL_OWNER_STATE_MISMATCH');
  await expect(issues).toContainText('CANONICAL_PAPER_LINEAGE_NOT_PRESENT');
  await expect(analytics).toContainText('4');

  await page.getByTestId('unified-journal-binding-issue-mismatch').click();
  await expect(page.getByLabel('Research binding')).toHaveValue('MISMATCH');
  await expect(page.getByLabel('거래 목록 검색')).toHaveValue('SYNCED_JOURNAL_OWNER_STATE_MISMATCH');
  await expect(list).toContainText('거래 목록 1 / 4건');
  await expect(list).toContainText('ETHUSDT');
  await expect(list).not.toContainText('SOLUSDT');
  await expect(analytics).toContainText('4');

  await page.getByTestId('unified-journal-binding-filter-reset').click();
  await page.getByTestId('unified-journal-binding-issue-not_available').click();
  await expect(page.getByLabel('Research binding')).toHaveValue('NOT_AVAILABLE');
  await expect(page.getByLabel('거래 목록 검색')).toHaveValue('CANONICAL_PAPER_LINEAGE_NOT_PRESENT');
  await expect(list).toContainText('거래 목록 1 / 4건');
  await expect(list).toContainText('SOLUSDT');
  await expect(list).not.toContainText('ETHUSDT');
  await expect(analytics).toContainText('4');
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
    await expect(page.getByTestId('unified-journal-binding-filters')).toBeVisible();
    await expect(page.getByLabel('Research binding')).toBeVisible();
    await expect(page.getByLabel('Trigger binding filter')).toBeVisible();
    await expect(page.getByLabel('거래 목록 검색')).toBeVisible();
    await expect(page.getByTestId('journal-paper-linkage')).toBeVisible();
    await expect(page.getByTestId('journal-paper-linkage')).toContainText('APP_PAPER 연결 관측');
    await expect(page.getByTestId('journal-candidate-binding-gap')).toContainText('Research 후보 직접 연결 · 부분/미확인');
    await expect(page.getByTestId('journal-candidate-binding-gap')).toContainText('candidate-authenticated-1');
    await expect(page.getByTestId('unified-journal-detail')).toContainText('BTCUSDT');
    await expect(page.getByTestId('unified-journal-research-binding')).toContainText('candidate-authenticated-1');
    await expect(page.getByTestId('unified-journal-research-binding')).toContainText('검증됨');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
    expect(errors).toEqual([]);
  });
}
