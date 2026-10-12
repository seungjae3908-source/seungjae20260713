import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { parseStockAnalysisReply, type StockAnalysisTarget } from '../src/lib/stock-ai-analysis-reply';

const target: StockAnalysisTarget = { market: 'US', ticker: 'AAPL', timeframe: '1D' };
const good = () => ({
  ok: true,
  kind: 'answer',
  answer: '실제 확인된 기업 정보와 뉴스만 설명합니다.',
  selection: { market: 'US', symbol: 'AAPL', ticker: 'AAPL', timeframe: '1D', action: null },
  provider: 'groq',
  model: 'sample-research-model',
  fallbackUsed: false,
  data: {
    status: 'partial', asOf: '2026-10-10T00:00:00.000Z', basis: 'server_collection_time',
    sources: ['공개 시세'], missing: ['선택 시간봉 1D OHLCV·기술지표'],
  },
});

test('accepts only exact same-market same-symbol real AI provider and explicit public-data limitations', () => {
  const result = parseStockAnalysisReply(good(), target);
  expect(result.provider).toBe('groq');
  expect(result.data.status).toBe('partial');
  expect(result.data.missing).toContain('선택 시간봉 1D OHLCV·기술지표');
});

test('rejects cross-market, cross-symbol, stale timeframes and execution-side echo contamination', () => {
  for (const bad of [
    { selection: { ...good().selection, ticker: 'MSFT' } },
    { selection: { ...good().selection, market: 'KR' } },
    { selection: { ...good().selection, symbol: 'TSLA' } },
    { selection: { ...good().selection, timeframe: '5m' } },
    { selection: { ...good().selection, action: 'BUY' } },
  ]) {
    expect(() => parseStockAnalysisReply({ ...good(), ...bad }, target)).toThrow('AI_STOCK_ANALYSIS_IDENTITY_MISMATCH');
  }
});

test('refusal and unverified or fabricated provider/evidence fail closed', () => {
  for (const bad of [
    { kind: 'refusal' },
    { ok: false },
    { answer: '' },
  ]) expect(() => parseStockAnalysisReply({ ...good(), ...bad }, target)).toThrow('AI_STOCK_ANALYSIS_RESPONSE_INVALID');
  for (const bad of [
    { provider: null }, { provider: 'unknown' }, { model: '' }, { fallbackUsed: 'false' },
  ]) expect(() => parseStockAnalysisReply({ ...good(), ...bad }, target)).toThrow('AI_STOCK_ANALYSIS_PROVIDER_UNVERIFIED');
  for (const bad of [
    { data: { ...good().data, status: 'complete' } },
    { data: { ...good().data, sources: [] } },
    { data: { ...good().data, asOf: 'bad-time' } },
  ]) expect(() => parseStockAnalysisReply({ ...good(), ...bad }, target)).toThrow('AI_STOCK_ANALYSIS_EVIDENCE_INVALID');
});

test('stock AI refuses missing, future or internally inconsistent collection evidence before displaying a provider answer', () => {
  const dayAhead = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const invalid = [
    { data: { ...good().data, asOf: null } },
    { data: { ...good().data, asOf: dayAhead } },
    { data: { ...good().data, status: 'partial', missing: [] } },
    { data: { ...good().data, status: 'complete', missing: [] } },
  ];
  for (const candidate of invalid) {
    // Full time-frame OHLCV is not supplied by this stock-detail endpoint.
    expect(() => parseStockAnalysisReply({ ...good(), ...candidate }, target))
      .toThrow('AI_STOCK_ANALYSIS_EVIDENCE_INVALID');
  }
  const unavailable = parseStockAnalysisReply({
    ...good(), data: { ...good().data, status: 'unavailable', asOf: null, sources: [], missing: ['공개자료 없음'] },
  }, target);
  expect(unavailable.data.status).toBe('unavailable');
});

test('stock AI front-end symbol limit matches the existing authenticated server context validator', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/components/tabs/ai-tab.tsx'), 'utf8');
  expect(source).toContain("/^[A-Z][A-Z0-9.-]{0,11}$/.test(symbol)");
  expect(source).toContain('analysisFailureText(cause)');
  expect(source).toContain('AI_STOCK_ANALYSIS_EVIDENCE_INVALID');
});


test('stock AI tab never requests the nonexistent legacy /analysis or /overview routes or executes orders', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/components/tabs/ai-tab.tsx'), 'utf8');
  expect(source).toContain("authorizedFetch('/api/ai/chat'");
  expect(source).toContain('parseStockAnalysisReply(body, context)');
  expect(source).toContain('data-testid="stock-ai-grounded-answer"');
  expect(source).toContain("result.data.status === 'unavailable'");
  expect(source).toContain("controllerRef.current?.abort()");
  expect(source).toContain("generation.current !== owner");
  expect(source).not.toContain('useAnalysis(');
  expect(source).not.toContain('/stocks/');
  expect(source).not.toContain('/trade-automation');
  expect(source).not.toContain('targetPrice:');
  expect(source).not.toContain('stopLossPrice:');
});
