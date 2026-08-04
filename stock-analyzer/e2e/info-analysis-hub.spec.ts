import { test, expect, type Page } from '@playwright/test';

const NOW = new Date().toISOString();
const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

type Mode = 'balanced' | 'positive' | 'failure' | 'missing';

function json(route: any, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

async function installAnalysisMocks(page: Page, readMode: () => Mode) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const mode = readMode();
    const match = path.match(/^\/api\/stocks\/([^/]+)\/(.+)$/);
    const ticker = decodeURIComponent(match?.[1] ?? '').toUpperCase();
    const action = match?.[2] ?? '';

    if (path === '/api/stocks/special-feed') {
      const items = mode === 'missing' ? [] : mode === 'failure'
        ? [
            {
              id: 'failure-event',
              asset: 'stock',
              kind: 'disclosure',
              tone: 'negative',
              ticker: 'RGTI',
              name: 'Rigetti Computing',
              market: 'US',
              currency: 'USD',
              title: '핵심 양자 프로세서 개발 실패 및 일정 재검토',
              summary: '공식 시험에서 목표 성능을 달성하지 못했습니다.',
              source: 'SEC',
              sourceAt: NOW,
              detectedAt: NOW,
              archiveAt: FUTURE,
            },
          ]
        : [
            {
              id: 'contract-event',
              asset: 'stock',
              kind: 'disclosure',
              tone: 'positive',
              ticker: 'RGTI',
              name: 'Rigetti Computing',
              market: 'US',
              currency: 'USD',
              title: '정부 연구기관과 양자 시스템 공급 계약 체결',
              summary: '다년 계약으로 실제 매출 전환 여부를 확인해야 합니다.',
              source: 'SEC',
              sourceAt: NOW,
              detectedAt: NOW,
              archiveAt: FUTURE,
            },
            ...(mode === 'balanced'
              ? [{
                  id: 'delay-event',
                  asset: 'stock',
                  kind: 'news',
                  tone: 'negative',
                  ticker: 'RGTI',
                  name: 'Rigetti Computing',
                  market: 'US',
                  currency: 'USD',
                  title: '핵심 개발 일정 지연과 비용 증가 가능성',
                  summary: '실패는 아니지만 상용화 일정 확인이 필요합니다.',
                  source: 'Reuters',
                  sourceAt: NOW,
                  detectedAt: NOW,
                  archiveAt: FUTURE,
                }]
              : []),
          ];
      return json(route, { ok: true, asset: 'stock', market: 'US', count: items.length, catalogSize: items.length, updatedAt: NOW, items });
    }

    if (path === '/api/search') {
      return json(route, { results: [{ ticker: 'RGTI', name: 'Rigetti Computing', market: 'US', currency: 'USD' }] });
    }

    if (match && ticker === 'RGTI') {
      if (action.startsWith('quote')) {
        return json(route, mode === 'missing'
          ? { ticker: 'RGTI', name: 'Rigetti Computing', market: 'US', currency: 'USD', price: 15, source: 'US_PROVIDER', updatedAt: NOW }
          : {
              ticker: 'RGTI',
              name: 'Rigetti Computing',
              market: 'US',
              currency: 'USD',
              price: mode === 'failure' ? 12.5 : 15,
              changeAmount: mode === 'failure' ? -2.5 : 0.5,
              changePercent: mode === 'failure' ? -16.7 : 3.4,
              volume: 12_345_678,
              tradingValue: 190_000_000,
              open: 14.4,
              high: 15.6,
              low: mode === 'failure' ? 12.1 : 14.2,
              high52: 21,
              low52: 6,
              marketCap: 4_500_000_000,
              source: 'US_PROVIDER',
              updatedAt: NOW,
            });
      }
      if (action.startsWith('profile') || action.startsWith('company')) {
        return json(route, mode === 'missing'
          ? { name: 'Rigetti Computing', market: 'US' }
          : {
              name: 'Rigetti Computing',
              market: 'US',
              sector: 'Quantum Computing',
              industry: 'Quantum hardware',
              country: 'United States',
              description: 'Superconducting quantum computing systems',
              qubits: 84,
              gateFidelity: 99.2,
              cloudAccess: true,
              scalability: 'modular',
            });
      }
      if (action.startsWith('financials')) {
        return json(route, mode === 'missing'
          ? { source: 'SEC_XBRL', financials: { quarterly: [] } }
          : {
              source: 'SEC_XBRL',
              updatedAt: NOW,
              financials: {
                quarterly: [
                  { period: '2026-Q2', revenue: 120_000_000, operatingIncome: -80_000_000, netIncome: -75_000_000, cash: 300_000_000, operatingCashFlow: -60_000_000 },
                  { period: '2026-Q1', revenue: 100_000_000, operatingIncome: -70_000_000, netIncome: -68_000_000, cash: 350_000_000, operatingCashFlow: -55_000_000 },
                ],
                ratios: { debtRatio: 40 },
              },
            });
      }
      if (action.startsWith('market-flow')) return json(route, { available: false, note: '미국 수급 제공기관 미지원' });
      if (action.startsWith('short-selling')) return json(route, { available: true, latest: { shortVolume: 1_000_000, ratio: 4.2, balance: 8_000_000 } });
      if (action.startsWith('news')) {
        return json(route, { news: mode === 'balanced' ? [{ title: '핵심 개발 일정 지연과 비용 증가 가능성', summary: '상용화 일정 확인 필요', source: 'Reuters', date: NOW }] : [] });
      }
      if (action.startsWith('disclosures') || action.startsWith('filings')) {
        const disclosures = mode === 'failure'
          ? [{ report: '핵심 양자 프로세서 개발 실패 및 일정 재검토', source: 'SEC', date: NOW }]
          : mode === 'missing'
            ? []
            : [{ report: '정부 연구기관과 양자 시스템 공급 계약 체결', source: 'SEC', date: NOW }];
        return json(route, { disclosures });
      }
    }

    if (path === '/api/notifications/price-alerts') return json(route, { alerts: [] });
    return json(route, { ok: true });
  });
}

function diagnostics(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console:${message.text()}`); });
  page.on('pageerror', (error) => errors.push(`page:${error.message}`));
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText ?? '';
    if (!reason.includes('ERR_ABORTED')) errors.push(`request:${reason}`);
  });
  return () => expect(errors, errors.join('\n')).toEqual([]);
}

test('RGTI analysis hub explains score, events, financials, price, factors, confidence, and sector peers', async ({ page }) => {
  let mode: Mode = 'balanced';
  const clean = diagnostics(page);
  await installAnalysisMocks(page, () => mode);
  await page.goto('/stock-info?asset=stock&market=US&ticker=RGTI');

  const hub = page.getByTestId('stock-analysis-hub');
  await expect(hub.getByText('AI 종합평가', { exact: true })).toBeVisible();
  await expect(hub.getByText('자체엔진', { exact: true })).toBeVisible();
  await expect(hub.getByText(/양자 기술 개발 역량|양자 기술 기대/)).toBeVisible();
  await expect(hub.getByText('기술력', { exact: true }).first()).toBeVisible();
  await expect(hub.getByText(/정부 연구기관과 양자 시스템 공급 계약 체결/).first()).toBeVisible();
  await expect(hub.getByText(/핵심 개발 일정 지연/).first()).toBeVisible();

  await hub.getByText('경쟁력 비교', { exact: true }).click();
  await expect(hub.getByText('IBM', { exact: true })).toBeVisible();
  await expect(hub.getByText('Google', { exact: true })).toBeVisible();
  await expect(hub.getByText('IonQ', { exact: true })).toBeVisible();
  await expect(hub.getByText('자료 필요', { exact: true }).first()).toBeVisible();

  await hub.getByText('재무 해석', { exact: true }).click();
  await expect(hub.getByText(/영업적자/).first()).toBeVisible();

  await hub.getByText('주가와 연결', { exact: true }).click();
  await expect(hub.getByText('52주 고점 대비', { exact: true })).toBeVisible();

  await hub.getByText('투자자가 궁금한 조건', { exact: true }).click();
  await expect(hub.getByText('왜 오를 수 있나?', { exact: true })).toBeVisible();
  await expect(hub.getByText('왜 떨어질 수 있나?', { exact: true })).toBeVisible();
  await expect(hub.getByText('기계적 관찰 가격', { exact: true })).toBeVisible();

  await hub.locator('summary').filter({ hasText: /^분석 신뢰도/ }).click();
  await expect(hub.getByText('경쟁사 최신 정량 비교자료', { exact: true })).toBeVisible();
  clean();
});

test('a newly confirmed development failure records the reason and lowers the outlook without manual prose', async ({ page }) => {
  let mode: Mode = 'positive';
  const clean = diagnostics(page);
  await installAnalysisMocks(page, () => mode);
  await page.goto('/stock-info?asset=stock&market=US&ticker=RGTI');
  const hub = page.getByTestId('stock-analysis-hub');
  await expect(hub.getByText(/공급 계약 체결/).first()).toBeVisible();
  await page.waitForFunction(() => Object.keys(localStorage).some((key) => key.startsWith('sa-stock-analysis-history-v1:US:RGTI')));

  mode = 'failure';
  await page.reload();
  const updatedHub = page.getByTestId('stock-analysis-hub');
  await expect(updatedHub.getByText(/핵심 양자 프로세서 개발 실패/).first()).toBeVisible();
  await expect(updatedHub.getByText('기존 전망 변경', { exact: true })).toBeVisible();
  await expect(updatedHub.getByText(/새 이벤트: 핵심 양자 프로세서 개발 실패/).first()).toBeVisible();
  await expect(updatedHub.getByText(/최근 핵심 양자 프로세서 개발 실패/).first()).toBeVisible();
  clean();
});

test('missing sector and financial data lowers confidence but never creates a blank or NaN screen', async ({ page }) => {
  let mode: Mode = 'missing';
  const clean = diagnostics(page);
  await installAnalysisMocks(page, () => mode);
  await page.goto('/stock-info?asset=stock&market=US&ticker=RGTI');

  const hub = page.getByTestId('stock-analysis-hub');
  await expect(hub).toBeVisible();
  await expect(hub.getByText(/자료 부족|추가 확인/).first()).toBeVisible();
  await expect(hub).not.toContainText('NaN');
  await expect(page.locator('body')).not.toBeEmpty();
  clean();
});
