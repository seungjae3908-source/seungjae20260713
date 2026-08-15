import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

function analyzerRoot() {
  return path.basename(process.cwd()) === 'stock-analyzer'
    ? process.cwd()
    : path.resolve(process.cwd(), 'stock-analyzer');
}

function source(relativePath: string) {
  return fs.readFileSync(path.join(analyzerRoot(), relativePath), 'utf8');
}

test('종목 화면은 하나의 통합 검색창과 하나의 시장 선택 흐름만 유지한다', () => {
  const page = source('src/pages/unified-asset-search.tsx');
  expect(page.match(/<UnifiedAssetSearch\b/g) ?? []).toHaveLength(1);
  expect(page).not.toContain('ASSET_FILTERS');
  for (const label of ['국내', '미국', '코인 현물', '코인 선물']) {
    expect(page).toContain(`label: '${label}'`);
  }
  expect(page).toContain('data-testid="unified-search-single-input"');
});

test('기술 워크스페이스는 네 기능을 지연 로딩하고 모바일 종목 하단 메뉴를 유지한다', () => {
  const workspace = source('src/pages/technical-workspace.tsx');
  for (const label of ['AI 검색기', 'AI 차트', '백테스트', '자동매매']) {
    expect(workspace).toContain(`label: '${label}'`);
  }
  expect(workspace).toContain("lazy(() => import('@/pages/signal-scanner'))");
  expect(workspace).toContain("lazy(() => import('@/pages/ai-chart'))");
  expect(workspace).toContain("lazy(() => import('@/pages/auto-trading'))");
  expect(workspace).toContain('<BottomNav />');
});

test('코인 현물은 canonical Upbit spot 요청과 현물 상태 전환을 유지한다', () => {
  const scanner = source('src/pages/signal-scanner.tsx');
  const scannerUrl = source('src/lib/signal-scanner-url.ts');
  expect(scanner).toContain("view === 'SPOT'");
  expect(scannerUrl).toContain("const SPOT_SCANNER_PATH = '/api/scanner/crypto/spot'");
  expect(scannerUrl).toContain("request.assetClass === 'coin_spot'");
  expect(scanner).toContain("assetMode.setCoinMarket(view === 'FUTURES' ? 'futures' : 'spot')");
});

test('검색 상태는 콘텐츠를 덮지 않고 내부 지연시간을 사용자에게 노출하지 않는다', () => {
  const status = source('src/components/scanner-readiness-status.tsx');
  expect(status).not.toContain('absolute right-3 top-3');
  expect(status).not.toContain('Number(data?.elapsedMs');
  expect(status).toContain('부분 결과');
  expect(status).toContain('재시도');
});

test('종목 상세는 요약 우선 로딩과 canonical AI 차트 연결을 유지한다', () => {
  const detail = source('src/pages/detail.tsx');
  expect(detail).toContain("type DetailTab = 'summary' | 'chart' | 'news' | 'analysis'");
  expect(detail).toContain("lazy(() => import('@/pages/ai-chart'))");
  expect(detail).toContain("lazy(() => import('@/pages/detail-legacy'))");
  expect(detail).toContain("enabled: Boolean(ticker) && tab === 'summary'");
  expect(detail).toContain("enabled: Boolean(ticker) && tab === 'news'");
  expect(detail).toContain('data-testid="canonical-rich-detail-chart"');
});

test('백테스트와 자동매매는 기본 상태를 먼저 보이고 고급 설정을 접어 둔다', () => {
  const backtest = source('src/components/backtest-research-panel.tsx');
  const autoTrading = source('src/pages/auto-trading.tsx');
  expect(backtest).toContain('data-testid="backtest-advanced-settings"');
  expect(backtest).toContain('고급 설정');
  expect(autoTrading).toContain('data-testid="auto-trading-safety-summary"');
  expect(autoTrading).toContain('data-testid="auto-trading-advanced-settings"');
  expect(autoTrading).toContain('!embedded ? <BottomNav /> : null');
});
