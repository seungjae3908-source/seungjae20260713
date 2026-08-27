import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const touchCss = fs.readFileSync(
  path.resolve(process.cwd(), 'src/unified-analysis-chart-touch.css'),
  'utf8',
);
const detailSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/detail.tsx'),
  'utf8',
);
const aiChartSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/ai-chart.tsx'),
  'utf8',
);
const unifiedChartSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/components/unified-analysis-chart.tsx'),
  'utf8',
);
const bottomNavSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/components/bottom-nav.tsx'),
  'utf8',
);
const paperTradingSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/paper-trading.tsx'),
  'utf8',
);

test('shared BottomNav remains a normal-flow sibling and AppShell no longer double-reserves its height', () => {
  expect(bottomNavSource).toContain('relative z-40 w-full shrink-0');
  expect(touchCss).toContain('#root:has(nav[aria-label="주요 메뉴"]) > div > div:nth-child(2)[class*="max-w-screen"]');
  expect(touchCss).toContain('height: 100dvh !important;');
  expect(touchCss).toContain('min-height: 100svh !important;');
});

test('selected stock detail keeps one top-left back action with a 44px touch target', () => {
  expect(detailSource).toContain('aria-label="종목 목록으로 돌아가기"');
  expect(detailSource).toContain("const back = initial.params.get('back')?.trim() || '/stocks';");
  expect(detailSource).toContain('className="flex h-11 w-11 items-center justify-center');
  expect(touchCss).toContain('button[aria-label="종목 목록으로 돌아가기"]');
});

test('standalone AI Chart uses a bounded shell with fixed header tabs and BottomNav', () => {
  expect(aiChartSource).toContain('h-full min-w-0 overflow-y-auto overscroll-contain bg-background');
  expect(aiChartSource).toContain('aria-label="AI 차트 생중계 · AI 차트 2.0"');
  expect(aiChartSource).toContain('{!embedded && !externalMode && <BottomNav />}');
  expect(touchCss).toContain('#root div:has(> header h1[aria-label="AI 차트 생중계 · AI 차트 2.0"]):has(> nav[aria-label="주요 메뉴"])');
  expect(touchCss).toContain('flex-direction: column !important;');
  expect(touchCss).toContain('> div:has([data-testid="ai-chart-mobile-tabs"])');
  expect(touchCss).toContain('> main {');
  expect(touchCss).toContain('flex: 1 1 0% !important;');
  expect(touchCss).toContain('overflow-y: auto !important;');
});

test('embedded stock AI Chart hides duplicate market and symbol selection chrome', () => {
  expect(detailSource).toContain('data-testid="canonical-rich-detail-chart"');
  expect(detailSource).toContain('<AiChartPage embedded />');
  expect(aiChartSource).toContain('export default function AiChartPage({ embedded = false }');
  expect(unifiedChartSource).toContain('data-testid="unified-analysis-chart"');
  expect(unifiedChartSource).toContain('data-testid={`market-${item.key}`}');
  expect(unifiedChartSource).toContain('aria-label="차트 종목 심볼"');
  expect(touchCss).toContain('[data-testid="canonical-rich-detail-chart"] [data-testid="unified-analysis-chart"] > section:first-child');
  expect(touchCss).toContain('[data-testid="canonical-rich-detail-chart"] > div > header:first-child');
  expect(touchCss.match(/display: none !important;/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
});

test('stock detail chart has a single vertical scroll owner and normal tabs lose legacy bottom spacer', () => {
  expect(detailSource).toContain('flex-1 overflow-y-auto overscroll-contain px-3 pb-28 pt-4');
  expect(aiChartSource).toContain('h-full min-w-0 overflow-y-auto overscroll-contain bg-background');
  expect(touchCss).toContain('> main:has([data-testid="canonical-rich-detail-chart"])');
  expect(touchCss).toContain('overflow: hidden !important;');
  expect(touchCss).toContain('[data-testid="canonical-rich-detail-chart"] > div');
  expect(touchCss).toContain('padding-bottom: 1rem !important;');
});

test('stock detail news and summary tabs keep one vertical pan scroll owner', () => {
  expect(detailSource).toContain('data-testid="stock-detail-news"');
  expect(touchCss).toContain('> main:not(:has([data-testid="canonical-rich-detail-chart"]))');
  expect(touchCss).toContain('touch-action: pan-y;');
  expect(touchCss).toContain('-webkit-overflow-scrolling: touch;');
});

test('nested legacy 상세분석 cannot render a second BottomNav', () => {
  expect(detailSource).toContain('<LegacyDetailPage />');
  expect(detailSource).toContain('data-testid="rich-detail-shell"');
  expect(touchCss).toContain('[data-testid="rich-detail-shell"] nav[aria-label="주요 메뉴"]');
  expect(touchCss).toContain('display: none !important;');
});

test('modern home search theme learn order and settings routes lose obsolete BottomNav tail spacers', () => {
  for (const title of ['홈', '통합검색', '테마', '투자 공부', '승인형 주문', '앱 설정']) {
    expect(touchCss).toContain(`data-route-title="${title}"`);
  }
  expect(touchCss).toContain('padding-bottom: 1rem !important;');
  expect(touchCss).toContain('data-route-title="AI 정보"');
  expect(touchCss).toContain('padding-bottom: 0 !important;');
});

test('paper trading gives its panel the remaining flex height instead of stacking a fixed-nav spacer', () => {
  expect(paperTradingSource).toContain('data-testid="paper-trading-shell"');
  expect(paperTradingSource).toContain('data-testid="paper-trading-page"');
  expect(paperTradingSource).toContain('pb-[calc(5rem+env(safe-area-inset-bottom))]');
  expect(touchCss).toContain('[data-testid="paper-trading-shell"] {');
  expect(touchCss).toContain('[data-testid="paper-trading-shell"] > [data-testid="paper-trading-page"]');
  expect(touchCss).toContain('height: auto !important;');
  expect(touchCss).toContain('flex: 1 1 0% !important;');
});

test('canonical stock detail reuses the header action slot for the read-only orderbook opener', () => {
  expect(touchCss).toContain('#root > div:has([data-testid="canonical-stock-analysis"] [data-testid="stock-detail-tabs"])');
  expect(touchCss).toContain('> button[aria-label="읽기 전용 호가창 열기"]');
  expect(touchCss).toContain('top: 0.75rem !important;');
  expect(touchCss).toContain('bottom: auto !important;');
  expect(touchCss).toContain('width: 44px !important;');
  expect(touchCss).toContain('height: 44px !important;');
  expect(touchCss).toContain('font-size: 0 !important;');
});

test('mobile orderbook opener has a safe default immediately above BottomNav outside canonical stock detail', () => {
  expect(touchCss).toContain('button[aria-label="읽기 전용 호가창 열기"]');
  expect(touchCss).toContain('bottom: calc(4.25rem + env(safe-area-inset-bottom)) !important;');
});
