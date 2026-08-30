import { answerAiChat, type AiChatResult } from './ai-chat.service';

export type MarketIntelligenceAiMode = 'NO_AI' | 'CHEAP_AI' | 'DEEP_AI' | 'MULTI_EVIDENCE';
export type MarketIntelligenceEvidenceStatus = 'READY' | 'PARTIAL_EVIDENCE' | 'CONFLICTING_EVIDENCE' | 'NO_EVIDENCE' | 'INVALID_EVIDENCE';
export type MarketIntelligenceSentiment = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'MIXED' | 'UNKNOWN';
export type MarketIntelligenceImpactHorizon = 'INTRADAY' | 'SHORT' | 'SWING' | 'MID_LONG' | 'UNKNOWN';

export interface MarketIntelligencePublicEvidenceInput {
  analysisKey: string;
  aiMode: MarketIntelligenceAiMode;
  evidenceStatus: MarketIntelligenceEvidenceStatus;
  market: 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
  symbol: string | null;
  sourceType: string;
  sourceTier: string;
  sourceName: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
  eventType: string;
  headline: string | null;
  sourceText?: string | null;
  evidenceFacts: string[];
  conflictDetected?: boolean;
}

export interface MarketIntelligenceStructuredAnalysis {
  schemaVersion: 'MarketIntelAiAnalysisV1';
  summaryShort: string;
  sentiment: MarketIntelligenceSentiment;
  importanceScore: number;
  confidenceScore: number;
  impactHorizon: MarketIntelligenceImpactHorizon;
  factEvidenceRefs: number[];
  inferences: string[];
  uncertainty: string[];
  riskFlags: string[];
  catalystFlags: string[];
}

export type MarketIntelligenceAiAnalysisResult = {
  status: 'ANALYZED' | 'SKIPPED' | 'AI_ANALYSIS_UNAVAILABLE';
  analysisKey: string;
  model: string | null;
  analysis: MarketIntelligenceStructuredAnalysis | null;
  reason: string | null;
  cache: 'MISS' | 'IN_FLIGHT_REUSE' | 'HIT' | 'NOT_ELIGIBLE';
  safety: {
    publicEvidenceOnly: true;
    generatedFactsAllowed: false;
    sentimentIsPriceDirection: false;
    executionAuthority: 'NONE';
    orderAllowed: false;
  };
};

export type MarketIntelligenceAiAnalyzerStats = {
  providerCalls: number;
  cacheHits: number;
  inFlightHits: number;
  unavailable: number;
  cacheEntries: number;
  inFlight: number;
};

type AnswerAiChat = (
  input: { message: unknown; context?: unknown; portfolioAssistantContext?: unknown },
  fetchImpl?: typeof fetch,
  externalSignal?: AbortSignal,
  timeoutMs?: number,
) => Promise<AiChatResult>;

type CacheEntry = { expiresAt: number; value: MarketIntelligenceAiAnalysisResult };
type PreparedPrompt = { prompt: string; evidenceInput: MarketIntelligencePublicEvidenceInput };

export interface MarketIntelligenceAiAnalyzerOptions {
  answerAiChatImpl?: AnswerAiChat;
  now?: () => number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  timeoutMs?: number;
}

const secretPattern = /(?:bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{12,}|eyJ[a-z0-9_-]{12,}\.|authorization\s*:|(?:refresh[_ -]?token|access[_ -]?token|api[_ -]?key|private[_ -]?key|password|비밀번호호|계좌번호주민등로번호|실행키돼인픤몠얥\w**[:*폁)n\s*:]/i;
const tradeInstructionPattern = /(?:매수|매도|롱|숏|진입)|(?:매수|매도|롱|숏|진입).{0,24}(?:매수|매도|롱|숏|진입)|(?:buy|sell|long|short)\s+(?:now|immediately)\b)/i;
const generatedUrlPattern = /(?:https?:\/\/|www\.|javascript:|data:text\/html)/i;
const numericClaimPattern = /(?:[$₩€¥]\s*)?[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:e[-+]?\d+)?(?:\s*(?:조|억|만|천))?(?:\s*(?:usdt|usd|krw|bps|bp|%|원|달러))?/giu;
const analysisKeyPattern = /^[a-f0-9]{64}$/i;
const sentimentSet = new Set<MarketIntelligenceSentiment>(['POSITIVE', 'NEGATIVE', 'NEUTRAL', 'MIXED', 'UNKNOWN']);
const horizonSet = new Set<MarketIntelligenceImpactHorizon>(['INTRADAY', 'SHORT', 'SWING', 'MID_LONG', 'UNKNOWN"]);
const safety = Object.freeze({
  publicEvidenceOnly: true as const,
  generatedFactsAllowed: false as const,
  sentimentIsPriceDirection: false as const,
  executionAuthority: 'NONE' as const,
  orderAllowed: false as const,
});
const promptInstruction = '공개 Evidence만 사용한다. 새 사실/숫자를 만들지 말고 매수·매도·롱·숏 지시를 하지 않는다. factEvidenceRefs는 evidenceFacts의 0-based index만 쓴다. 반드시 JSON 1개만 반환: {"schemaVersion":"MarketIntelAiAnalysisV1","summaryShort":"","sentiment":"POSITIVE|NEGATIVE|NEUTRAL|MIXED|UNKNOWN","importanceScore":0,"confidenceScore":0,"impactHorizon":"INTRADAY|SHORT|SWING|MID_LONG|UNKNOWN","factEvidenceRefs":[],"inferences":[],"uncertainty":[],"riskFlags":[],"catalystFlags":[]}\nDATA=';
const promptLimit = 1_950;

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/<[^>]*>/g, ' ').replace(/[<>]/g, '').trim().slice(0, max)
    : '';
}

function uniqueText(values: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => cleanText(value, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function strictScore(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractJsonObject(answer: string): Record<string, unknown> | null {
  const normalized = answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = normalized.indexOf('{');
  const end = normalized.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(normalized.slice(start, end + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizedClaimToken(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s,]/g, '');
}

function generatedTextHasUnsupportedFactualClaim(
  analysis: MarketIntelligenceStructuredAnalysis,
  input: MarketIntelligencePublicEvidenceInput,
): boolean {
  const generatedText = [
    analysis.summaryShort,
    ...analysis.inferences,
    ...analysis.uncertainty,
    ...analysis.riskFlags,
    ...analysis.catalystFlags,
  ].join('\n');
  if (generatedUrlPattern.test(generatedText)) return true;

  const supportedClaims = new Set(analysis.factEvidenceRefs.flatMap((index) =>
    (input.evidenceFacts[index].match(numericClaimPattern) ?? []).map(normalizedClaimToken),
  ));
  const numericClaims = generatedText.match(numericClaimPattern) ?? [];
  return numericClaims.some((claim) => !supportedClaims.has(normalizedClaimToken(claim)));
}

function parseStructuredAnalysis(answer: string, input: MarketIntelligencePublicEvidenceInput): MarketIntelligenceStructuredAnalysis | null {
  if (secretPattern.test(answer) || tradeInstructionPattern.test(answer)) return null;
  const row = extractJsonObject(answer);
  if (!row || row.schemaVersion !== 'MarketIntelAiAnalysisV1') return null;
  const summaryShort = cleanText(row.summaryShort, 500);
  const sentiment = cleanText(row.sentiment, 20).toUpperCase() as MarketIntelligenceSentiment;
  const impactHorizon = cleanText(row.impactHorizon, 20).toUpperCase() as MarketIntelligenceImpactHorizon;
  const importanceScore = strictScore(row.importanceScore);
  const confidenceScore = strictScore(row.confidenceScore);
  if (!summaryShort || !sentimentSet.has(sentiment) || !horizonSet.has(impactHorizon) || importanceScore == null || confidenceScore == null) return null;
  if (!Array.isArray(row.factEvidenceRefs)) return null;
  const factEvidenceRefs = [...new Set(row.factEvidenceRefs)].filter((value): value is number => Number.isInteger(value));
  if (factEvidenceRefs.length !== row.factEvidenceRefs.length || factEvidenceRefs.some((value) => value < 0 || value >= input.evidenceFacts.length)) return null;
  const analysis: MarketIntelligenceStructuredAnalysis = {
    schemaVersion: 'MarketIntelAiAnalysisV1', summaryShort, sentiment, importanceScore, confidenceScore, impactHorizon, factEvidenceRefs,
    inferences: uniqueText(row.inferences, 8, 300),
    uncertainty: uniqueText(row.uncertainty, 8, 300),
    riskFlags: uniqueText(row.riskFlags, 12, 120),
    catalystFlags: uniqueText(row.catalystFlags, 12, 120),
  };
  return generatedTextHasUnsupportedFactualClaim(analysis, input) ? null : analysis;
}

function publicEvidence(input: MarketIntelligencePublicEvidenceInput): MarketIntelligencePublicEvidenceInput {
  return {
    analysisKey: cleanText(input.analysisKey, 80),
    aiMode: input.aiMode,
    evidenceStatus: input.evidenceStatus,
    market: input.market,
    symbol: cleanText(input.symbol, 80) || null,
    sourceType: cleanText(input.sourceType, 60) || 'UNKNOWN',
    sourceTier: cleanText(input.sourceTier, 60) || 'UNKNOWN',
    sourceName: cleanText(input.sourceName, 120) || null,
    sourceUrl: cleanText(input.sourceUrl, 500) || null,
    publishedAt: cleanText(input.publishedAt, 80) || null,
    eventType: cleanText(input.eventType, 80) || 'UNKNOWN',
    headline: cleanText(input.headline, 320) || null,
    sourceText: cleanText(input.sourceText, 600) || null,
    evidenceFacts: uniqueText(input.evidenceFacts, 5, 260),
    conflictDetected: input.conflictDetected === true,
  };
}

function promptPayload(input: MarketIntelligencePublicEvidenceInput) {
  return {
    task: 'market_intelligence_structured_public_evidence_analysis', mode: input.aiMode, market: input.market,
    symbol: input.symbol, sourceType: input.sourceType, sourceTier: input.sourceTier, sourceName: input.sourceName,
    publishedAt: input.publishedAt, eventType: input.eventType, headline: input.headline, evidenceFacts: input.evidenceFacts,
    conflictDetected: input.conflictDetected === true, sourceTextExcerpt: input.sourceText,
  };
}

function promptOf(input: MarketIntelligencePublicEvidenceInput): string {
  return `${promptInstruction}${JSON.stringify(promptPayload(input))}`;
}

function buildPrompt(input: MarketIntelligencePublicEvidenceInput): PreparedPrompt {
  const variants: MarketIntelligencePublicEvidenceInput[] = [
    input,
    {
      ...input,
      sourceText: null,
      headline: cleanText(input.headline, 240) || null,
      evidenceFacts: input.evidenceFacts.slice(0, 3).map((item) => cleanText(item, 180)).filter(Boolean),
    },
    {
      ...input,
      sourceText: null,
      sourceUrl: null,
      sourceName: cleanText(input.sourceName, 80) || null,
      headline: cleanText(input.headline, 140) || null,
      evidenceFacts: input.evidenceFacts.slice(0, 2).map((item) => cleanText(item, 120)).filter(Boolean),
    },
    {
      ...input,
      sourceText: null,
      sourceUrl: null,
      sourceName: null,
      publishedAt: null,
      headline: cleanText(input.headline, 80) || null,
      evidenceFacts: input.evidenceFacts.slice(0, 1).map((item) => cleanText(item, 100)).filter(Boolean),
    },
  ];
  for (const evidenceInput of variants) {
    const prompt = promptOf(evidenceInput);
    if (prompt.length <= promptLimit) return { prompt, evidenceInput };
  }
  const error = Object.assign(new Error('AI_PROMPT_BUDGET_EXCEEDED'), { code: 'AI_PROMPT_BUDGET_EXCEEDED' });
  throw error;
}

function assistantEvidenceContext(input: MarketIntelligencePublicEvidenceInput) {
  return {
    dataQuality: input.evidenceStatus === 'READY' ? 'AVAILABLE' : 'PARTIAL',
    asOf: input.publishedAt,
    evidence: {
      market: input.market,
      symbol: input.symbol,
      sourceType: input.sourceType,
      sourceTier: input.sourceTier,
      sourceName: input.sourceName,
      sourceUrl: input.sourceUrl,
      eventType: input.eventType,
    },
    warnings: input.conflictDetected ? ['CONFLICTING_EVIDENCE'] : [],
    facts: {
      headline: input.headline,
      sourceText: input.sourceText,
      evidenceFacts: input.evidenceFacts,
    },
    readOnly: true,
    orderAuthority: 'none',
    exchangeRequestSent: false,
  };
}

function unavailable(input: MarketIntelligencePublicEvidenceInput, reason: string, cache: MarketIntelligenceAiAnalysisResult['cache'] = 'NOT_ELIGIBLE'): MarketIntelligenceAiAnalysisResult {
  return { status: 'AI_ANALYSIS_UNAVAILABLE', analysisKey: input.analysisKey, model: null, analysis: null, reason, cache, safety };
}

function skipped(input: MarketIntelligencePublicEvidenceInput, reason: string): MarketIntelligenceAiAnalysisResult {
  return { status: 'SKIPPED', analysisKey: input.analysisKey, model: null, analysis: null, reason, cache: 'NOT_ELIGIBLE', safety };
}

function canAnalyze(input: MarketIntelligencePublicEvidenceInput): string | null {
  if (!analysisKeyPattern.test(input.analysisKey)) return 'ANALYSIS_KEY_INVALID';
  if (input.aiMode === 'NO_AI') return 'AI_ROUTE_NO_AI';
  if (input.evidenceStatus === 'NO_EVIDENCE' || input.evidenceStatus === 'INVALID_EVIDENCE') return 'AI_BLOCKED_BY_EVIDENCE_STATUS';
  if (!input.headline && !input.sourceText && input.evidenceFacts.length === 0) return 'PUBLIC_EVIDENCE_MISSING';
  if (secretPattern.test(JSON.stringify(input))) return 'PRIVATE_OR_SECRET_DATA_BLOCKED';
  return null;
}

export class MarketIntelligenceAiAnalyzer {
  private readonly completed = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<MarketIntelligenceAiAnalysisResult>>();
  private readonly answer: AnswerAiChat;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly timeoutMs: number;
  private providerCalls = 0;
  private cacheHits = 0;
  private inFlightHits = 0;
  private unavailableCount = 0;

  constructor(options: MarketIntelligenceAiAnalyzerOptions = {}) {
    this.answer = options.answerAiChatImpl ?? answerAiChat;
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = Math.max(1_000, Math.min(options.cacheTtlMs ?? 15 * 60_000, 24 * 60 * 60_000));
    this.maxCacheEntries = Math.max(1, Math.min(options.maxCacheEntries ?? 1_000, 10_000));
    this.timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 15_000, 60_000));
  }

  get stats(): Readonly<MarketIntelligenceAiAnalyzerStats> {
    this.pruneExpired();
    return Object.freeze({ providerCalls: this.providerCalls, cacheHits: this.cacheHits, inFlightHits: this.inFlightHits, unavailable: this.unavailableCount, cacheEntries: this.completed.size, inFlight: this.inFlight.size });
  }

  async analyze(rawInput: MarketIntelligencePublicEvidenceInput, signal?: AbortSignal): Promise<MarketIntelligenceAiAnalysisResult> {
    const input = publicEvidence(rawInput);
    const blocker = canAnalyze(input);
    if (blocker) return blocker === 'AI_ROUTE_NO_AI' || blocker === 'AI_BLOCKED_BY_EVIDENCE_STATUS' ? skipped(input, blocker) : unavailable(input, blocker);

    this.pruneExpired();
    const cached = this.completed.get(input.analysisKey);
    if (cached && cached.expiresAt > this.now()) {
      this.cacheHits += 1;
      return { ...cached.value, cache: 'HIT' };
    }

    const existing = this.inFlight.get(input.analysisKey);
    if (existing) {
      this.inFlightHits += 1;
      const value = await this.waitFor(existing, signal);
      return { ...value, cache: 'IN_FLIGHT_REUSE' };
    }

    const shared = this.perform(input)
      .then((value) => {
        if (value.status === 'ANALYZED') this.putCache(input.analysisKey, value);
        return value;
      })
      .finally(() => {
        if (this.inFlight.get(input.analysisKey) === shared) this.inFlight.delete(input.analysisKey);
      });
    this.inFlight.set(input.analysisKey, shared);
    return await this.waitFor(shared, signal);
  }

  private async perform(input: MarketIntelligencePublicEvidenceInput): Promise<MarketIntelligenceAiAnalysisResult> {
    this.providerCalls += 1;
    try {
      const prepared = buildPrompt(input);
      const result = await this.answer({
        message: prepared.prompt,
        portfolioAssistantContext: assistantEvidenceContext(prepared.evidenceInput),
      }, undefined, undefined, this.timeoutMs);
      const analysis = parseStructuredAnalysis(result.answer, prepared.evidenceInput);
      if (!analysis) {
        this.unavailableCount += 1;
        return unavailable(input, 'AI_STRUCTURED_RESPONSE_INVALID', 'MISS');
      }
      return { status: 'ANALYZED', analysisKey: input.analysisKey, model: result.model, analysis, reason: null, cache: 'MISS', safety };
    } catch (cause) {
      this.unavailableCount += 1;
      const code = cause && typeof cause === 'object' && 'code' in cause && typeof (cause as { code?: unknown }).code === 'string'
        ? (cause as { code: string }).code
        : 'AI_PROVIDER_UNAVAILABLE';
      return unavailable(input, code, 'MISS');
    }
  }

  private waitFor(promise: Promise<MarketIntelligenceAiAnalysisResult>, signal?: AbortSignal): Promise<MarketIntelligenceAiAnalysisResult> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('ABORTED'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error('ABORTED'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  private putCache(key: string, value: MarketIntelligenceAiAnalysisResult): void {
    while (this.completed.size >= this.maxCacheEntries) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (!oldest) break;
      this.completed.delete(oldest);
    }
    this.completed.set(key, { value, expiresAt: this.now() + this.cacheTtlMs });
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.completed) if (entry.expiresAt <= now) this.completed.delete(key);
  }
}

export const marketIntelligenceAiAnalyzer = new MarketIntelligenceAiAnalyzer();
