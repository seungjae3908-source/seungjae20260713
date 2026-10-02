import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('direct AI Chart prioritizes the route request without adding document-level route competition', () => {
  const html = fs
    .readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8')
    .replace(/\r\n?/g, '\n');
  const main = fs
    .readFileSync(path.resolve(process.cwd(), 'src/main.tsx'), 'utf8')
    .replace(/\r\n?/g, '\n');

  const appEntry = '<script type="module" src="/src/main.tsx"></script>';
  const appImport = "import('./App')";
  const routeImport = "import('@/pages/ai-chart')";

  expect(html.match(/<script\s+type="module"\s+src="\/src\/main\.tsx"><\/script>/g)).toHaveLength(1);
  expect(html).toContain(appEntry);
  expect(html).not.toMatch(/pages\/ai-chart/);
  expect(html).not.toMatch(/rel="modulepreload"[^>]+href="[^"]+\.tsx(?:\?|\")/);
  expect(main.match(/import\('\.\/App'\)/g)).toHaveLength(1);
  expect(main.match(/import\('@\/pages\/ai-chart'\)/g)).toHaveLength(1);
  expect(main.indexOf(routeImport)).toBeLessThan(main.indexOf(appImport));
  expect(main).toContain("querySelectorAll<HTMLLinkElement>('link[rel=\"modulepreload\"]')");
  expect(main).toContain("setAttribute('fetchpriority', 'high')");
  expect(main).toContain('function startApplicationGraph()');
  expect(main).toMatch(/if \(directAiChartColdRoute\) \{\s*window\.setTimeout\(startApplicationGraph, 0\);\s*\} else \{\s*startApplicationGraph\(\);\s*\}/);
});


test('direct desktop cold route defers non-critical evidence chunks until the critical chart renderer mounts', () => {
  const page = fs
    .readFileSync(path.resolve(process.cwd(), 'src/pages/ai-chart.tsx'), 'utf8')
    .replace(/\r\n?/g, '\n');

  expect(page).toContain("const DIRECT_AI_CHART_COLD_ROUTE = typeof window !== 'undefined' && window.location.pathname.endsWith('/ai-chart');");
  expect(page).toContain('const [criticalRendererMounted, setCriticalRendererMounted] = useState(() => !DIRECT_AI_CHART_COLD_ROUTE);');
  expect(page).toContain('setCriticalRendererMounted(true);');
  expect(page).toContain('onAnalysisChange={handleAnalysisChange}');
  expect(page).toMatch(/const deferNonCriticalEvidence = DIRECT_AI_CHART_COLD_ROUTE\s*&& desktop\s*&& !embedded\s*&& !externalMode\s*&& !criticalRendererMounted;/);
  expect(page).toContain('hasSelection && !deferNonCriticalEvidence');
  expect(page).toContain('data-testid="ai-chart-cold-evidence-deferred"');

  const detailsStart = page.indexOf('const details = hasSelection ?');
  const detailsEnd = page.indexOf('const mobile = !desktop', detailsStart);
  const details = page.slice(detailsStart, detailsEnd);
  const guard = details.indexOf('deferNonCriticalEvidence ?');
  const intelligence = details.indexOf('{intelligencePanel}', guard);
  const futures = details.indexOf('<LazyFuturesPublicContextPanel', guard);
  expect(guard).toBeGreaterThanOrEqual(0);
  expect(intelligence).toBeGreaterThan(guard);
  expect(futures).toBeGreaterThan(guard);
  expect(page).not.toContain('setTimeout(() => setCriticalRendererMounted');
});
