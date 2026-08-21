import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { summarizeNewsSentiment, toneFromNewsText } from '../../api-server/src/services/news-sentiment';
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

test('news keyword classifier preserves missing and tied evidence as neutral', () => {
  expect(toneFromNewsText('Company announces annual meeting schedule', false)).toBe('neutral');
  expect(toneFromNewsText('record growth but weak outlook', false)).toBe('neutral');
  expect(toneFromNewsText('호실적과 성장 기대', true)).toBe('positive');
  expect(toneFromNewsText('손실 우려와 약세', true)).toBe('negative');
});

test('neutral news remains visible and dilutes aggregate sentiment instead of being force-split', () => {
  const base = {
    source: 'provider',
    sourceDomain: 'example.com',
    date: '2026-08-21',
    url: 'https://example.com/news',
  };
  const result = summarizeNewsSentiment([
    { ...base, title: 'positive', tone: 'positive' },
    { ...base, title: 'neutral-1', tone: 'neutral' },
    { ...base, title: 'neutral-2', tone: 'neutral' },
    { ...base, title: 'neutral-3', tone: 'neutral' },
  ]);

  expect(result.positive).toHaveLength(1);
  expect(result.negative).toHaveLength(0);
  expect(result.news?.filter((item) => item.tone === 'neutral')).toHaveLength(3);
  expect(result.sentimentScore).toBe(25);
});

test('news tab source contains no fallback AI summary or publisher-derived accuracy claim', async () => {
  const cwd = process.cwd();
  const root = path.basename(cwd) === 'stock-analyzer' ? cwd : path.join(cwd, 'stock-analyzer');
  const source = await readFile(path.join(root, 'src/components/tabs/news-tab.tsx'), 'utf8');

  expect(source).not.toContain('AI 요약:');
  expect(source).not.toContain('정확도 {accuracy}%');
  expect(source).not.toContain('출처 확인');
  expect(source).not.toContain('호재 뉴스');
  expect(source).not.toContain('악재 뉴스');
  expect(source).toContain('뉴스 키워드 감성 점수');
  expect(source).toContain('중립·분류 근거 부족 뉴스');
  expect(source).toContain('요약: 제공처 근거 없음');
  expect(source).toContain('신뢰도 미제공');
  expect(source).toContain('주가 영향 근거 미제공');
});
