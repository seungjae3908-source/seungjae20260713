import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.basename(process.cwd()) === 'api-server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());
const spec = await readFile(
  path.join(root, 'stock-analyzer/e2e/phase10-staging-readiness.spec.ts'),
  'utf8',
);
const navigation = await readFile(
  path.join(root, 'stock-analyzer/src/lib/asset-navigation.ts'),
  'utf8',
);
const app = await readFile(
  path.join(root, 'stock-analyzer/src/App.tsx'),
  'utf8',
);

const assert = (condition, message) => {
  if (!condition) throw new Error(`[staging-detail-canonical-route-contract] ${message}`);
};

assert(
  navigation.includes("return `/stock-info?${params.toString()}`;"),
  'canonical asset detail navigation must continue to resolve through /stock-info',
);
assert(
  navigation.includes("params.set('asset', 'stock');")
    && navigation.includes("params.set('market', 'KR');")
    && navigation.includes("params.set('ticker', ticker);"),
  'KR stock canonical detail navigation must preserve exact stock, market, and ticker identity',
);
assert(
  app.includes('function LegacyStockDetailRedirect()'),
  'legacy /stock/:ticker compatibility redirect must remain explicit',
);
assert(
  app.includes("target = resolveAssetDetailPath({ assetClass: 'KR_STOCK', market: 'KR', symbol: ticker, canonicalSymbol: ticker, backPath });")
    && app.includes("target = resolveAssetDetailPath({ assetClass: 'US_STOCK', market: 'US', symbol: ticker, canonicalSymbol: ticker, backPath });"),
  'legacy stock detail entry must preserve KR and US identity through the shared canonical asset router',
);
assert(
  app.includes('resolveLegacyCryptoDetailPath(symbol, backPath)'),
  'legacy crypto detail entry must continue through the shared canonical asset router',
);
assert(
  app.includes('navigate(target, { replace: true });'),
  'legacy detail entries must replace to the canonical destination',
);

for (const route of ['/stock/005930', '/stock/AAPL', '/crypto/KRW-BTC', '/crypto/BTCUSDT']) {
  assert(
    spec.includes(`'${route}',`),
    `staging traversal must include legacy asset route ${route}`,
  );
}

assert(
  spec.includes('function canonicalDetailExpectation(requestedRoute: string): CanonicalDetailExpectation | null'),
  'staging must define an independent browser expectation for canonical detail identity',
);
assert(
  spec.includes("return { asset: 'stock', market: 'KR', ticker: '005930', back: '/stocks' };")
    && spec.includes("return { asset: 'stock', market: 'US', ticker: 'AAPL', back: '/stocks' };")
    && spec.includes("return { asset: 'coin', coinMarket: 'spot', symbol: 'BTC', back: '/stocks' };")
    && spec.includes("return { asset: 'coin', coinMarket: 'futures', symbol: 'BTCUSDT', back: '/stocks' };"),
  'staging must independently encode KR, US, Upbit spot, and Bitget futures fixture identities',
);
assert(
  spec.includes('async function expectCanonicalDetailDestination(page: Page, expected: CanonicalDetailExpectation)'),
  'staging must validate the browser canonical destination through a dedicated semantic assertion',
);
assert(
  spec.includes("() => new URL(page.url()).pathname")
    && spec.includes(").toBe('/stock-info');"),
  'legacy detail navigation must wait for the canonical /stock-info pathname',
);
for (const parameter of ['asset', 'back', 'market', 'ticker', 'coinMarket', 'symbol']) {
  assert(
    spec.includes(`actual.searchParams.get('${parameter}')`),
    `canonical browser assertion must validate ${parameter} semantically`,
  );
}
assert(
  (spec.match(/await expectCanonicalDetailDestination\(page, canonicalDetail\);/g) ?? []).length >= 2,
  'canonical identity must be checked before and after strict presentation settlement',
);
assert(
  spec.includes("expect(page.url(), 'route changed while presentation was settling').toBe(urlBeforeFrame);"),
  'strict post-canonical URL stability must not be weakened',
);
assert(
  spec.includes('expect(routeIdentity(page.url())).toBe(observation.toRoute);'),
  'non-redirect healthy routes must retain exact route identity checks',
);
assert(
  !spec.includes('/stock-info?back=%2Fstocks&asset=stock&market=KR&ticker=005930')
    && !spec.includes('?tab=overview'),
  'staging must not depend on brittle query ordering or the obsolete legacy overview route',
);
assert(
  !spec.includes("test.describe.configure({ mode: 'serial' });"),
  'staging validations must remain independently executable after a sibling test fails',
);
assert(
  !spec.includes("startsWith('/stock/')")
    && !spec.includes("pathname === '/stock'"),
  'legacy detail must not be accepted as canonical through generic route allowances',
);

console.log('[staging-detail-canonical-route-contract] legacy KR/US/spot/futures entries require stable semantic /stock-info canonical identity');
