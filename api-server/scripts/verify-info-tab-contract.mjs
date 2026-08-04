import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const [app, info, detail, display, watchlist, routes] = await Promise.all([
  readFile(path.join(root, 'stock-analyzer/src/App.tsx'), 'utf8'),
  readFile(path.join(root, 'stock-analyzer/src/pages/stock-info.tsx'), 'utf8'),
  readFile(path.join(root, 'stock-analyzer/src/pages/detail.tsx'), 'utf8'),
  readFile(path.join(root, 'stock-analyzer/src/lib/stock-display.ts'), 'utf8'),
  readFile(path.join(root, 'stock-analyzer/src/pages/watchlist.tsx'), 'utf8'),
  readFile(path.join(root, 'api-server/src/routes/index.ts'), 'utf8'),
]);
assert(routes.includes('router.use(requireAuthenticated);'), 'API authentication gate missing');
assert(routes.includes("router.use(requireCapability('canAccessBasicInfo'));"), 'basic-information capability gate missing');
assert(app.includes("return gated('canAccessBasicInfo', <StockInfoPage />);"), 'information UI capability gate missing');
assert(app.includes("function PortfolioAccess() { return gated('canAccessPaperTrading'"), 'portfolio capability must remain higher');
assert(info.includes("['stock-info-quote', market, ticker]"), 'quote cache must be market-aware');
assert(info.includes("['stock-info-financials', market, ticker]"), 'financial cache must be market-aware');
assert(info.includes('freshnessLabel(quote.data.updatedAt'), 'freshness label missing');
assert(info.includes('시세 다시 불러오기'), 'retry UI missing');
assert(info.includes('INFO_VIEW_STATE_KEY'), 'search/filter/scroll state restoration missing');
assert(detail.includes('["stock-detail-v14", requestedMarket ?? "AUTO", ticker]'), 'detail cache must be market-aware');
assert(detail.includes('decoded.startsWith("/") && !decoded.startsWith("//")'), 'unsafe detail back target');
assert(display.includes('watchlistItemKey'), 'market-aware watchlist identity missing');
assert(watchlist.includes('key={watchlistItemKey(row)}'), 'cross-market render collision remains');
assert(!info.includes('/auto-trade/execute') && !detail.includes('/auto-trade/execute'), 'information flow must not execute orders');
console.log('[info-tab-contract] permissions, market isolation, retries, provenance, restoration and order separation passed');

const marketOverview = await readFile(path.join(root, 'stock-analyzer/src/pages/market-overview.tsx'), 'utf8');
assert(marketOverview.includes('Array.isArray(briefing.data.lines)'), 'market briefing must tolerate missing lines');
const automationSettings = await readFile(path.join(root, 'stock-analyzer/src/components/trade-automation-settings.tsx'), 'utf8');
assert(automationSettings.includes('normalizePolicy'), 'portfolio settings must normalize provider data');
