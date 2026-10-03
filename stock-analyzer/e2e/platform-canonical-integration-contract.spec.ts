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
  expect(scanner).toContain('enabled: false');
  expect(crypto).toContain('enabled: false');
  expect(routeIndex).toContain('PRIVATE_EXCHANGE_API_DISABLED');
  expect(autoTrading).toContain('실거래 권한');
  expect(autoTrading).toContain('서버 Gate 필요');
});
