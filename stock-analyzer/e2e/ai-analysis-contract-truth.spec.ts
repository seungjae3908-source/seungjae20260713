import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parseStockAnalysisReply, isStockAnalysisCollectionRecent } from '../src/lib/stock-ai-analysis-reply';

const tabSource = readFileSync(new URL('../src/components/tabs/ai-tab.tsx', import.meta.url), 'utf8');
const target = { market: 'KR' as const, ticker: '005930', timeframe: '1D' as const };
const valid = () => ({
  ok: true, kind: 'answer', answer: '자료 기준 분석', model: 'verified-model',
  provider: 'google-gemini', fallbackUsed: false,
  selection: { market: 'KR', ticker: '005930', symbol: '005930', timeframe: '1D', action: null },
  data: { status: 'complete', basis: 'server_collection_time', asOf: new Date().toISOString(), sources: ['provider-backed'], missing: [] },
});

test('AI opinion rejects malformed success, foreign identity, unsafe provenance and missing source before rendering', () => {
  expect(() => parseStockAnalysisReply({ ...valid(), answer: ' ' }, target)).toThrow('AI_STOCK_ANALYSIS_RESPONSE_INVALID');
  expect(() => parseStockAnalysisReply({ ...valid(), selection: { ...valid().selection, ticker: 'AAPL' } }, target))
    .toThrow('AI_STOCK_ANALYSIS_IDENTITY_MISMATCH');
  expect(() => parseStockAnalysisReply({ ...valid(), data: { ...valid().data, sources: [] } }, target))
    .toThrow('AI_STOCK_ANALYSIS_EVIDENCE_INVALID');
  expect(() => parseStockAnalysisReply({ ...valid(), model: '' }, target))
    .toThrow('AI_STOCK_ANALYSIS_PROVIDER_UNVERIFIED');
  expect(() => parseStockAnalysisReply({ ...valid(), data: { ...valid().data, asOf: '2099-01-01T00:00:00.000Z' } }, target))
    .toThrow('AI_STOCK_ANALYSIS_EVIDENCE_INVALID');
  expect(isStockAnalysisCollectionRecent(null)).toBe(false);
  expect(tabSource).toContain('parseStockAnalysisReply(body, context)');
  expect(tabSource).toContain('if (controller.signal.aborted || generation.current !== owner) return;');
  expect(tabSource).toContain('onClick={() => void requestAnalysis()}');
  expect(tabSource).not.toContain("useAnalysis(ticker, active)");
});

test('partial and unavailable evidence never fabricate strategy prices, win rates or provider observations', () => {
  const partial = parseStockAnalysisReply({
    ...valid(),
    data: { ...valid().data, status: 'partial', sources: ['verified-daily-source'], missing: ['intraday-coverage'] },
  }, target);
  expect(partial.data.status).toBe('partial');
  expect(partial.data.missing).toEqual(['intraday-coverage']);
  expect(partial).not.toHaveProperty('strategy');
  expect(partial).not.toHaveProperty('targetPrice');
  expect(partial).not.toHaveProperty('stopLossPrice');
  expect(() => parseStockAnalysisReply({ ...valid(), data: { ...valid().data, status: 'partial', missing: [] } }, target))
    .toThrow('AI_STOCK_ANALYSIS_EVIDENCE_INVALID');
  expect(tabSource).toContain('적중 확률·목표가·손절가·주문 추천을 추정하거나 만들지 마세요.');
  expect(tabSource).not.toContain('formatPrice(data.targetPrice, currency)');
  expect(tabSource).not.toContain('formatPrice(data.stopLossPrice, currency)');
  expect(tabSource).not.toContain('/stocks/:ticker/analysis');
});
