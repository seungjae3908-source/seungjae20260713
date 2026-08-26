import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('AI information navigation only exposes working Korean surfaces and preserves the read-only chat endpoint', async () => {
  const source = await readFile(new URL('../src/pages/ai-chat.tsx', import.meta.url), 'utf8');

  expect(source).toContain("type HubTab = 'AI' | 'Portfolio';");
  expect(source).toContain("{ value: 'AI', label: 'AI 상담' }");
  expect(source).toContain("{ value: 'Portfolio', label: '포트폴리오' }");
  expect(source).toContain('aria-label="AI 정보 탭"');
  expect(source).toContain('min-h-11');
  expect(source).toContain("authorizedFetch('/api/ai/chat'");
  expect(source).toContain('읽기 전용 · 주문 권한 없음');
  expect(source).toContain('누락 데이터는 추정하지 않음');

  expect(source).not.toContain('PlaceholderPanel');
  expect(source).not.toContain('Information Hub');
  expect(source).not.toContain("'Overview'");
  expect(source).not.toContain("'Events'");
  expect(source).not.toContain("'Performance'");
  expect(source).not.toContain("'Journal'");
  expect(source).not.toContain('Gemini Free → Groq Free');
  expect(source).not.toContain('canonical typed facts');
});
