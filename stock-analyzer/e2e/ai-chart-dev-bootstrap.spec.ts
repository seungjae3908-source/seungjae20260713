import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test } from '@playwright/test';

test('dev warmup is bounded to bootstrap, read-only chart and login modules, not API/data or trading workloads', () => {
  const config = fs.readFileSync(path.resolve(process.cwd(), 'vite.config.ts'), 'utf8');
  const warmup = config.match(/warmup:\s*\{\s*clientFiles:\s*\[([^\]]+)\]/);
  expect(warmup).not.toBeNull();
  const files = [...warmup![1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  expect(files).toEqual([
    './src/main.tsx', './src/App.tsx', './src/app-runtime.tsx',
    './src/pages/ai-chart.tsx', './src/components/unified-analysis-chart.tsx',
    './src/pages/account.tsx',
  ]);
  for (const file of files) expect(fs.existsSync(path.resolve(process.cwd(), file))).toBe(true);
  expect(config).not.toMatch(/hmr:\s*false/);
});

test('fixture handlers remain opt-in while library optimizer identity is stable between servers', () => {
  const config = fs.readFileSync(path.resolve(process.cwd(), 'vite.config.ts'), 'utf8');
  expect(config).toMatch(/cacheDir:\s*path\.resolve\(\s*import\.meta\.dirname, 'node_modules\/\.vite\/stock-analyzer\/phase9-fixtures'/);
  expect(config).toContain("if (process.env.VITE_PHASE9_E2E !== 'true') return;");
  expect(config).toContain('    phase9MarketIntelligenceUnavailableFixture(),');
  expect(config).not.toMatch(/VITE_PHASE9_E2E[^\n]+\? \[phase9MarketIntelligenceUnavailableFixture/);
});

test('explicit dev optimization covers every external runtime import without scanning generated HTML', () => {
  const config = fs.readFileSync(path.resolve(process.cwd(), 'vite.config.ts'), 'utf8');
  const optimization = config.match(/optimizeDeps:\s*\{([\s\S]*?)\n  \},/);
  expect(optimization).not.toBeNull();
  expect(optimization![1]).toContain("entries: ['index.html']");
  expect(optimization![1]).toContain('noDiscovery: true');
  expect(optimization![1]).toContain('holdUntilCrawlEnd: false');
  const includes = optimization![1].match(/include:\s*\[([^\]]+)\]/);
  expect(includes).not.toBeNull();
  const covered = new Set([...includes![1].matchAll(/'([^']+)'/g)].map(match => match[1]));
  const required = new Set<string>();
  function collect(specifier: string) {
    if (!specifier.startsWith('.') && !specifier.startsWith('@/') && !specifier.startsWith('@workspace/') && !specifier.startsWith('node:')) required.add(specifier);
  }
  function scan(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (/\.(?:tsx?|jsx?)$/.test(file) && !/\.(?:test|d)\.ts$/.test(file)) {
        const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        function visit(node: ts.Node) {
          if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly
            && !(node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && !node.importClause.name && node.importClause.namedBindings.elements.every(item => item.isTypeOnly))) collect(node.moduleSpecifier.text);
          if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) collect(node.moduleSpecifier.text);
          if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) collect(node.arguments[0].text);
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
  }
  scan(path.resolve(process.cwd(), 'src'));
  expect([...required].filter(specifier => !covered.has(specifier)).sort()).toEqual([]);
});

test('the import scheduler skips needless React transform while component refresh remains intact', async ({ request }) => {
  const config = fs.readFileSync(path.resolve(process.cwd(), 'vite.config.ts'), 'utf8');
  expect(config).toContain('react({ exclude: /[\\\\/]src[\\\\/]main\\.tsx(?:\\?.*)?$/ })');
  const entry = await request.get('/src/main.tsx');
  expect(entry.ok()).toBe(true);
  const entrySource = await entry.text();
  expect(entrySource).toContain('startApplicationGraph');
  expect(entrySource).not.toContain('$RefreshReg$');
  const component = await request.get('/src/App.tsx');
  expect(component.ok()).toBe(true);
  expect(await component.text()).toContain('$RefreshReg$');
});

test('initial null analysis does not start optional evidence before the critical chart paints', async ({ page }) => {
  let releaseData = () => {};
  const dataRelease = new Promise<void>(resolve => { releaseData = resolve; });
  let primaryRequested = false;
  const optionalRequests: string[] = [];
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (/\/src\/components\/(?:ai-chart-v2-intelligence-panel|futures-public-context-panel)\.tsx$/.test(pathname)) optionalRequests.push(pathname);
  });
  await page.route('**/api/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/stocks/005930/candles**', async route => {
    primaryRequested = true;
    await dataRelease;
    const end = Math.floor(Date.now() / 300_000) * 300 - 600;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ticker: '005930', timeframe: '5m', provider: 'TEST_ONLY_FIRST_PAINT',
      candles: Array.from({ length: 80 }, (_, index) => ({ time: end - (79 - index) * 300,
        open: 70000, high: 70100, low: 69900, close: 70000, volume: 1000, isClosed: true })),
    }) });
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  try {
    await page.goto('/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=Samsung&timeframe=5m');
    await expect.poll(() => primaryRequested).toBe(true);
    await expect(page.getByText('차트 불러오는 중', { exact: true })).toBeVisible();
    await expect(page.getByTestId('ai-chart-cold-evidence-deferred')).toBeVisible();
    expect(optionalRequests).toEqual([]);
    releaseData();
    await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
    await expect(page.getByTestId('ai-chart-cold-evidence-deferred')).toHaveCount(0);
    await expect.poll(() => optionalRequests.length).toBeGreaterThan(0);
  } finally { releaseData(); }
});

test('initial provider failure releases evidence after its real error state, not forever behind a loader', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/stocks/005930/candles**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'TEST_ONLY_UNAVAILABLE' }) }));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=Samsung&timeframe=5m');
  await expect(page.getByTestId('chart-error-state')).toBeVisible();
  await expect(page.getByTestId('ai-chart-cold-evidence-deferred')).toHaveCount(0);
  await expect(page.getByTestId('ai-chart-current-judgment')).toContainText('차트 데이터 확인 후 표시됩니다.');
});
