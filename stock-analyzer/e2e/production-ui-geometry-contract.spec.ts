import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('Production UI loads the fixed-navigation geometry guard', () => {
  const html = source('index.html');
  const css = source('public/production-ui-geometry.css');

  expect(html).toContain('<link rel="stylesheet" href="/production-ui-geometry.css" />');
  expect(css).toContain('--app-bottom-nav-reserve: calc(4rem + env(safe-area-inset-bottom));');
  expect(css).toContain('#root:has(nav[aria-label="주요 메뉴"]) > div > div:nth-child(2)[class*="max-w-screen"]');
  expect(css).toContain('height: calc(100dvh - var(--app-bottom-nav-reserve));');
});

test('AI Chart production controls keep at least 32px touch targets', () => {
  const css = source('public/production-ui-geometry.css');
  const chart = source('src/components/unified-analysis-chart.tsx');
  const intelligence = source('src/components/ai-chart-v2-intelligence-panel.tsx');

  expect(chart).toContain('aria-label="심볼 지우기"');
  expect(intelligence).toContain('data-testid="load-multi-timeframe"');
  expect(css).toContain('button[aria-label="심볼 지우기"]');
  expect(css).toContain('min-width: 2rem;');
  expect(css.match(/min-height: 2rem;/g) ?? []).toHaveLength(2);
  expect(css).toContain('button[data-testid="load-multi-timeframe"]');
});

test('mobile technical workspace and orderbook controls reserve navigation geometry', () => {
  const css = source('public/production-ui-geometry.css');
  const workspace = source('src/pages/technical-workspace.tsx');
  const orderbook = source('src/components/instrument-orderbook-dock.tsx');

  expect(workspace).toContain('data-testid="technical-workspace"');
  expect(css).toContain('[data-testid="technical-workspace"] > div:has(> [role="tabpanel"])');
  expect(css).toContain('flex-direction: column;');
  expect(orderbook).toContain('aria-label="읽기 전용 호가창 열기"');
  expect(css).toContain('button[aria-label="읽기 전용 호가창 열기"]');
  expect(css).toContain('+ 4.5rem');
});
