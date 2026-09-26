import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { safeTradeErrorMessage } from '../src/lib/trade-approval-ui';
import {
  buildPositionGuidance,
  feeInclusiveBreakEvenPrice,
  projectPartialExit,
  projectPriceOutcome,
  projectedAverageEntry,
} from '../src/lib/ai-chart-position-analytics';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

function positionPanelSources() {
  return {
    wrapper: source('src/components/ai-chart-position-panel.tsx'),
    implementation: source('src/components/ai-chart-position-panel-impl.tsx'),
  };
}

const chartUrl = '/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m&strategyMode=SCALPING';

function candleRows() {
  const end = Date.now() - 5 * 60_000;
  return Array.from({ length: 90 }, (_, index) => {
    const base = 70_000 + index * 20;
    return {
      time: new Date(end - (89 - index) * 5 * 60_000).toISOString(),
      open: base - 10,
      high: base + 80,
      low: base - 80,
      close: base + 30,
      volume: 1_000 + index * 25,
      isClosed: true,
    };
  });
}

test('AI Chart position panel stays explicit read-only and fail-closed', () => {
  const { wrapper, implementation: panel } = positionPanelSources();

  expect(wrapper).toContain("import { lazy, Suspense } from 'react';");
  expect(wrapper).toContain("import('./ai-chart-position-panel-impl')");
  expect(wrapper).toContain('<Suspense');
  expect(wrapper).toContain('<LazyAiChartPositionPanel {...props} />');
  expect(wrapper).not.toContain("import { authorizedFetch } from '@/lib/auth-fetch';");
  expect(wrapper).not.toContain('authorizedFetch(`/api/accounts/read-only/${provider}`');

  expect(panel).toContain("import { authorizedFetch } from '@/lib/auth-fetch';");
  expect(panel).toContain('authorizedFetch(`/api/accounts/read-only/${provider}`');
  expect(panel).toContain('data-testid="ai-chart-load-position"');
  expect(panel).toContain('onClick={() => void loadPosition()}');
  expect(panel).toContain('차트를 열기만 해서는 계좌를 조회하지 않습니다.');
  expect(panel).not.toContain('void loadPosition();');

  expect(panel).toContain('candidate.provider !== provider');
  expect(panel).toContain("code: 'ACCOUNT_SNAPSHOT_PROVIDER_MISMATCH'");
  expect(panel).toContain('candidate.connected !== true');
  expect(panel).toContain("candidate.errorCode || candidate.status || 'ACCOUNT_NOT_CONNECTED'");
  expect(panel).toContain('snapshot.orderRequests !== 0');
  expect(panel).toContain('snapshot.cancelRequests !== 0');
  expect(panel).toContain('snapshot.amendRequests !== 0');
  expect(panel).toContain('snapshot.transferRequests !== 0');
  expect(panel).toContain('snapshot.withdrawalRequests !== 0');
  expect(panel).toContain('snapshot.liveTradingEnabled !== false');
  expect(panel).toContain('snapshot.autoTradingEnabled !== false');
  expect(panel).toContain("code: 'ACCOUNT_SNAPSHOT_SAFETY_MISMATCH'");

  expect(panel).toContain("window.confirm");
  expect(panel).toContain("/api/trade-automation/orders/");
  expect(panel).toContain("/cancel");
  expect(panel).toContain("/amend");
  expect(panel).toContain("JSON.stringify({ confirmed: true })");
  expect(panel).toContain("setExitPreviewState({ kind: 'idle' });");
  expect(panel).toContain("confirmed: true");
  expect(panel).toContain("자동 조회·자동 취소·자동 정정 없음");
  expect(panel).toContain("item.state === 'ACCEPTED'");
  expect(panel).toContain("item.filledQuantity === 0");
  expect(panel).toContain("isUsStockPriceOnlyAmend(item)");
  expect(panel).toContain("const quantity = priceOnly ? null");
  expect(panel).toContain("부분체결된 주문은 정정하지 않고 미체결 잔량 취소 후 새 계획으로 다시 검증합니다.");
  expect(panel).toContain("ScannerApprovalComposer selection={selection}");
  expect(panel).toContain("data-testid=\"ai-chart-entry-planning\"");
  expect(panel).toContain("이 화면에서 새로 만드는 진입은 현재 Paper 전용입니다.");
  expect(panel).toContain("실전 신규진입은 브라우저에서 임의 생성하지 않으며");
  expect(panel).toContain("Live 신규계획 생성 · 미연결");
  expect(panel).toContain("data-testid=\"ai-chart-exit-dashboard-unavailable\"");
  expect(panel).toContain("현재 종목 보유 포지션이 없어 종료계획을 만들지 않습니다.");
  expect(panel).toContain("{tradingCockpit}");
  expect(panel).toContain("const orderAbortRef = useRef<AbortController | null>(null);");
  expect(panel).toContain("const exitAbortRef = useRef<AbortController | null>(null);");
  expect(panel).toContain("orderAbortRef.current?.abort();");
  expect(panel).toContain("exitAbortRef.current?.abort();");
  expect(panel).toContain("dashboard: '1'");
  expect(panel).toContain("exchange: provider");
  expect(panel).toContain("signal: controller.signal");
  const approvalQueue = source('src/components/trade-approval-queue.tsx');
  const tradeRoute = source('../api-server/src/routes/trade-automation.ts');
  expect(approvalQueue).toContain("if (symbolFilter) query.set('symbol', symbolFilter);");
  expect(approvalQueue).toContain("if (exchangeFilter) query.set('exchange', exchangeFilter);");
  expect(tradeRoute).toContain("if (requestedExchange && plan.exchange !== requestedExchange) return false;");
  expect(tradeRoute).toContain("if (requestedSymbol && normalizedExitSymbol(plan.symbol) !== requestedSymbol) return false;");
  expect(tradeRoute).toContain("exchangeOrderId: order.exchangeOrderId");
  expect(panel).toContain("providerOrderStatusLabel(canonicalProviderOrderStatus(item, providerOpenOrders))");
  expect(panel).toContain("data-testid=\"ai-chart-cockpit-tabs\"");
  expect(panel).toContain("type CockpitTab = 'entry' | 'orders' | 'exit';");
  expect(panel).toContain("data-testid=\"ai-chart-entry-readiness\"");
  expect(panel).toContain("data-testid=\"ai-chart-load-entry-readiness\"");
  expect(panel).toContain("authorizedFetch('/api/trade-automation/status'");
  expect(panel).toContain("actualOrderSubmittedByStatusRequest !== false");
  expect(panel).toContain("payload.policy?.stockBrokerByMarket?.domestic_stock");
  expect(panel).toContain("payload.policy?.stockBrokerByMarket?.us_stock");
  expect(panel).toContain("orderTimeRiskRecheckRequired !== true");
});

test('AI Chart order dashboard server read model is instrument-scoped and mutation-free', () => {
  const route = source('../api-server/src/routes/trade-automation.ts');
  expect(route).toContain("const dashboardOnly = String(req.query.dashboard ?? '') === '1';");
  expect(route).toContain("if (dashboardOnly && !requestedSymbol) throw new Error('ORDER_DASHBOARD_SYMBOL_REQUIRED');");
  expect(route).toContain("if (requestedExchange && order.exchange !== requestedExchange) return [];");
  expect(route).toContain("if (normalizedExitSymbol(plan.symbol) !== requestedSymbol) return [];");
  expect(route).toContain("events,");
  expect(route).toContain("dashboardScoped: dashboardOnly");
  expect(route).toContain("orderSubmitted: false");
  expect(route).toContain("orderCanceled: false");
  expect(route).toContain("orderAmended: false");
  expect(route).toContain("privateTradingRequestSent: false");
});

test('cockpit translates canonical cancel and amend blockers without exposing raw codes', () => {
  expect(safeTradeErrorMessage('LIVE_EXECUTION_DISABLED', 'fallback')).toContain('실전 주문');
  expect(safeTradeErrorMessage('CANCEL_CONNECTION_UNAVAILABLE', 'fallback')).toContain('실전 거래 연결');
  expect(safeTradeErrorMessage('PARTIAL_FILL_AMEND_REQUIRES_CANCEL_AND_REPLAN', 'fallback')).toContain('부분체결');
  expect(safeTradeErrorMessage('AMEND_PRICE_EXCEEDS_APPROVED_RISK_ENVELOPE', 'fallback')).toContain('위험범위');
  expect(safeTradeErrorMessage('US_STOCK_AMEND_QUANTITY_NOT_SUPPORTED', 'fallback')).toContain('가격만 정정');
});

test('AI Chart matches four-market positions without inventing missing values', () => {
  const { implementation: panel } = positionPanelSources();

  expect(panel).toContain("if (market === 'UPBIT') return 'upbit';");
  expect(panel).toContain("if (market === 'BITGET') return 'bitget';");
  expect(panel).toContain("type StockReadOnlyProvider = 'toss' | 'kiwoom';");
  expect(panel).toContain('return stockProvider;');
  expect(panel).toContain('data-testid="ai-chart-stock-provider-picker"');
  expect(panel).toContain('data-testid={`ai-chart-stock-provider-${item}`}');
  expect(panel).toContain("if (upper.startsWith('KRW-'))");
  expect(panel).toContain('positionMarketMatches(market, position.market)');
  expect(panel).toContain('if (matches.length > 1) return { position: null, ambiguous: true };');
  expect(panel).toContain("code: 'MULTIPLE_MATCHING_POSITIONS'");
  expect(panel).toContain("return parsed == null ? '미제공'");
  expect(panel).toContain('누락된 가격·수량·수수료 근거는 0으로 바꾸지 않고 미제공으로 유지합니다.');
});

test('AI Chart draws only evidence-backed average-entry and liquidation position lines', () => {
  const canvas = source('src/components/pattern-aware-unified-chart-canvas.tsx');

  expect(canvas).toContain('positionPriceLines: IPriceLine[];');
  expect(canvas).toContain('removePriceLines(instance.candle, instance.positionPriceLines);');
  expect(canvas).toContain("title: positionOverlay.stale ? '내 평단 · 오래된 값' : '내 평단'");
  expect(canvas).toContain("market === 'BITGET' && validPlanPrice(liquidation)");
  expect(canvas).toContain("title: positionOverlay.stale ? '청산가 · 오래된 값' : '청산가'");
  expect(canvas).toContain('data-position-average={positionOverlay?.position.averageEntryPrice ?? \'\'}');
  expect(canvas).toContain('data-position-liquidation={positionOverlay?.position.liquidationPrice ?? \'\'}');

  expect(canvas).toContain("title: 'Scanner 손절'");
  expect(canvas).toContain('title: `Scanner 목표 ${index + 1}`');
});

test('AI Chart wires Scanner PricePlan into position analytics without execution authority', () => {
  const { wrapper, implementation: panel } = positionPanelSources();
  const canvas = source('src/components/pattern-aware-unified-chart-canvas.tsx');

  expect(wrapper).toContain('pricePlan?: AnalysisPricePlan;');
  expect(wrapper).toContain("import('./ai-chart-position-panel-impl')");
  expect(canvas).toContain('pricePlan={pricePlan}');
  expect(panel).toContain('data-testid="ai-chart-price-scenarios"');
  expect(panel).toContain('data-testid="ai-chart-additional-entry"');
  expect(panel).toContain('data-testid="ai-chart-partial-exit"');
  expect(panel).toContain('data-testid="ai-chart-fee-break-even"');
  expect(panel).toContain('data-testid="ai-chart-position-guidance"');
  expect(panel).toContain('Provider 수수료 근거가 계좌 스냅샷에 없으므로 자동으로 추정하지 않습니다.');
  expect(panel).toContain('실행 신호가 아니며 주문 권한이 없습니다.');
});

test('position analytics compute cash-market average, target, stop, partial exit and evidence-backed break-even', () => {
  const position = {
    market: 'KR',
    quantity: 20,
    averageEntryPrice: 70_000,
    currentPrice: 72_100,
    unrealizedPnl: 42_000,
    liquidationPrice: null,
    side: null,
  };

  const additional = projectedAverageEntry({
    market: 'KR',
    position,
    chartPrice: 72_100,
    additionalValue: 300_000,
    additionalPrice: 60_000,
  });
  expect(additional?.mode).toBe('NOTIONAL');
  expect(additional?.additionalQuantity).toBeCloseTo(5, 8);
  expect(additional?.projectedAverageEntryPrice).toBeCloseTo(68_000, 8);

  const target = projectPriceOutcome({ market: 'KR', position, chartPrice: 72_100, price: 75_000 });
  expect(target?.priceReturnPercent).toBeCloseTo(7.142857, 5);
  expect(target?.pnlAmount).toBeCloseTo(100_000, 8);
  expect(target?.pnlSource).toBe('POSITION_QUANTITY');

  const stop = projectPriceOutcome({ market: 'KR', position, chartPrice: 72_100, price: 68_000 });
  expect(stop?.pnlAmount).toBeCloseTo(-40_000, 8);

  const partial = projectPartialExit({ market: 'KR', position, chartPrice: 72_100, price: 75_000, percent: 25 });
  expect(partial?.quantity).toBeCloseTo(5, 8);
  expect(partial?.grossValue).toBeCloseTo(375_000, 8);
  expect(partial?.pnlAmount).toBeCloseTo(25_000, 8);

  expect(feeInclusiveBreakEvenPrice(position, null)).toBeNull();
  expect(feeInclusiveBreakEvenPrice(position, {
    entryFeePercent: 0.1,
    exitFeePercent: 0.1,
    source: 'USER_INPUT',
  })).toBeCloseTo(70_140.14014014, 6);

  const guidance = buildPositionGuidance({
    position,
    chartPrice: 72_100,
    pricePlan: {
      entryZone: null,
      stopLoss: 68_000,
      invalidation: 67_500,
      targets: [75_000, 78_000],
      riskReward: 2,
    },
  });
  expect(guidance.state).toBe('PROFIT');
  expect(guidance.nearestTarget).toBe(75_000);
  expect(guidance.stopPrice).toBe(68_000);
  expect(guidance.averageDistancePercent).toBeGreaterThan(0);
});

test('Bitget target PnL uses provider-implied current PnL sensitivity instead of assuming contract quantity', () => {
  const shortPosition = {
    quantity: 7,
    averageEntryPrice: 100,
    currentPrice: 90,
    unrealizedPnl: 50,
    liquidationPrice: 120,
    side: 'short',
  };
  const outcome = projectPriceOutcome({
    market: 'BITGET',
    position: shortPosition,
    chartPrice: 90,
    price: 80,
  });
  expect(outcome?.priceReturnPercent).toBeCloseTo(20, 8);
  expect(outcome?.pnlAmount).toBeCloseTo(100, 8);
  expect(outcome?.pnlSource).toBe('PROVIDER_IMPLIED');

  const noProviderPnl = projectPriceOutcome({
    market: 'BITGET',
    position: { ...shortPosition, unrealizedPnl: null },
    chartPrice: 90,
    price: 80,
  });
  expect(noProviderPnl?.pnlAmount).toBeNull();
  expect(noProviderPnl?.pnlSource).toBeNull();
});

test('desktop AI Chart reads the Toss position only after an explicit click and renders money scenarios without financial mutation', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  let accountReads = 0;
  let exitPreviewReads = 0;
  let entryReadinessReads = 0;
  const financialMutations: string[] = [];

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (/\/(orders?|cancel|amend|transfer|withdraw)(?:\/|\?|$)/i.test(url.pathname) && request.method() !== 'GET') {
      financialMutations.push(`${request.method()} ${url.pathname}`);
    }
    if (/\/api\/stocks\/[^/]+\/(?:chart|candles)$/.test(url.pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ticker: '005930',
          timeframe: url.searchParams.get('tf') ?? '5m',
          provider: 'position-overlay-fixture',
          fetchedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          candles: candleRows(),
        }),
      });
      return;
    }
    if (url.pathname === '/api/quotes') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ quotes: [] }) });
      return;
    }
    if (url.pathname === '/api/trade-automation/status') {
      entryReadinessReads += 1;
      expect(request.method()).toBe('GET');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          actualOrderSubmittedByStatusRequest: false,
          policy: {
            stockBrokerByMarket: { domestic_stock: 'kiwoom', us_stock: 'toss' },
          },
          liveExecutionReadiness: {
            kiwoom: {
              connectionConfigured: false,
              providerVerified: false,
              manualServerGateEnabled: false,
              automaticServerGateEnabled: false,
              readyForManualOrderEvaluation: false,
              readyForAutomaticOrderEvaluation: false,
              blockers: ['LIVE_CONNECTION_NOT_CONFIGURED', 'MANUAL_LIVE_SERVER_GATE_OFF'],
              orderTimeRiskRecheckRequired: true,
              orderSubmissionPerformedByStatusRequest: false,
            },
          },
        }),
      });
      return;
    }
    if (url.pathname === '/api/trade-automation/approval-queue') {
      expect(request.method()).toBe('GET');
      expect(url.searchParams.get('symbol')).toBe('005930');
      expect(url.searchParams.get('exchange')).toBeNull();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          items: [],
          count: 0,
          updatedAt: new Date().toISOString(),
          orderSubmitted: false,
          orderCanceled: false,
          privateTradingRequestSent: false,
        }),
      });
      return;
    }
    if (url.pathname === '/api/trade-automation/positions/exit-preview') {
      exitPreviewReads += 1;
      expect(request.method()).toBe('POST');
      const body = request.postDataJSON() as {
        confirmed?: boolean;
        provider?: string;
        market?: string;
        symbol?: string;
        percent?: number;
      };
      expect(body).toEqual({
        confirmed: true,
        provider: 'toss',
        market: 'KR',
        symbol: '005930',
        percent: 25,
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          preview: {
            provider: 'toss',
            market: 'KR',
            symbol: '005930',
            percent: 25,
            positionSide: null,
            positionQuantity: 20,
            availableQuantity: 20,
            exitQuantity: 5,
            quantityRule: 'INTEGER_ONLY',
            side: 'sell',
            reduceOnly: true,
            checkedAt: new Date().toISOString(),
            stale: false,
          },
          privateAccountReadPerformed: true,
          orderSubmitted: false,
          orderCanceled: false,
          orderAmended: false,
          privateTradingMutationSent: false,
          executionAuthority: 'NONE',
          executionReadiness: {
            connectionConfigured: false,
            providerVerified: false,
            manualServerGateEnabled: false,
            readyForManualExitEvaluation: false,
            blockers: ['LIVE_CONNECTION_NOT_CONFIGURED', 'MANUAL_LIVE_SERVER_GATE_OFF'],
            orderSubmissionPerformedByPreview: false,
            executionAuthorityGrantedByPreview: false,
          },
        }),
      });
      return;
    }
    if (url.pathname === '/api/trade-automation/orders') {
      expect(request.method()).toBe('GET');
      expect(url.searchParams.get('dashboard')).toBe('1');
      expect(url.searchParams.get('symbol')).toBe('005930');
      expect(url.searchParams.get('exchange')).toBeNull();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          orders: [],
          events: [],
          dashboardItems: [{
            id: 'order-005930',
            planId: 'plan-005930',
            exchange: 'toss',
            symbol: '005930',
            market: 'KR',
            side: 'buy',
            accountMode: 'paper',
            orderType: 'limit',
            reduceOnly: false,
            state: 'ACCEPTED',
            clientOrderId: 'client-order-005930',
            exchangeOrderId: 'provider-open-005930',
            requestedQuantity: 10,
            remainingQuantity: 4,
            filledQuantity: 6,
            currentLimitPrice: 70_500,
            averageFillPrice: 70_200,
            cancelable: true,
            lastErrorCode: null,
            updatedAt: new Date().toISOString(),
          }, {
            id: 'order-005930-kiwoom',
            planId: 'plan-005930-kiwoom',
            exchange: 'kiwoom',
            symbol: '005930',
            market: 'KR',
            side: 'sell',
            accountMode: 'paper',
            orderType: 'limit',
            reduceOnly: true,
            state: 'PARTIALLY_FILLED',
            requestedQuantity: 5,
            remainingQuantity: 2,
            filledQuantity: 3,
            currentLimitPrice: 72_500,
            averageFillPrice: 72_300,
            cancelable: true,
            lastErrorCode: null,
            updatedAt: new Date().toISOString(),
          }],
          orderSubmitted: false,
          orderCanceled: false,
          orderAmended: false,
          privateTradingRequestSent: false,
        }),
      });
      return;
    }
    if (url.pathname === '/api/accounts/read-only/toss') {
      accountReads += 1;
      expect(request.method()).toBe('GET');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          provider: 'toss',
          readOnly: true,
          connected: true,
          status: 'CONNECTED',
          accounts: [{
            market: 'KR',
            accountRef: '12****34',
            currency: 'KRW',
            buyingPower: 500_000,
          }],
          balances: [{
            currency: 'KRW',
            available: 400_000,
            locked: 0,
            total: 400_000,
            estimatedKrwValue: 400_000,
          }],
          positions: [{
            market: 'KR',
            symbol: '005930',
            quantity: 20,
            availableQuantity: 20,
            averageEntryPrice: 70_000,
            currentPrice: 72_100,
            marketValue: 1_442_000,
            unrealizedPnl: 42_000,
            unrealizedPnlPercent: 3,
            leverage: null,
            liquidationPrice: null,
            marginMode: null,
            side: null,
          }],
          openOrders: [{
            id: 'provider-open-005930',
            market: 'KR',
            symbol: '005930',
            side: 'BUY',
            price: 70_300,
            quantity: 3,
            remainingQuantity: 2,
            status: 'OPEN',
          }],
          checkedAt: new Date().toISOString(),
          lastGoodAt: new Date().toISOString(),
          stale: false,
          errorCode: null,
          orderRequests: 0,
          cancelRequests: 0,
          amendRequests: 0,
          transferRequests: 0,
          withdrawalRequests: 0,
          credentialsReturned: false,
          liveTradingEnabled: false,
          autoTradingEnabled: false,
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(chartUrl);
  const panel = page.getByTestId('ai-chart-position-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('차트를 열기만 해서는 계좌를 조회하지 않습니다.');
  expect(accountReads).toBe(0);

  await page.getByTestId('ai-chart-load-position').click();
  await expect.poll(() => accountReads).toBe(1);
  await expect(panel).toContainText('내 평단');
  await expect(panel).toContainText('70,000원');
  await expect(panel).toContainText('20');
  await expect(panel).toContainText('+42,000원');
  await expect(panel.getByTestId('ai-chart-account-capacity')).toContainText('500,000원');
  await expect(panel.getByTestId('ai-chart-account-capacity')).toContainText('Provider 미체결');
  await expect(panel.getByTestId('ai-chart-account-capacity')).toContainText('1건');
  await expect(panel.getByTestId('ai-chart-position-guidance')).toContainText('평단 기준 수익 구간');
  await expect(page.getByTestId('unified-chart-wrapper')).toHaveAttribute('data-position-average', '70000');

  await page.getByTestId('ai-chart-additional-value').fill('300000');
  await page.getByTestId('ai-chart-additional-price').fill('60000');
  await expect(panel.getByTestId('ai-chart-additional-entry')).toContainText('68,000원');

  await expect(panel.getByTestId('ai-chart-fee-break-even')).toContainText('Provider 수수료 근거가 계좌 스냅샷에 없으므로 자동으로 추정하지 않습니다.');

  const cockpit = panel.getByTestId('ai-chart-trading-cockpit');
  await cockpit.locator('summary').click();
  await expect(cockpit.getByTestId('ai-chart-cockpit-lifecycle')).toContainText('신호 필요');
  await expect(cockpit.getByTestId('ai-chart-cockpit-lifecycle')).toContainText('포지션 있음');
  await expect(cockpit.getByTestId('ai-chart-cockpit-lifecycle')).toContainText('미조회');
  await expect(cockpit.getByTestId('ai-chart-cockpit-lifecycle')).toContainText('재검증 필요');
  await expect(cockpit).toContainText('현재 종목의 승인 대기 진입이 없습니다.');
  await cockpit.getByTestId('ai-chart-load-entry-readiness').click();
  await expect.poll(() => entryReadinessReads).toBe(1);
  await expect(cockpit.getByTestId('ai-chart-entry-readiness')).toContainText('수동 실전 진입 · 차단');
  await expect(cockpit.getByTestId('ai-chart-entry-readiness')).toContainText('실행 경로 Kiwoom');
  await expect(cockpit.getByTestId('ai-chart-entry-readiness')).toContainText('LIVE_CONNECTION_NOT_CONFIGURED');
  await expect(cockpit.getByTestId('ai-chart-entry-readiness')).toContainText('주문 제출 없음');
  await cockpit.getByRole('tab', { name: '주문', exact: true }).click();
  await expect(cockpit.getByTestId('ai-chart-provider-open-orders')).toContainText('Provider 실제 미체결');
  await expect(cockpit.getByTestId('ai-chart-provider-open-orders')).toContainText('BUY · OPEN');
  await expect(cockpit.getByTestId('ai-chart-provider-open-orders')).toContainText('70,300원');
  await expect(cockpit.getByTestId('ai-chart-provider-open-orders')).toContainText('잔량 2');
  await expect(cockpit.getByTestId('ai-chart-provider-open-orders')).toContainText('여기서 취소·정정 권한을 만들지 않습니다.');
  await cockpit.getByRole('tab', { name: '종료', exact: true }).click();
  await expect(cockpit.getByTestId('ai-chart-exit-dashboard')).toContainText('종료 예정 비중');
  await expect(cockpit.getByTestId('ai-chart-exit-dashboard')).toContainText('20');
  await cockpit.getByRole('button', { name: '25%' }).click();
  await expect(cockpit.getByTestId('ai-chart-exit-dashboard')).toContainText('5');
  await cockpit.getByTestId('ai-chart-verify-exit-preview').click();
  await expect.poll(() => exitPreviewReads).toBe(1);
  await expect(cockpit.getByTestId('ai-chart-exit-preview-verified')).toContainText('서버 확인 수량 5');
  await expect(cockpit.getByTestId('ai-chart-exit-preview-verified')).toContainText('수량규칙 정수');
  await expect(cockpit.getByTestId('ai-chart-exit-preview-verified')).toContainText('executionAuthority=NONE');
  await expect(cockpit.getByTestId('ai-chart-cockpit-lifecycle')).toContainText('재검증됨');
  await expect(cockpit.getByTestId('ai-chart-exit-readiness')).toContainText('실전 종료 준비 · 차단');
  await expect(cockpit.getByTestId('ai-chart-exit-readiness')).toContainText('실전 거래키가 연결되지 않음');
  await expect(cockpit.getByTestId('ai-chart-exit-readiness')).toContainText('실주문 서버게이트가 꺼져 있음');

  await cockpit.getByTestId('ai-chart-load-orders').click();
  await expect(cockpit.getByTestId('ai-chart-order-management')).toContainText('거래소 접수');
  await expect(cockpit.getByTestId('ai-chart-order-management')).toContainText('잔량 4');
  await expect(cockpit.getByTestId('ai-chart-order-provider-match-order-005930')).toContainText('Provider 원장 일치');
  await expect(cockpit.getByTestId('ai-chart-order-management')).toContainText('Kiwoom');
  await expect(cockpit.getByTestId('ai-chart-order-management')).toContainText('부분체결');
  await expect(cockpit.getByTestId('ai-chart-order-management')).toContainText('잔량 2');
  await expect(cockpit.getByTestId('ai-chart-cockpit-lifecycle')).toContainText('2건');

  await page.getByTestId('ai-chart-toggle-position-lines').click();
  await expect(page.getByTestId('unified-chart-wrapper')).toHaveAttribute('data-position-average', '');
  expect(financialMutations).toEqual([]);
});


test('AI Chart keeps entry approval and order management available when the selected symbol has no position', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const financialMutations: string[] = [];

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (/\/(orders?|cancel|amend|transfer|withdraw)(?:\/|\?|$)/i.test(url.pathname) && request.method() !== 'GET') {
      financialMutations.push(`${request.method()} ${url.pathname}`);
    }
    if (/\/api\/stocks\/[^/]+\/(?:chart|candles)$/.test(url.pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ticker: '005930',
          timeframe: url.searchParams.get('tf') ?? '5m',
          provider: 'no-position-fixture',
          fetchedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          candles: candleRows(),
        }),
      });
      return;
    }
    if (url.pathname === '/api/quotes') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ quotes: [] }) });
      return;
    }
    if (url.pathname === '/api/accounts/read-only/toss') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          provider: 'toss',
          readOnly: true,
          connected: true,
          status: 'CONNECTED',
          accounts: null,
          balances: null,
          positions: [],
          openOrders: null,
          checkedAt: new Date().toISOString(),
          lastGoodAt: new Date().toISOString(),
          stale: false,
          errorCode: null,
          orderRequests: 0,
          cancelRequests: 0,
          amendRequests: 0,
          transferRequests: 0,
          withdrawalRequests: 0,
          credentialsReturned: false,
          liveTradingEnabled: false,
          autoTradingEnabled: false,
        }),
      });
      return;
    }
    if (url.pathname === '/api/trade-automation/approval-queue') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          items: [],
          count: 0,
          updatedAt: new Date().toISOString(),
          orderSubmitted: false,
          orderCanceled: false,
          privateTradingRequestSent: false,
        }),
      });
      return;
    }
    if (url.pathname === '/api/trade-automation/orders') {
      expect(url.searchParams.get('dashboard')).toBe('1');
      expect(url.searchParams.get('symbol')).toBe('005930');
      expect(url.searchParams.get('exchange')).toBeNull();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          orders: [],
          events: [],
          dashboardItems: [],
          orderSubmitted: false,
          orderCanceled: false,
          orderAmended: false,
          privateTradingRequestSent: false,
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(chartUrl);
  await page.getByRole('tab', { name: '차트', exact: true }).click();
  const panel = page.getByTestId('ai-chart-position-panel');
  await panel.getByTestId('ai-chart-load-position').click();
  await expect(panel).toContainText('현재 선택 종목의 보유/포지션 없음');

  const cockpit = panel.getByTestId('ai-chart-trading-cockpit');
  await cockpit.locator('summary').click();
  await expect(cockpit.getByTestId('ai-chart-cockpit-lifecycle')).toContainText('없음');
  await expect(cockpit.getByTestId('ai-chart-cockpit-lifecycle')).toContainText('해당 없음');
  await expect(cockpit).toContainText('현재 종목의 승인 대기 진입이 없습니다.');
  await cockpit.getByRole('tab', { name: '종료', exact: true }).click();
  await expect(cockpit.getByTestId('ai-chart-exit-dashboard-unavailable')).toContainText('종료계획을 만들지 않습니다.');
  await cockpit.getByRole('tab', { name: '주문', exact: true }).click();
  await cockpit.getByTestId('ai-chart-load-orders').click();
  await expect(cockpit.getByTestId('ai-chart-order-management')).toContainText('canonical 주문 기록이 없습니다.');
  expect(financialMutations).toEqual([]);
});


for (const viewport of [
  { width: 768, height: 1024, mobileTabs: true },
  { width: 1024, height: 900, mobileTabs: false },
] as const) {
  test(`AI Chart cockpit fits ${viewport.width}px without horizontal overflow`, async ({ page, context }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (/\/api\/stocks\/[^/]+\/(?:chart|candles)$/.test(url.pathname)) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ticker: '005930',
            timeframe: url.searchParams.get('tf') ?? '5m',
            provider: 'tablet-cockpit-fixture',
            fetchedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            candles: candleRows(),
          }),
        });
        return;
      }
      if (url.pathname === '/api/quotes') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ quotes: [] }) });
        return;
      }
      if (url.pathname === '/api/accounts/read-only/toss') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            provider: 'toss',
            readOnly: true,
            connected: true,
            status: 'CONNECTED',
            accounts: [{ market: 'KR', accountRef: '12****34', currency: 'KRW', buyingPower: 500_000 }],
            balances: [],
            positions: [{
              market: 'KR', symbol: '005930', quantity: 20, availableQuantity: 20,
              averageEntryPrice: 70_000, currentPrice: 72_100, marketValue: 1_442_000,
              unrealizedPnl: 42_000, unrealizedPnlPercent: 3, leverage: null,
              liquidationPrice: null, marginMode: null, side: null,
            }],
            openOrders: [],
            checkedAt: new Date().toISOString(),
            lastGoodAt: new Date().toISOString(),
            stale: false,
            errorCode: null,
            orderRequests: 0,
            cancelRequests: 0,
            amendRequests: 0,
            transferRequests: 0,
            withdrawalRequests: 0,
            credentialsReturned: false,
            liveTradingEnabled: false,
            autoTradingEnabled: false,
          }),
        });
        return;
      }
      if (url.pathname === '/api/trade-automation/approval-queue') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, items: [], count: 0, updatedAt: new Date().toISOString() }),
        });
        return;
      }
      if (url.pathname === '/api/trade-automation/orders') {
        expect(url.searchParams.get('dashboard')).toBe('1');
        expect(url.searchParams.get('exchange')).toBeNull();
        expect(url.searchParams.get('symbol')).toBe('005930');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            orders: [],
            events: [],
            dashboardItems: [],
            dashboardScoped: true,
            orderSubmitted: false,
            orderCanceled: false,
            orderAmended: false,
            privateTradingRequestSent: false,
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(chartUrl);
    if (viewport.mobileTabs) {
      await page.getByRole('tab', { name: '차트', exact: true }).click();
    } else {
      await expect(page.getByTestId('ai-chart-mobile-tabs')).toHaveCount(0);
    }

    const panel = page.getByTestId('ai-chart-position-panel');
    await expect(panel).toBeVisible();
    await panel.getByTestId('ai-chart-load-position').click();
    await expect(panel).toContainText('70,000원');
    const cockpit = panel.getByTestId('ai-chart-trading-cockpit');
    await cockpit.locator('summary').click();
    await expect(cockpit.getByTestId('ai-chart-entry-planning')).toBeVisible();
    await cockpit.getByRole('tab', { name: '주문', exact: true }).click();
    await expect(cockpit.getByTestId('ai-chart-order-management')).toBeVisible();
    await cockpit.getByTestId('ai-chart-load-orders').click();
    await cockpit.getByRole('tab', { name: '종료', exact: true }).click();
    await expect(cockpit.getByTestId('ai-chart-exit-dashboard')).toBeVisible();

    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      body: document.body.scrollWidth,
      root: document.documentElement.scrollWidth,
    }));
    expect(overflow.body).toBeLessThanOrEqual(overflow.viewport + 1);
    expect(overflow.root).toBeLessThanOrEqual(overflow.viewport + 1);
  });
}


test('AI Chart cockpit cancel and amend require explicit user confirmation and reuse canonical routes', async ({ page, context }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  let cancelPosts = 0;
  let amendPosts = 0;
  let dashboardReads = 0;

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (/\/api\/stocks\/[^/]+\/(?:chart|candles)$/.test(url.pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ticker: '005930',
          timeframe: url.searchParams.get('tf') ?? '5m',
          provider: 'cockpit-action-fixture',
          fetchedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          candles: candleRows(),
        }),
      });
      return;
    }
    if (url.pathname === '/api/quotes') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ quotes: [] }) });
      return;
    }
    if (url.pathname === '/api/accounts/read-only/toss') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          provider: 'toss',
          readOnly: true,
          connected: true,
          status: 'CONNECTED',
          accounts: [{ market: 'KR', accountRef: '12****34', currency: 'KRW', buyingPower: 500_000 }],
          balances: [],
          positions: [],
          openOrders: [],
          checkedAt: new Date().toISOString(),
          lastGoodAt: new Date().toISOString(),
          stale: false,
          errorCode: null,
          orderRequests: 0,
          cancelRequests: 0,
          amendRequests: 0,
          transferRequests: 0,
          withdrawalRequests: 0,
          credentialsReturned: false,
          liveTradingEnabled: false,
          autoTradingEnabled: false,
        }),
      });
      return;
    }
    if (url.pathname === '/api/trade-automation/approval-queue') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, items: [], count: 0, updatedAt: new Date().toISOString() }),
      });
      return;
    }
    if (url.pathname === '/api/trade-automation/orders' && request.method() === 'GET') {
      expect(url.searchParams.get('dashboard')).toBe('1');
      expect(url.searchParams.get('symbol')).toBe('005930');
      expect(url.searchParams.get('exchange')).toBeNull();
      dashboardReads += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          orders: [],
          events: [],
          dashboardScoped: true,
          dashboardItems: [{
            id: 'order-005930',
            planId: 'plan-005930',
            exchange: 'toss',
            symbol: '005930',
            market: 'KR',
            side: 'buy',
            accountMode: 'live',
            orderType: 'limit',
            reduceOnly: false,
            state: 'ACCEPTED',
            requestedQuantity: 10,
            remainingQuantity: 10,
            filledQuantity: 0,
            currentLimitPrice: 70_500,
            averageFillPrice: null,
            cancelable: true,
            lastErrorCode: null,
            updatedAt: new Date().toISOString(),
          }],
          orderSubmitted: false,
          orderCanceled: false,
          orderAmended: false,
          privateTradingRequestSent: false,
        }),
      });
      return;
    }
    if (url.pathname === '/api/trade-automation/orders/order-005930/cancel') {
      cancelPosts += 1;
      expect(request.method()).toBe('POST');
      expect(request.postDataJSON()).toEqual({ confirmed: true });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, order: { state: 'CANCEL_REQUESTED' } }),
      });
      return;
    }
    if (url.pathname === '/api/trade-automation/orders/order-005930/amend') {
      amendPosts += 1;
      expect(request.method()).toBe('POST');
      const body = request.postDataJSON() as { confirmed?: boolean; requestId?: string; price?: number; quantity?: number };
      expect(body.confirmed).toBe(true);
      expect(body.requestId).toBeTruthy();
      expect(body.price).toBe(70_400);
      expect(body.quantity).toBe(8);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, orderAmended: true }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(chartUrl);
  const panel = page.getByTestId('ai-chart-position-panel');
  await panel.getByTestId('ai-chart-load-position').click();
  await expect(panel).toContainText('현재 선택 종목의 보유/포지션 없음');
  const cockpit = panel.getByTestId('ai-chart-trading-cockpit');
  await cockpit.locator('summary').click();
  await cockpit.getByRole('tab', { name: '주문', exact: true }).click();
  await cockpit.getByTestId('ai-chart-load-orders').click();
  await expect.poll(() => dashboardReads).toBeGreaterThanOrEqual(1);

  page.once('dialog', async (dialog) => dialog.dismiss());
  await cockpit.getByRole('button', { name: '미체결 취소' }).click();
  await page.waitForTimeout(100);
  expect(cancelPosts).toBe(0);

  page.once('dialog', async (dialog) => dialog.accept());
  await cockpit.getByRole('button', { name: '미체결 취소' }).click();
  await expect.poll(() => cancelPosts).toBe(1);

  await cockpit.getByLabel('정정 가격').fill('70400');
  await cockpit.getByLabel('정정 수량').fill('8');

  page.once('dialog', async (dialog) => dialog.dismiss());
  await cockpit.getByRole('button', { name: '정정', exact: true }).click();
  await page.waitForTimeout(100);
  expect(amendPosts).toBe(0);

  page.once('dialog', async (dialog) => dialog.accept());
  await cockpit.getByRole('button', { name: '정정', exact: true }).click();
  await expect.poll(() => amendPosts).toBe(1);
  await expect(cockpit.getByTestId('ai-chart-order-management')).toContainText('정정 요청이 canonical 주문엔진에 반영되었습니다.');
});
