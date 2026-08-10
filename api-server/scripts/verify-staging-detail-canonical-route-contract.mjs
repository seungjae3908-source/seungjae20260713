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
  app.includes("function LegacyStockDetailRedirect()"),
  'legacy /stock/:ticker compatibility redirect must remain explicit',
);
assert(
  app.includes("target = resolveAssetDetailPath({ assetClass: 'KR_STOCK', market: 'KR', symbol: ticker, canonicalSymbol: ticker, backPath });"),
  'legacy KR stock detail entry must resolve through the shared canonical asset router',
);
assert(
  app.includes("if (target) navigate(target, { replace: true });"),
  'legacy stock detail entry must replace to the canonical destination',
);
assert(
  spec.includes("'/stock/005930',"),
  'staging must continue to enter the legacy bare stock detail fixture route',
);
assert(
  spec.includes("const requestedRoute = routeIdentity(route, page.url());"),
  'healthy-route validation must retain the requested route identity',
);
assert(
  spec.includes("const expectedRoute = requestedRoute === '/stock/005930'\n    ? '/stock-info?back=%2Fstocks&asset=stock&market=KR&ticker=005930'\n    : requestedRoute;"),
  'only the exact 005930 legacy fixture may expect the exact canonical /stock-info destination',
);
assert(
  spec.includes("message: 'stock detail fixture must reach its exact canonical stock-info route'"),
  'canonical route wait must remain explicit and exact',
);
assert(
  spec.includes('if (expectedRoute !== requestedRoute) {\n      await expect.poll('),
  'canonical waiting must run only when the exact expected route differs from the request',
);
assert(
  spec.includes(').toBe(expectedRoute);\n    }\n    await settle(page);'),
  'canonical destination must be confirmed before strict presentation settlement',
);
assert(
  spec.includes("expect(page.url(), 'route changed while presentation was settling').toBe(urlBeforeFrame);"),
  'strict post-canonical URL stability must not be weakened',
);
assert(
  spec.includes('expect(routeIdentity(page.url())).toBe(observation.toRoute);'),
  'healthy route must still finish on the exact expected destination',
);
assert(
  (spec.match(/requestedRoute === '\/stock\/005930'/g) ?? []).length === 1,
  'the canonical exception must remain singular and fixture-scoped',
);
assert(
  !spec.includes("?tab=overview")
    && !spec.includes("startsWith('/stock/')")
    && !spec.includes("pathname === '/stock'"),
  'legacy detail must not be accepted as canonical through tab or generic route allowances',
);

console.log('[staging-detail-canonical-route-contract] legacy bare-detail entry is required to reach the exact shared /stock-info canonical destination');
