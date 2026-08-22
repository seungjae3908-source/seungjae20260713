import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('market information uses Korean states and summary-first mobile sections', () => {
  const room = source('src/pages/market-information.tsx');

  expect(room).toContain("type MobileRoomTab = 'summary' | 'ranking' | 'news';");
  expect(room).toContain("{ key: 'summary', label: '요약' }");
  expect(room).toContain("{ key: 'ranking', label: '종목' }");
  expect(room).toContain("{ key: 'news', label: '소식' }");
  expect(room).toContain('data-testid="market-info-mobile-tabs"');
  expect(room).toContain('data-testid="market-info-summary"');
  expect(room).toContain('data-testid="market-info-ranking"');
  expect(room).toContain('data-testid="market-info-news"');
  expect(room).toContain("if (status === 'ready') return '정상';");
  expect(room).toContain("if (status === 'stale') return '오래됨';");
  expect(room).toContain('오래된 데이터');
  expect(room).toContain('시장정보 확인 중');
  expect(room).toContain('읽기 전용');
  expect(room).not.toContain('Retry-After 이후 다시 시도해 주세요.');
  expect(room).not.toContain('>stale<');
  expect(room).not.toContain('{section.status}');
  expect(room).not.toContain('Array.from({ length: 6 }');
  expect(room).not.toContain('canonical Unified Search');
  expect(room).not.toContain('private 요청 0');
});

test('market overview separates mobile tabs and desktop three-column dashboard', () => {
  const overview = source('src/pages/market-overview.tsx');

  expect(overview).toContain("type OverviewTab = 'indices' | 'sectors' | 'briefing';");
  expect(overview).toContain('data-testid="market-overview-mobile-tabs"');
  expect(overview).toContain('data-testid="market-overview-indices"');
  expect(overview).toContain('data-testid="market-overview-sectors"');
  expect(overview).toContain('data-testid="market-overview-briefing"');
  expect(overview).toContain('lg:grid-cols-3');
  expect(overview).toContain("mobileTab !== 'indices' && 'hidden lg:block'");
  expect(overview).toContain("mobileTab !== 'sectors' && 'hidden lg:block'");
  expect(overview).toContain("mobileTab !== 'briefing' && 'hidden lg:block'");
  expect(overview).toContain('지수 확인 중');
  expect(overview).toContain('섹터 확인 중');
  expect(overview).toContain('브리핑 확인 중');
  expect(overview).not.toContain('주요 지수와 섹터 흐름을 한눈에 확인합니다.');
});
