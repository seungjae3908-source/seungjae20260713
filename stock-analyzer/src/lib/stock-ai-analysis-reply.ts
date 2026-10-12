/**
 * Stock-detail AI explanation is backed by the existing authenticated AI Chat
 * provider. There is no /stocks/:ticker/analysis backend owner on current main.
 * Require exact identity, provider provenance and explicit data availability.
 */
export type StockAnalysisTarget = {
  market: 'KR' | 'US';
  ticker: string;
  timeframe: '1D';
};
export type StockAnalysisDisclosure = {
  status: 'complete' | 'partial' | 'unavailable';
  asOf: string | null;
  basis: 'server_collection_time';
  sources: string[];
  missing: string[];
};
export type StockAnalysisReply = {
  answer: string;
  model: string;
  provider: 'google-gemini' | 'groq' | 'openai-compatible';
  fallbackUsed: boolean;
  data: StockAnalysisDisclosure;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function validList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 40 && value.every(validText);
}
export function parseStockAnalysisReply(payload: unknown, target: StockAnalysisTarget): StockAnalysisReply {
  if (!isRecord(payload) || payload.ok !== true || payload.kind !== 'answer' || !validText(payload.answer)) {
    throw new Error('AI_STOCK_ANALYSIS_RESPONSE_INVALID');
  }
  const actual = payload.selection;
  if (!isRecord(actual) || actual.market !== target.market
    || actual.ticker !== target.ticker || actual.symbol !== target.ticker
    || actual.timeframe !== target.timeframe || actual.action != null) {
    throw new Error('AI_STOCK_ANALYSIS_IDENTITY_MISMATCH');
  }
  const data = payload.data;
  if (!isRecord(data) || !['complete', 'partial', 'unavailable'].includes(String(data.status))
    || data.basis !== 'server_collection_time'
    || !validList(data.sources) || !validList(data.missing)
    || (data.asOf !== null && (!validText(data.asOf) || !Number.isFinite(Date.parse(data.asOf))))) {
    throw new Error('AI_STOCK_ANALYSIS_EVIDENCE_INVALID');
  }
  if (data.status === 'complete' && data.missing.length > 0) throw new Error('AI_STOCK_ANALYSIS_EVIDENCE_INVALID');
  if (data.status !== 'unavailable' && data.sources.length === 0) throw new Error('AI_STOCK_ANALYSIS_EVIDENCE_INVALID');
  const provider = payload.provider;
  if (!['google-gemini', 'groq', 'openai-compatible'].includes(String(provider))
    || !validText(payload.model) || typeof payload.fallbackUsed !== 'boolean') {
    throw new Error('AI_STOCK_ANALYSIS_PROVIDER_UNVERIFIED');
  }
  return {
    answer: payload.answer.trim(),
    model: payload.model as string,
    provider: provider as StockAnalysisReply['provider'],
    fallbackUsed: payload.fallbackUsed,
    data: {
      status: data.status as StockAnalysisDisclosure['status'],
      asOf: data.asOf as string | null,
      basis: 'server_collection_time',
      sources: [...data.sources],
      missing: [...data.missing],
    },
  };
}
