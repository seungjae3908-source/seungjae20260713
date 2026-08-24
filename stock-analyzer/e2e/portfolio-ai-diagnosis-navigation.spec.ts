import { test, expect, type Page, type Route } from '@playwright/test';

const NOW = '2026-08-21T05:55:00.000Z';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const AUTH_STORAGE_KEY = 'sb-127-auth-token';

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function installApprovedRuntime(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'portfolio-ai-e2e-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'portfolio-ai@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '포트폴리오 AI 검증 관리자' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: AUTH_STORAGE_KEY, userId: USER_ID, now: NOW });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: USER_ID,
        login_name: 'portfolio-ai-admin',
        display_name: '포트폴리오 AI 검증 관리자',
        role: 'admin',
        status: 'approved',
        membership_level: 'admin',
        is_active: true,
        permissions_updated_at: NOW,
        updated_at: NOW,
      });
    }
    if (pathname.endsWith('/auth/v1/user')) {
      return fulfill(route, {
        id: USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'portfolio-ai@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '포트폴리오 AI 검증 관리자' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });
}

const portfolioFixture = {
  ok: true,
  portfolio: {
    status: 'PARTIAL',
    asOf: NOW,
    totalAssets: { status: 'PARTIAL', normalizedKRW: null, knownNormalizedKRW: 4_820_000 },
    investmentPrincipal: { status: 'PARTIAL', normalizedKRW: null, knownNormalizedKRW: 4_500_000 },
    valuationPnl: { status: 'PARTIAL', normalizedKRW: null, returnPercent: null },
    cash: { status: 'UNAVAILABLE', totalKRW: null },
    minimumCashBuffer: { status: 'UNAVAILABLE', normalizedKRW: null },
    investableCash: { status: 'UNAVAILABLE', normalizedKRW: null },
    assets: { krStocks: 1_500_000, usStocks: 3_320_000, cryptoSpot: null, cryptoFuturesEquity: null, cash: null },
    allocation: { status: 'PARTIAL', knownTotalKRW: 4_820_000, buckets: { KR_STOCKS: 31.1, US_STOCKS: 68.9, CRYPTO_SPOT: null, CRYPTO_FUTURES_EQUITY: null, CASH: null } },
    holdings: [{ id: 'nvda', ticker: 'NVDA', name: 'NVIDIA', market: 'US', currency: 'USD', quantity: 1, averagePrice: 150, currentPrice: 160, nativeValue: 160, normalizedKRW: 220_000 }],
    topHoldings: [{ id: 'nvda', ticker: 'NVDA', name: 'NVIDIA', market: 'US', currency: 'USD', quantity: 1, averagePrice: 150, currentPrice: 160, nativeValue: 160, normalizedKRW: 220_000 }],
    top5Concentration: { status: 'READY', percent: 45.6 },
    correlation: { status: 'INSUFFICIENT_SAMPLE', sampleSize: 8, correlation: null, pair: ['NVDA', '005930'] },
    riskClassification: { status: 'PARTIAL', level: null, reason: 'CASH_AND_CRYPTO_EXPOSURE_UNAVAILABLE' },
    allocationPolicy: { profile: 'BALANCED', status: 'PARTIAL', comparison: [{ assetClass: 'US_STOCKS', currentPercent: 68.9, minPercent: 30, maxPercent: 50, state: 'OVERWEIGHT' }] },
    fx: { status: 'READY', quotes: [{ rate: 1375, pair: 'USD/KRW', source: 'fixture-public-fx', asOf: NOW, quality: 'FRESH' }] },
    dataQuality: { status: 'PARTIAL', providerCount: 5, includedProviderCount: 2, invalidHoldingRows: 0 },
    missingSources: ['cash-account:READONLY_CASH_SOURCE_UNAVAILABLE', 'crypto-futures-equity:PRIVATE_PROVIDER_NOT_CALLED'],
  },
};

test('Portfolio Intelligence와 AI Mentor는 partial provenance를 숨기지 않고 read-only를 유지한다', async ({ page }) => {
  await installApprovedRuntime(page);

  const orderLikeRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/\/(orders?|cancel|withdraw|transfer)(?:\/|$)/i.test(url.pathname)) {
      orderLikeRequests.push(`${request.method()} ${url.pathname}`);
    }
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/portfolio/intelligence') {
      return fulfill(route, portfolioFixture);
    }
    if (url.pathname === '/api/portfolio/intelligence/additional-buy') {
      expect(route.request().method()).toBe('POST');
      const body = route.request().postDataJSON() as { ticker?: string; additionalAmountKRW?: number };
      expect(body).toMatchObject({ ticker: 'NVDA', additionalAmountKRW: 100_000 });
      return fulfill(route, {
        ok: true,
        status: 'UNAVAILABLE',
        priceBasis: 'NORMALIZED_KRW',
        holding: {
          ticker: 'NVDA',
          name: 'NVIDIA',
          market: 'US',
          nativeCurrency: 'USD',
          currentAveragePriceNative: 150,
          currentPriceNative: 160,
          currentPositionValueKRW: 220_000,
        },
        result: {
          status: 'UNAVAILABLE',
          additionalQuantity: 0.4545,
          additionalInvestmentKRW: 100_000,
          newAveragePrice: 213_125,
          currentWeightPercent: 4.56,
          projectedWeightPercent: 6.51,
          stopLoss: null,
          targets: [],
          estimatedMaxLossKRW: null,
          targetProfitsKRW: [],
          missing: ['STOP_LOSS_EVIDENCE', 'TARGET_EVIDENCE'],
        },
        evidence: { stopLoss: 'UNAVAILABLE', targets: 'UNAVAILABLE', source: null },
      });
    }
    if (url.pathname === '/api/portfolio/intelligence/monthly-contribution') {
      expect(route.request().method()).toBe('POST');
      const body = route.request().postDataJSON() as { monthlyAmountKRW?: number; months?: number; profile?: string };
      expect(body).toMatchObject({ monthlyAmountKRW: 300_000, months: 12, profile: 'BALANCED' });
      return fulfill(route, {
        ok: true,
        status: 'PARTIAL',
        allocationBasis: 'CURRENT_KNOWN_ALLOCATION',
        allocationKnownTotalKRW: 4_820_000,
        profileForPolicyComparison: 'BALANCED',
        profileUsedForAllocation: false,
        assumption: 'NO_VALIDATED_RETURN_ASSUMPTION',
        unavailableOutputs: ['FUTURE_RETURN', 'FUTURE_ASSET_VALUE', 'EXPECTED_CAGR'],
        plan: {
          monthlyAmountKRW: 300_000,
          months: 12,
          cumulativeInvestmentKRW: 3_600_000,
          allocations: [
            { key: 'KR_STOCKS', weight: 0.311, cumulativeContributionKRW: 1_119_600 },
            { key: 'US_STOCKS', weight: 0.689, cumulativeContributionKRW: 2_480_400 },
          ],
        },
      });
    }
    if (url.pathname === '/api/paper-journal/portfolio-advisor/query') {
      expect(route.request().method()).toBe('POST');
      const body = route.request().postDataJSON() as { message?: string };
      expect(body.message).toBeTruthy();
      return fulfill(route, {
        sourceOfTruth: 'PORTFOLIO_INTELLIGENCE_V2',
        providerBridgeStatus: 'CALLED_EXISTING_AI_CHAT_SEAM',
        result: {
          intent: 'PORTFOLIO_SUMMARY',
          ai: {
            answer: '서버 canonical facts 기준으로 집중 위험과 누락 데이터를 설명했습니다.',
            kind: 'answer',
            model: 'fixture-model',
            generatedAt: NOW,
            data: {
              status: 'partial',
              asOf: NOW,
              basis: 'server_collection_time',
              sources: ['portfolio-intelligence-v2'],
              missing: ['crypto futures equity unavailable'],
            },
          },
          assistantContext: {
            dataQuality: 'PARTIAL',
            asOf: NOW,
            evidence: [{ source: 'portfolio-intelligence-v2' }],
            warnings: ['cash source unavailable'],
            facts: { knownAssetsKRW: 4_820_000, top5ConcentrationPercent: 45.6 },
          },
          safety: { readOnly: true, orderAuthority: 'none', exchangeRequestSent: false },
        },
      });
    }
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });

  await page.goto('/ai-chat');
  await expect(page.getByRole('heading', { name: 'AI 상담' })).toBeVisible();
  await page.getByRole('button', { name: '포트폴리오' }).click();
  await expect(page.getByTestId('information-portfolio-ai-shortcut')).toContainText('포트폴리오 AI 진단');
  await page.getByRole('button', { name: '내 포트폴리오 분석 열기' }).click();

  await expect(page).toHaveURL(/\/portfolio\?focus=ai$/);
  await expect(page.getByTestId('portfolio-data-quality')).toContainText('공급자 포함 2/5');
  await expect(page.getByTestId('portfolio-known-total')).toContainText('4,820,000원');
  await expect(page.getByText('총 자산은 현금/계좌 등 누락 소스 때문에 확정하지 않습니다.')).toBeVisible();
  await expect(page.getByTestId('portfolio-partial-sources')).toContainText('현금 계좌 read-only 원본 미연결');
  await expect(page.getByTestId('portfolio-partial-sources')).toContainText('Private provider 안전 경계로 계좌 데이터 미수집');
  await expect(page.getByTestId('portfolio-fx-provenance')).toContainText('USD/KRW');
  await expect(page.getByTestId('portfolio-fx-provenance')).toContainText('fixture-public-fx');
  await expect(page.getByTestId('portfolio-fx-provenance')).toContainText('근거 시각');

  await page.getByLabel('추가 투자 금액').fill('100000');
  await page.getByRole('button', { name: '추가매수 계산' }).click();
  await expect(page.getByTestId('portfolio-additional-buy-basis')).toContainText('NORMALIZED_KRW');
  await expect(page.getByTestId('portfolio-additional-buy-basis')).toContainText('STOP_LOSS_EVIDENCE');
  await expect(page.getByTestId('portfolio-additional-buy-basis')).toContainText('TARGET_EVIDENCE');

  await page.getByRole('button', { name: '적립 시뮬레이션 계산' }).click();
  await expect(page.getByText('누적 납입금 3,600,000원')).toBeVisible();
  await expect(page.getByTestId('portfolio-monthly-basis')).toContainText('CURRENT_KNOWN_ALLOCATION');
  await expect(page.getByTestId('portfolio-monthly-basis')).toContainText('허용범위 비교에만 사용');
  await expect(page.getByTestId('portfolio-monthly-basis')).toContainText('목표비중을 임의 생성하지 않습니다');

  const diagnosis = page.getByTestId('portfolio-ai-diagnosis');
  await expect(diagnosis).toBeVisible();
  await expect(diagnosis).toContainText('Portfolio Copilot');
  await expect(diagnosis).toContainText('AI Portfolio Mentor');
  await expect(diagnosis).not.toContainText('Gemini Free → Groq Free');
  await expect(diagnosis).toContainText('누락값을 보정하지 않으며 주문도 실행하지 않습니다.');

  await diagnosis.getByRole('button', { name: 'AI 진단' }).click();
  const aiResult = page.getByTestId('portfolio-ai-diagnosis-result');
  await expect(aiResult).toContainText('canonical facts');
  await expect(aiResult).toContainText('PARTIAL');
  await expect(aiResult).toContainText('읽기 전용 · 주문 권한 없음');
  await expect(page.getByTestId('portfolio-ai-warnings')).toContainText('cash source unavailable');
  await expect(page.getByTestId('portfolio-ai-warnings')).toContainText('crypto futures equity unavailable');
  await expect(page.getByTestId('portfolio-ai-evidence')).toContainText('portfolio-intelligence-v2');
  await expect(page.getByTestId('portfolio-ai-source')).toContainText('서버 수집 시각');
  await expect(page.getByTestId('portfolio-ai-source')).toContainText('model fixture-model');
  await expect(aiResult).toContainText('PORTFOLIO_INTELLIGENCE_V2');
  await expect(aiResult).toContainText('CALLED_EXISTING_AI_CHAT_SEAM');
  expect(orderLikeRequests).toEqual([]);
});
