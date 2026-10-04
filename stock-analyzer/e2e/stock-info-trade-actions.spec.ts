import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tradeChartPath, tradeFocusFromSearch } from '../src/lib/trade-navigation';

const stockInfoPath = fileURLToPath(new URL('../src/pages/stock-info.tsx', import.meta.url));
const aiChartPath = fileURLToPath(new URL('../src/pages/ai-chart.tsx', import.meta.url));
const positionPanelPath = fileURLToPath(new URL('../src/components/ai-chart-position-panel-impl.tsx', import.meta.url));

test('stock tab trade navigation preserves market policy and never invents spot or stock short entry', () => {
  const stockBuy = new URL(tradeChartPath({
    assetType: 'stock',
    market: 'KR',
    symbol: '005930',
    displayName: '삼성전자',
    action: 'BUY',
    focus: 'entry',
  }), 'https://app.invalid');
  expect(stockBuy.pathname).toBe('/ai-chart');
  expect(stockBuy.searchParams.get('trade')).toBe('entry');
  expect(stockBuy.searchParams.get('action')).toBe('BUY');
  expect(stockBuy.searchParams.get('source')).toBe('stock-info');
  expect(tradeFocusFromSearch(stockBuy.search)).toBe('entry');

  const stockSell = new URL(tradeChartPath({
    assetType: 'stock',
    market: 'US',
    symbol: 'AAPL',
    displayName: 'Apple',
    action: 'SELL',
    focus: 'exit',
  }), 'https://app.invalid');
  expect(stockSell.searchParams.get('trade')).toBe('exit');
  expect(stockSell.searchParams.get('action')).toBe('SELL');
  expect(tradeFocusFromSearch(stockSell.search)).toBe('exit');

  const spotSell = new URL(tradeChartPath({
    assetType: 'coin_spot',
    market: 'UPBIT',
    symbol: 'BTC',
    displayName: '비트코인',
    action: 'SELL',
    focus: 'exit',
  }), 'https://app.invalid');
  expect(spotSell.searchParams.get('trade')).toBe('exit');

  for (const action of ['LONG', 'SHORT'] as const) {
    const futures = new URL(tradeChartPath({
      assetType: 'coin_futures',
      market: 'BITGET',
      symbol: 'BTCUSDT',
      displayName: 'BTCUSDT',
      action,
      focus: 'entry',
      timeframe: '15m',
    }), 'https://app.invalid');
    expect(futures.searchParams.get('trade')).toBe('entry');
    expect(futures.searchParams.get('action')).toBe(action);
  }

  expect(() => tradeChartPath({
    assetType: 'stock',
    market: 'KR',
    symbol: '005930',
    displayName: '삼성전자',
    action: 'SELL',
    focus: 'entry',
  })).toThrow('TRADE_NAVIGATION_ENTRY_DIRECTION_INVALID');

  expect(() => tradeChartPath({
    assetType: 'coin_spot',
    market: 'UPBIT',
    symbol: 'BTC',
    displayName: '비트코인',
    action: 'SHORT',
    focus: 'entry',
  })).toThrow('TRADE_NAVIGATION_ENTRY_DIRECTION_INVALID');
});

test('stock and coin detail expose trade actions only through the canonical AI chart cockpit', async () => {
  const [stockInfo, aiChart, positionPanel] = await Promise.all([
    readFile(stockInfoPath, 'utf8'),
    readFile(aiChartPath, 'utf8'),
    readFile(positionPanelPath, 'utf8'),
  ]);

  expect(stockInfo).toContain('data-testid="stock-info-buy"');
  expect(stockInfo).toContain('data-testid="stock-info-sell"');
  expect(stockInfo).toContain('data-testid="coin-info-primary-trade-action"');
  expect(stockInfo).toContain('data-testid="coin-info-secondary-trade-action"');
  expect(stockInfo).toContain("focus: action === 'SELL' ? 'exit' : 'entry'");
  expect(stockInfo).toContain("focus: !futures && action === 'SELL' ? 'exit' : 'entry'");
  expect(stockInfo).not.toMatch(/\/api\/trade-automation\/(?:plans|orders)/);

  expect(aiChart).toContain("tradeFocusFromSearch(initialSearchRef.current)");
  expect(aiChart).toContain("tradeRouteRequested ? 'position' : 'summary'");
  expect(aiChart).toContain('initialCockpitOpen={tradeRouteRequested}');
  expect(aiChart).toContain("initialCockpitTab={tradeFocusRef.current ?? 'entry'}");

  expect(positionPanel).toContain('setCockpitOpen(initialCockpitOpen)');
  expect(positionPanel).toContain('setCockpitTab(initialCockpitTab)');
});
