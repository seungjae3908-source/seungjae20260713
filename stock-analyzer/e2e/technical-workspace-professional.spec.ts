import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('technical workspace wrapper keeps one professional naming and typography contract', () => {
  const workspace = source('src/pages/technical-workspace.tsx');

  for (const label of ['AI 검색기', 'AI 차트', '백테스트', '자동매매']) {
    expect(workspace).toContain(`label: '${label}'`);
  }
  expect(workspace).not.toContain("label: '승인형 주문'");
  expect(workspace).not.toContain('text-[10px]');
  expect(workspace).not.toContain('text-[11px]');
  expect(workspace).not.toContain('font-black');
  expect(workspace).toContain("return '미확인';");
  expect(workspace).toContain('className="flex h-11 w-11');
});

test('technical workspace keeps analysis engines lazy and leaves signal/AI chart implementations untouched', () => {
  const workspace = source('src/pages/technical-workspace.tsx');
  expect(workspace).toContain("lazy(() => import('@/pages/signal-scanner'))");
  expect(workspace).toContain("lazy(() => import('@/pages/ai-chart'))");
  expect(workspace).toContain("lazy(() => import('@/pages/auto-trading'))");
  expect(workspace).toContain("lazy(() => import('@/components/backtest-research-panel')");
  expect(workspace).toContain('<SignalScannerPage embedded={desktop} />');
  expect(workspace).toContain('<AiChartPage embedded />');
});

test('technical help is concise and retains the live-trading safety boundary', () => {
  const workspace = source('src/pages/technical-workspace.tsx');
  expect(workspace).toContain('검색·차트·백테스트는 읽기·분석 중심 화면');
  expect(workspace).toContain('실거래는 활성화하지 않습니다.');
  expect(workspace).not.toContain('모바일은 AI 검색기·AI 차트·백테스트·자동매매를 각각 독립 화면으로 열어 긴 스크롤을 줄입니다.');
});
