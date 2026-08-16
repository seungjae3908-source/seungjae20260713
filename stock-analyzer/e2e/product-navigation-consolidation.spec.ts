import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  APP_NAVIGATION,
  APP_ROUTES,
  NAVIGATION_FEATURE_DECISIONS,
  navigationMenuItemIsUserVisible,
} from '../src/lib/app-navigation';

test('user features have an explicit visibility decision and canonical menu entry', () => {
  const assets = APP_NAVIGATION.find((group) => group.id === 'assets');
  expect(assets).toBeTruthy();
  const visible = (assets?.menu ?? []).filter(navigationMenuItemIsUserVisible);
  const visibleHrefs = visible.map((item) => item.href);

  expect(NAVIGATION_FEATURE_DECISIONS).toEqual({
    'market-overview': 'KEEP_VISIBLE',
    'market-browser': 'INTERNAL_ONLY',
    alerts: 'KEEP_VISIBLE',
    recommendations: 'KEEP_VISIBLE',
  });
  expect(visibleHrefs).toContain(APP_ROUTES.marketOverview);
  expect(visibleHrefs).toContain(APP_ROUTES.alerts);
  expect(visibleHrefs).toContain(APP_ROUTES.recommendations);
  expect(visibleHrefs).not.toContain(APP_ROUTES.marketBrowser);
});

test('stock detail analysis stays on stock-info and mounts the existing rich detail page', async () => {
  const [app, stockInfo, detail] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/stock-info.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/detail.tsx', import.meta.url), 'utf8'),
  ]);

  expect(app).toContain("const DetailPage = lazy(() => import('@/pages/detail'));");
  expect(app).toContain("location.split('?')[0] === '/stock-info/analysis'");
  expect(app).toContain('<Route path="/stock-info/analysis" component={StockInfoAccess} />');
  expect(stockInfo).toContain('navigate(`/stock-info/analysis?${params.toString()}`);');
  expect(stockInfo).not.toContain('navigate(`/stock/${encodeURIComponent(ticker)}`)');
  expect(detail).toContain('data-testid="canonical-stock-analysis"');
  expect(detail).toContain("params.get('ticker')");
});

test('portfolio reuses the unified journal component as a primary tab', async () => {
  const portfolio = await readFile(new URL('../src/pages/portfolio.tsx', import.meta.url), 'utf8');
  expect(portfolio).toContain("import { UnifiedTradeJournalPanel } from '@/components/unified-trade-journal-panel';");
  expect(portfolio).toContain("portfolioSection === 'journal'");
  expect(portfolio).toContain('<UnifiedTradeJournalPanel />');
  expect(portfolio).toContain('data-testid="portfolio-journal"');
});
