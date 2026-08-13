import { expect, test } from '@playwright/test';
import {
  buildEvidenceAnalysis,
  buildPriceContext,
} from '../src/lib/evidence-analysis';

test('news provider summary is labeled without pretending full-article analysis', () => {
  const analysis = buildEvidenceAnalysis({
    quote: { changePercent: 4.2 },
    news: [{
      title: 'Example wins major supply contract',
      summary: 'The company signed a multi-year supply contract and expects revenue contribution from next quarter.',
      tone: 'positive',
    }],
    filings: [],
    candles: [],
  });

  expect(analysis.news[0]?.basis).toBe('provider-summary');
  expect(analysis.news[0]?.basisLabel).toContain('제공처 요약');
  expect(analysis.news[0]?.warning).toContain('기사 전체 원문이 아니라');
  expect(analysis.catalystSummary).toContain('인과관계는 확정하지 않습니다');
});

test('title-only evidence stays fail-closed about evidence quality', () => {
  const analysis = buildEvidenceAnalysis({
    news: [{ title: '회사 관련 새 소식' }],
    filings: [{ title: '주요사항보고서' }],
  });

  expect(analysis.news[0]?.basis).toBe('title-only');
  expect(analysis.filings[0]?.basis).toBe('title-only');
  expect(analysis.evidenceWarning).toContain('원문 전체 분석이 아닙니다');
});

test('dilution and listing-risk filings are treated as material negative evidence', () => {
  const analysis = buildEvidenceAnalysis({
    filings: [{
      title: '유상증자 결정 및 전환사채 발행',
      eventLabels: ['희석', '관리종목'],
      description: '신주 발행과 자본 조달 관련 공시 메타데이터입니다.',
    }],
  });

  expect(analysis.filings[0]?.tone).toBe('negative');
  expect(analysis.filings[0]?.materiality).toBe('high');
  expect(analysis.filings[0]?.tags).toContain('희석위험');
  expect(analysis.filings[0]?.tags).toContain('상장/거래위험');
});

test('price context combines trend, volume and breakout without external requests', () => {
  const candles = Array.from({ length: 25 }, (_, index) => ({
    close: 100 + index,
    high: 101 + index,
    low: 99 + index,
    volume: index === 24 ? 3000 : 1000,
  }));
  candles[24] = { close: 130, high: 131, low: 128, volume: 3000 };

  const context = buildPriceContext({ changePercent: 5 }, candles);

  expect(context.regime).toMatch(/uptrend/);
  expect(context.volumeRatio).toBeGreaterThan(2.5);
  expect(context.breakout).toBe('up');
  expect(context.momentum5).toBeGreaterThan(0);
});
