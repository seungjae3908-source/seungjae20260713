import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { newsEvidenceDisplay } from '../src/lib/news-evidence-display';

test('missing provider evidence stays explicitly missing instead of becoming invented confidence or analysis', () => {
  expect(newsEvidenceDisplay({})).toEqual({
    reliabilityScore: null,
    reliabilityLabel: null,
    summary: null,
    impact: null,
  });
});

test('provider-supplied evidence is preserved without deriving extra claims from source or tone', () => {
  expect(newsEvidenceDisplay({
    reliability: 88,
    summary: '  제공처가 전달한 요약입니다.  ',
    impact: '  단기 변동성 확대 가능성  ',
  })).toEqual({
    reliabilityScore: 88,
    reliabilityLabel: '높음',
    summary: '제공처가 전달한 요약입니다.',
    impact: '단기 변동성 확대 가능성',
  });
});

test('invalid confidence values fail closed', () => {
  expect(newsEvidenceDisplay({ reliability: Number.NaN }).reliabilityScore).toBeNull();
  expect(newsEvidenceDisplay({ reliability: -1 }).reliabilityScore).toBeNull();
  expect(newsEvidenceDisplay({ reliability: 101 }).reliabilityScore).toBeNull();
  expect(newsEvidenceDisplay({ reliability: '95' }).reliabilityScore).toBeNull();
});

test('news tab source contains no fallback AI summary or publisher-derived accuracy claim', async () => {
  const cwd = process.cwd();
  const root = path.basename(cwd) === 'stock-analyzer' ? cwd : path.join(cwd, 'stock-analyzer');
  const source = await readFile(path.join(root, 'src/components/tabs/news-tab.tsx'), 'utf8');

  expect(source).not.toContain('AI 요약:');
  expect(source).not.toContain('정확도 {accuracy}%');
  expect(source).not.toContain('출처 확인');
  expect(source).toContain('요약: 제공처 근거 없음');
  expect(source).toContain('신뢰도 미제공');
  expect(source).toContain('주가 영향 근거 미제공');
});
