import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.basename(process.cwd()) === 'api-server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());
const spec = await readFile(
  path.join(root, 'stock-analyzer/e2e/phase10-staging-readiness.spec.ts'),
  'utf8',
);
const detail = await readFile(
  path.join(root, 'stock-analyzer/src/pages/detail.tsx'),
  'utf8',
);

const assert = (condition, message) => {
  if (!condition) throw new Error(`[staging-detail-canonical-route-contract] ${message}`);
};

assert(
  detail.includes('return TABS.some((item) => item.key === saved) ? saved! : "overview";'),
  'stock detail must keep overview as the unsaved default tab',
);
assert(
  detail.includes('url.searchParams.set("tab", tab);'),
  'stock detail must continue to persist its selected tab in the URL',
);
assert(
  spec.includes("'/stock/005930',"),
  'staging must continue to enter the bare stock detail fixture route',
);
assert(
  spec.includes("const requestedRoute = routeIdentity(route, page.url());"),
  'healthy-route validation must retain the requested route identity',
);
assert(
  spec.includes("const expectedRoute = requestedRoute === '/stock/005930'\n    ? '/stock/005930?tab=overview'\n    : requestedRoute;"),
  'only the exact 005930 bare detail fixture may expect the overview canonical route',
);
assert(
  spec.includes("message: 'stock detail fixture must reach its exact canonical overview route'"),
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
  !spec.includes('startsWith(\'/stock/\')') && !spec.includes('pathname === \'/stock\''),
  'generic stock-detail redirect allowances are forbidden',
);

console.log('[staging-detail-canonical-route-contract] exact bare-detail canonicalization is awaited before unchanged strict route settlement');
