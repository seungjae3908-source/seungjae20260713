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
const detailAnalysisSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/components/stock-detail-analysis-panel.tsx'),
  'utf8',
);
const responsiveTabsSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/components/responsive-tabs.tsx'),
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

test('mobile standalone AI Chart keeps its overflow contract while bounding content above BottomNav', () => {
  expect(aiChartSource).toContain('h-full min-w-0 overflow-y-auto overscroll-contain bg-background');
  expect(aiChartSource).toContain('aria-label="AI 차트 생중계 · AI 차트 2.0"');
  expect(aiChartSource).toContain('{!embedded && !externalMode && <BottomNav />}');
  expect(touchCss).toContain('@media (max-width: 1023px)');
  expect(touchCss).toContain('#root div:has(> header h1[aria-label="AI 차트 생중계 · AI 차트 2.0"]):has(> nav[aria-label="주요 메뉴"])');
  expect(touchCss).toContain('overflow-y: auto !important;');
  expect(touchCss).toContain('> div:has([data-testid="ai-chart-mobile-tabs"])');
  expect(touchCss).toContain('> main {');
  expect(touchCss).toContain('flex: 1 1 0% !important;');
});

test('embedded stock AI Chart removes duplicate market and symbol selection but keeps a compact semantic heading', () => {
  expect(detailSource).toContain('data-testid="canonical-rich-detail-chart"');
  expect(detailSource).toContain('<AiChartPage embedded />');
  expect(aiChartSource).toContain('export default function AiChartPage({ embedded = false }');
  expect(unifiedChartSource).toContain('data-testid="unified-analysis-chart"');
  expect(unifiedChartSource).toContain('data-testid={`market-${item.key}`}');
  expect(unifiedChartSource).toContain('aria-label="차트 종목 심볼"');
  expect(touchCss).toContain('[data-testid="canonical-rich-detail-chart"] [data-testid="unified-analysis-chart"] > section:first-child');
  expect(touchCss).toContain('display: none !important;');
  expect(touchCss).toContain('[data-testid="canonical-rich-detail-chart"] > div > header:first-child h1');
  expect(touchCss).toContain('font-size: 0.875rem !important;');
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

test('상세분석 replaces the embedded legacy full page with focused AI financial and disclosure panels', () => {
  expect(detailSource).not.toContain('LegacyDetailPage');
  expect(detailSource).not.toContain("@/pages/detail-legacy");
  expect(detailSource).toContain('<StockDetailAnalysisPanel ticker={ticker} market={market} />');
  expect(detailAnalysisSource).toContain("{ value: 'ai', label: 'AI분석' }");
  expect(detailAnalysisSource).toContain("{ value: 'financials', label: '재무제표' }");
  expect(detailAnalysisSource).toContain("{ value: 'filings', label: '공시' }");
  expect(detailAnalysisSource).toContain('<AiTab ticker={ticker} currency={currency} active />');
  expect(detailAnalysisSource).toContain('<FinancialTab ticker={ticker} currency={currency} active />');
  expect(detailAnalysisSource).toContain('<DisclosureTab ticker={ticker} active />');
  expect(detailAnalysisSource).not.toContain('BottomNav');
  expect(detailAnalysisSource).not.toContain("label: '차트'");
  expect(detailAnalysisSource).not.toContain("label: '뉴스'");
});

test('all shared and semantic tab labels use one centered 12px 600 weight 16px line-height spec', () => {
  expect(responsiveTabsSource).toContain('inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl text-center text-xs font-semibold leading-4');
  expect(responsiveTabsSource).toContain('<span className="block w-full text-center leading-4">');
  expect(touchCss).toContain('#root [role="tablist"] [role="tab"]');
  expect(touchCss).toContain('#root [aria-label$="탭"] > button');
  expect(touchCss).toContain('#root [data-testid$="-tabs"] > button');
  expect(touchCss).toContain('min-height: 44px !important;');
  expect(touchCss).toContain('align-items: center !important;');
  expect(touchCss).toContain('justify-content: center !important;');
  expect(touchCss).toContain('font-size: 0.75rem !important;');
  expect(touchCss).toContain('line-height: 1rem !important;');
  expect(touchCss).toContain('font-weight: 600 !important;');
  expect(touchCss).toContain('text-align: center !important;');
});

test('compact copy policy removes attached helper prose but preserves runtime evidence and failures', () => {
  expect(touchCss).toContain('#root header :is(h1, h2, h3) + p[class*="text-muted-foreground"]');
  expect(touchCss).toContain('#root [role="tablist"] + p[class*="text-muted-foreground"]');
  expect(touchCss).toContain('#root button > p[class*="text-muted-foreground"]');
  expect(touchCss).toContain('#root button + p[class*="text-muted-foreground"]');
  for (const protectedSelector of ['[role="alert"] p', '[role="status"] p', 'article p', '[data-testid*="news"] p', '[data-testid*="disclosure"] p', '[data-testid*="evidence"] p']) {
    expect(touchCss).toContain(protectedSelector);
  }
  expect(touchCss).not.toContain('#root p {');
});

test('modern home search theme learn auto-trading and settings routes lose obsolete BottomNav tail spacers', () => {
  for (const title of ['홈', '통합검색', '테마', '투자 공부', '자동매매', '앱 설정']) {
    expect(touchCss).toContain(`data-route-title="${title}"`);
  }
  expect(touchCss).toContain('padding-bottom: 1rem !important;');
  expect(touchCss).toContain('data-route-title="AI 정보"');
  expect(touchCss).toContain('padding-bottom: 0 !important;');
});

test('paper trading gives its runtime panel the remaining flex height instead of stacking a fixed-nav spacer', () => {
  expect(paperTradingSource).toContain('data-testid="paper-trading-shell"');
  expect(paperTradingSource).toContain('<PaperTradingPanel');
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
