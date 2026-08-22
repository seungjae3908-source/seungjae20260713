import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { dedupeNewsItems } from '../../api-server/src/services/news.service';
import { summarizeNewsSentiment, toneFromNewsText } from '../../api-server/src/services/news-sentiment';
import { newsEvidenceDisplay } from '../src/lib/news-evidence-display';

test('missing provider evidence stays explicitly missing instead of becoming invented confidence or analysis', () => {
  expect(newsEvidenceDisplay({})).toEqual({
    reliabilityScore: null,
    reliabilityLabel: null,
    summary: null,
    impact: null,
    provider: null,
    publishedAt: null,
    collectedAt: null,
    relevanceLabel: '관련성 근거 미제공',
    confidenceProvenance: 'NOT_PROVIDED',
    summaryProvenance: 'NOT_PROVIDED',
    impactProvenance: 'NOT_PROVIDED',
  });
});

test('provider-supplied evidence is shown only with explicit provenance', () => {
  expect(newsEvidenceDisplay({
    reliability: 88,
    summary: '  제공처가 전달한 요약입니다.  ',
    impact: '  단기 변동성 확대 가능성  ',
    provider: 'FINNHUB',
    publishedAt: '2026-08-21T10:00:00.000Z',
    collectedAt: '2026-08-21T10:01:00.000Z',
    relevanceProvenance: 'TICKER_SCOPED_PROVIDER',
    confidenceProvenance: 'PROVIDER_SUPPLIED',
    summaryProvenance: 'PROVIDER_SUPPLIED',
    impactProvenance: 'PROVIDER_SUPPLIED',
  })).toEqual({
    reliabilityScore: 88,
    reliabilityLabel: '높음',
    summary: '제공처가 전달한 요약입니다.',
    impact: '단기 변동성 확대 가능성',
    provider: 'FINNHUB',
    publishedAt: '2026-08-21T10:00:00.000Z',
    collectedAt: '2026-08-21T10:01:00.000Z',
    relevanceLabel: '관련성 근거: 종목 지정 공급자',
    confidenceProvenance: 'PROVIDER_SUPPLIED',
    summaryProvenance: 'PROVIDER_SUPPLIED',
    impactProvenance: 'PROVIDER_SUPPLIED',
  });
});

test('unproven confidence summary and impact fail closed even when values exist', () => {
  const display = newsEvidenceDisplay({
    reliability: 95,
    summary: 'unproven summary',
    impact: 'unproven impact',
  });
  expect(display.reliabilityScore).toBeNull();
  expect(display.summary).toBeNull();
  expect(display.impact).toBeNull();
});

test('invalid confidence values fail closed', () => {
  const provenance = { confidenceProvenance: 'PROVIDER_SUPPLIED' as const };
  expect(newsEvidenceDisplay({ ...provenance, reliability: Number.NaN }).reliabilityScore).toBeNull();
  expect(newsEvidenceDisplay({ ...provenance, reliability: -1 }).reliabilityScore).toBeNull();
  expect(newsEvidenceDisplay({ ...provenance, reliability: 101 }).reliabilityScore).toBeNull();
  expect(newsEvidenceDisplay({ ...provenance, reliability: '95' }).reliabilityScore).toBeNull();
});

test('news keyword classifier preserves missing and tied evidence as neutral', () => {
  expect(toneFromNewsText('Company announces annual meeting schedule', false)).toBe('neutral');
  expect(toneFromNewsText('record but weak outlook', false)).toBe('neutral');
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
    { ...base, title: 'positive', tone: 'positive' as const },
    { ...base, title: 'neutral-1', tone: 'neutral' as const },
    { ...base, title: 'neutral-2', tone: 'neutral' as const },
    { ...base, title: 'neutral-3', tone: 'neutral' as const },
  ]);

  expect(result.positive).toHaveLength(1);
  expect(result.negative).toHaveLength(0);
  expect(result.news?.filter((item) => item.tone === 'neutral')).toHaveLength(3);
  expect(result.sentimentScore).toBe(25);
});

test('deterministic dedupe removes exact article duplicates without claiming semantic event clustering', () => {
  const base = {
    source: 'Provider A',
    sourceDomain: 'example.com',
    date: '2026-08-21',
    url: '',
    tone: 'neutral' as const,
  };
  const result = dedupeNewsItems([
    { ...base, title: 'Company announces results' },
    { ...base, title: 'Company announces results!!!' },
    { ...base, title: 'Different follow-up story' },
  ]);
  expect(result).toHaveLength(2);
  expect(result.map((item) => item.title)).toContain('Different follow-up story');
});

test('news service preserves missing original links and records publication collection provider and relevance provenance', async () => {
  const cwd = process.cwd();
  const root = path.basename(cwd) === 'stock-analyzer' ? path.dirname(cwd) : cwd;
  const source = await readFile(path.join(root, 'api-server/src/services/news.service.ts'), 'utf8');

  expect(source).not.toContain(".filter((n) => n.url && n.url.startsWith('http'))");
  expect(source).not.toContain('const filtered = items.filter');
  expect(source).toContain('const url = safeHttpUrl');
  expect(source).toContain("date: publishedAt?.slice(0, 10) ?? ''");
  expect(source).toContain("provider: 'FINNHUB'");
  expect(source).toContain("provider: 'GOOGLE_NEWS'");
  expect(source).toContain("relevanceProvenance: 'TICKER_SCOPED_PROVIDER'");
  expect(source).toContain("relevanceProvenance: 'COMPANY_NAME_QUERY'");
  expect(source).toContain('collectedAt');
  expect(source).toContain("confidenceProvenance: 'NOT_PROVIDED'");
  expect(source).not.toContain('new Date().toISOString().slice(0, 10)');
});

test('news tab exposes provenance and contains no fallback AI or unverified investment-impact claim', async () => {
  const cwd = process.cwd();
  const root = path.basename(cwd) === 'stock-analyzer' ? cwd : path.join(cwd, 'stock-analyzer');
  const source = await readFile(path.join(root, 'src/components/tabs/news-tab.tsx'), 'utf8');

  expect(source).not.toContain('AI 요약:');
  expect(source).not.toContain('AI 분석');
  expect(source).not.toContain('AI 영향');
  expect(source).not.toContain('정확도 {accuracy}%');
  expect(source).not.toContain('출처 확인');
  expect(source).not.toContain('호재 뉴스');
  expect(source).not.toContain('악재 뉴스');
  expect(source).toContain('뉴스 키워드 감성 점수');
  expect(source).toContain('중립·분류 근거 부족 뉴스');
  expect(source).toContain('언론사:');
  expect(source).toContain('공급자:');
  expect(source).toContain('기사 발행:');
  expect(source).toContain('앱 수집:');
  expect(source).toContain('키워드 분류:');
  expect(source).toContain('신뢰도: 공급자 미제공');
  expect(source).toContain('원문 링크 미제공');
  expect(source).toContain('주가 영향: 공급자 근거 미제공');
  expect(source).toContain('회사명 검색 결과 · 미검증');
});
