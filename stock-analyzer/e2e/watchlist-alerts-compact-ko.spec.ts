import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('alerts keeps compact Korean-first filters and cards', () => {
  const alerts = source('src/pages/alerts.tsx');

  expect(alerts).toContain('data-testid="alert-source-tabs"');
  expect(alerts).toContain('data-testid="alert-market-filters"');
  expect(alerts).toContain('grid grid-cols-5 gap-1');
  expect(alerts).toContain('국내 <Count');
  expect(alerts).toContain('미국 <Count');
  expect(alerts).toContain('호재 <Count');
  expect(alerts).toContain('악재 <Count');
  expect(alerts).toContain('lg:grid-cols-2');
  expect(alerts).toContain('line-clamp-2');
  expect(alerts).toContain('신호 확인 중');
  expect(alerts).toContain('알림 확인 중');
  expect(alerts).not.toContain('AI 분석:');
  expect(alerts).not.toContain('★★★★★');
  expect(alerts).not.toContain('★★★★☆');
  expect(alerts).not.toContain('★★★☆☆');
  expect(alerts).not.toContain('전체 종목 신호');
});

test('watchlist preserves compact two-tab and collapsed alert editor behavior', () => {
  const watchlist = source('src/pages/watchlist.tsx');

  expect(watchlist).toContain('관심종목');
  expect(watchlist).toContain('지정가알림');
  expect(watchlist).toContain('const [editorOpen, setEditorOpen] = useState(false);');
  expect(watchlist).toContain('grid grid-cols-2 gap-2');
  expect(watchlist).toContain('rounded-2xl bg-secondary/70');
  expect(watchlist).not.toContain('overflow-x-auto');
});
