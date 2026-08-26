import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const technicalSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/technical-workspace.tsx'),
  'utf8',
);
const recommendationsSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/recommendations.tsx'),
  'utf8',
);

test('mobile Technical workspace avoids the duplicated page title while preserving help access', () => {
  expect(technicalSource).toContain('className="hidden sm:block" data-testid="technical-desktop-header"');
  expect(technicalSource).toContain('data-testid="technical-mobile-help"');
  expect(technicalSource).toContain('aria-label="기술 기능 안내 보기"');
  expect(technicalSource).toContain("{ value: 'signal', label: 'AI 검색기' }");
  expect(technicalSource).toContain("testId={desktop ? 'technical-desktop-tabs' : 'technical-mobile-tabs'}");
});

test('Technical workspace does not double-reserve BottomNav height', () => {
  expect(technicalSource).toContain('flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background');
  expect(technicalSource).toContain('className="min-h-0 min-w-0 flex-1 overflow-hidden"');
  expect(technicalSource).not.toContain('pb-[calc(5rem+env(safe-area-inset-bottom))]');
  expect(technicalSource).toContain('<BottomNav />');
});

test('AI recommendations keeps short content flexible and anchors BottomNav after the viewport-filling body', () => {
  expect(recommendationsSource).toContain('data-testid="recommendations-shell"');
  expect(recommendationsSource).toContain('flex h-full min-h-0 flex-col overflow-hidden bg-background');
  expect(recommendationsSource).toContain('data-testid="recommendations-scroll-content"');
  expect(recommendationsSource).toContain('min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-4');
  expect(recommendationsSource).not.toContain('pb-28');
  expect(recommendationsSource).toContain('<BottomNav />');
});
