import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('search keeps StockInfo outside the static App bootstrap graph until coin mode needs it', () => {
  const appSource = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');
  const searchSource = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/search.tsx'), 'utf8');
  const wrapperSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/lazy-coin-info.tsx'),
    'utf8',
  );

  // SearchPage is still part of the App bootstrap graph, so it must not pull
  // the much larger stock-info page into that graph through a static import.
  expect(appSource).toContain("import SearchPage from '@/pages/search';");
  expect(searchSource).toContain('import { CoinInfo } from "@/components/lazy-coin-info";');
  expect(searchSource).not.toContain('@/pages/stock-info');

  // The wrapper is intentionally the only seam that may load stock-info, and
  // it must remain demand-loaded behind React.lazy + Suspense.
  expect(wrapperSource).toContain('const LazyCoinInfo = lazy(() =>');
  expect(wrapperSource).toContain(
    "import('@/pages/stock-info').then(({ CoinInfo }) => ({ default: CoinInfo }))",
  );
  expect(wrapperSource.match(/import\('@\/pages\/stock-info'\)/g) ?? []).toHaveLength(1);
  expect(wrapperSource).not.toMatch(/^import\s+.*@\/pages\/stock-info/m);
  expect(wrapperSource).toContain('<Suspense');
  expect(wrapperSource).toContain('role="status"');
  expect(wrapperSource).toContain('<LazyCoinInfo {...props} />');

  // Preserve the existing coin-mode render contract and route identity.
  expect(searchSource).toContain('asset === "coin" ? (');
  expect(searchSource).toContain('<CoinInfo nowMs={nowMs} basePath="/search" />');
});
