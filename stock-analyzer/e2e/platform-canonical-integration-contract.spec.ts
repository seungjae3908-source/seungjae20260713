import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

const scanner = source('src/pages/scanner.tsx');
const crypto = source('src/components/crypto-trading-workspace.tsx');
const autoTrading = source('src/pages/auto-trading.tsx');
const tradeAutomationRoute = source('../api-server/src/routes/trade-automation.ts');
const routeIndex = source('../api-server/src/routes/index.ts');
const backgroundWorker = source('../api-server/src/services/member-auto-trading-background-worker.service.ts');
const journalAdapter = source('../api-server/src/services/trade-automation-unified-journal-adapter.ts');
const journalPanel = source('src/components/unified-trade-journal-panel.tsx');

test('Scanner carries canonical signal identity into AI Chart and canonical trading workspace', () => {
  expect(scanner).toContain('signalId: String(card.signalId ?? "").trim() || undefined');
  expect(scanner).toContain('action,');
  expect(scanner).toContain('pricePlan: card.pricePlan');
  expect(scanner).toContain('requestId ?? ""');
  expect(scanner).toContain('/auto-trading?market=');
  expect(scanner).not.toContain('authorizedFetch("/api/stocks/auto-trade/status")');
  expect(scanner).not.toContain('authorizedFetch("/api/stocks/auto-trade/journal")');
});

test('legacy stock and futures auto mutation surfaces stay server-blocked while UI hands off to canonical trading', () => {
  expect(routeIndex).toContain("router.use('/crypto/futures/auto', privateExchangeDisabled)");
  expect(routeIndex).toContain("router.use('/stocks/auto-trade', privateExchangeDisabled)");
  expect(crypto).toContain('crypto-auto-status-retired');
  expect(crypto).toContain('/auto-trading?market=crypto_futures&section=dashboard');
  expect(crypto).toContain('crypto-canonical-auto-handoff');
  expect(crypto).toContain('aria-hidden="true"');
});

test('trade automation status exposes market-scoped recent orders and UI consumes the selected market only', () => {
  expect(tradeAutomationRoute).toContain('const lastOrderByMarket: Record<TradingAssetClass, TradingOrder | null>');
  expect(tradeAutomationRoute).toContain('repository.listPlans(userId)');
  expect(tradeAutomationRoute).toContain('lastOrderByMarket,');
  expect(autoTrading).toContain('runtimeStatus?.lastOrderByMarket?.[market]');
  expect(autoTrading).toContain('tradingRouteState()');
  expect(autoTrading).toContain("params.get('market')");
  expect(autoTrading).toContain("params.get('section')");
});

test('canonical integration remains fail-closed and does not add a second browser execution authority', () => {
  expect(scanner).not.toContain('@/lib/auto-trading');
  expect(scanner).not.toContain('executeAutoTradeCandidates');
  expect(scanner).not.toContain('monitorAutoTradePositions');
  expect(scanner).not.toContain('closeAutoTradePosition');
  expect(scanner).not.toContain('viewMode === "auto"');
  expect(crypto).toContain('enabled: false');
  expect(routeIndex).toContain('PRIVATE_EXCHANGE_API_DISABLED');
  expect(autoTrading).toContain('실거래 권한');
  expect(autoTrading).toContain('readyForAutomaticOrderEvaluation');
  expect(autoTrading).toContain('automaticServerGateEnabled');
  expect(autoTrading).toContain('계정 주문 권한 없음');
  expect(autoTrading).toContain('autoTradingBackground');
  expect(autoTrading).toContain('userTelegramDelivery');
  expect(autoTrading).toContain('liveEntriesArmed');
  expect(autoTrading).toContain('자동 실거래 작동 준비됨');
  expect(autoTrading).not.toContain('value="서버 Gate 필요"');
});


test('automatic execution events fan out to journal and Telegram outbox while preserving order authority isolation', () => {
  expect(backgroundWorker).toContain('syncExecutionEvents?');
  expect(backgroundWorker).toContain('TradeExecutionEventBridgeService');
  expect(backgroundWorker).toContain('CanonicalPortfolioSyncSink');
  expect(backgroundWorker).toContain('executionSyncFailures');
  expect(backgroundWorker).toContain('Notification/journal fan-out must never change canonical order state');
});

test('unified journal exposes canonical signal plan order fill lineage', () => {
  expect(journalAdapter).toContain('canonicalLineage');
  expect(journalAdapter).toContain('signalIds: plan.signalId ? [plan.signalId] : []');
  expect(journalAdapter).toContain('planIds: [plan.id]');
  expect(journalAdapter).toContain('orderIds: [order.id]');
  expect(journalAdapter).toContain('fillIds: fills.map');
  expect(journalPanel).toContain('unified-journal-canonical-lineage');
  expect(journalPanel).toContain('신호 → 분석 스냅샷 → 계획 → 주문 → 체결 → 매매일지 연결 ID입니다.');
  expect(journalPanel).toContain('label="snapshotId"');
  expect(journalPanel).toContain('label="journalId"');
});


test('operational observability exposes market activity, delivery health and pre-trade snapshot identity without adding authority', () => {
  expect(tradeAutomationRoute).toContain('marketActivityByMarket');
  expect(tradeAutomationRoute).toContain("const mayInspectLiveRuntime = Boolean(req.member && hasCapability(req.member, 'canPlaceOrders'))");
  expect(tradeAutomationRoute).toContain('autoTradingBackground: mayInspectLiveRuntime ? sanitizedAutomaticRuntimeHealth() : null');
  expect(tradeAutomationRoute).toContain('userTelegramDelivery: mayInspectLiveRuntime ? sanitizedTelegramDeliveryRuntimeHealth() : null');
  const sanitizedRuntimeHealth = tradeAutomationRoute.match(
    /function sanitizedAutomaticRuntimeHealth\(\) \{[\s\S]*?\n\}/,
  )?.[0] ?? '';
  expect(sanitizedRuntimeHealth).toContain('liveEntriesArmed: health.liveEntriesArmed');
  expect(sanitizedRuntimeHealth).not.toContain('liveTrackedPositions');
  expect(sanitizedRuntimeHealth).not.toContain('liveOrderEligibleMembers');
  expect(sanitizedRuntimeHealth).not.toContain('livePolicyReadyMembers');
  expect(sanitizedRuntimeHealth).not.toContain('privateTradingRequests');
  expect(autoTrading).toContain('data-testid="auto-trading-market-activity"');
  expect(autoTrading).toContain('미결 주문');
  expect(autoTrading).toContain('오늘 주문');
  expect(autoTrading).toContain('오늘 체결');
  expect(journalPanel).toContain('스냅샷 ID');
  expect(journalPanel).toContain('증거 기준시각');
});
