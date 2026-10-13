import { createHash } from 'node:crypto';
import { MarketIntelligenceAiAnalyzer, type MarketIntelligenceAiAnalysisResult,
  type MarketIntelligencePublicEvidenceInput } from './market-intelligence-ai-analysis.service';
import type { ScannerSignalCard } from './scanner-signal.types';

const safety = Object.freeze({ publicEvidenceOnly: true, executionAuthority: 'NONE', orderAllowed: false,
  paperOrderAllowed: false, profitabilityPass: false, profitProbability: null, scoreImpact: 0, rankImpact: 0 });
type Entry = { memberId: string; signalId: string; evidenceKey: string; expiresAt: number;
  grade: ScannerSignalCard['signalGrade']; blocked: boolean; facts: string[]; input: MarketIntelligencePublicEvidenceInput };
type Analyzer = Pick<MarketIntelligenceAiAnalyzer, 'analyze'>;
export class ScannerAiReviewError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}
export class ScannerAiEvidenceReviewer {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly analyzer: Analyzer = new MarketIntelligenceAiAnalyzer({ timeoutMs: 6000, maxInFlight: 2, maxCacheEntries: 64 }),
    private readonly now: () => number = Date.now) {}

  // Called only AFTER the existing membership/grade filter. No model invocation here.
  capture<T extends { cards: readonly ScannerSignalCard[]; dataState?: string }>(memberId: string, response: T) {
    this.prune();
    const cards = response.cards.map(card => {
      // An advisory side-channel must not break the ordinary scan on a malformed
      // legacy card, nor invent facts to repair it. No review reference is issued.
      if (![card.signalId, card.symbol, card.currency, card.observedAt, card.expiresAt].every(v => typeof v === 'string')
        || ![card.dataSources, card.matched, card.unverified, card.warnings].every(v =>
          Array.isArray(v) && v.every(s => typeof s === 'string'))) return { ...card, aiReviewEvidenceKey: undefined };
      const market = card.assetClass === 'coin_spot' ? 'CRYPTO_SPOT' : card.assetClass === 'coin_futures' ? 'CRYPTO_FUTURES'
        : card.market === 'US' ? 'US_STOCK' : 'KR_STOCK';
      const text = (values: readonly string[]) => values.map(v => String(v).replace(/[\r\n]/g, ' ').slice(0, 100)).slice(0, 3).join('; ') || '미확인';
      const number = (n: unknown) => typeof n === 'number' && Number.isFinite(n) ? String(n) : '미확인';
      const facts = [
        `공개 스캐너 관측: ${card.symbol.slice(0, 40)}, ${market}, ${card.strategyMode ?? '미확인'}, ${card.direction}. 가격 ${number(card.price)} ${card.currency.slice(0, 10)}.`,
        `관측 시각 ${card.observedAt}; 만료 시각 ${card.expiresAt}. 공급원 ${text(card.dataSources)}.`,
        `후보 데이터 상태 ${card.dataState}, 품질 ${card.dataQuality?.state ?? '미확인'}; 검색 페이지 상태 ${response.dataState ?? '미확인'}. 정량 점수 ${number(card.score)}는 수익 확률이 아님.`,
        `기존 공개 근거: ${text(card.matched)}. 누락 근거: ${text(card.unverified)}.`,
        `위험/경고: ${text(card.warnings)}. 독립 검증 상태 ${card.backtestQuality?.status ?? 'missing'}; 이 검토는 OOS·수익성 증명이 아님.`,
      ].map(f => f.slice(0, 260));
      const blocked = card.dataState !== 'complete' || card.dataQuality?.state !== 'TRUSTED'
        || !Number.isFinite(card.price) || card.price <= 0 || !Number.isFinite(Date.parse(card.observedAt))
        || Date.parse(card.observedAt) > this.now() || !Number.isFinite(Date.parse(card.expiresAt))
        || Date.parse(card.expiresAt) <= this.now();
      const evidenceKey = createHash('sha256').update(JSON.stringify({ signalId: card.signalId, market, facts, blocked, grade: card.signalGrade })).digest('hex');
      const input: MarketIntelligencePublicEvidenceInput = { analysisKey: evidenceKey, aiMode: 'CHEAP_AI',
        evidenceStatus: 'READY', market, symbol: card.symbol, sourceType: 'SCANNER_PUBLIC_SNAPSHOT',
        sourceTier: 'DERIVED_PUBLIC_DATA', sourceName: '공개 스캐너 관측', sourceUrl: null,
        publishedAt: card.observedAt, eventType: 'PUBLIC_EVIDENCE_REVIEW',
        headline: '공개 후보 근거 검토. 수익 예측·주문 승인 아님.', evidenceFacts: facts };
      const key = this.key(memberId, card.signalId, evidenceKey);
      this.entries.delete(key);
      this.entries.set(key, { memberId, signalId: card.signalId, evidenceKey, grade: card.signalGrade, blocked,
        expiresAt: Math.min(this.now() + 5 * 60_000, Date.parse(card.expiresAt) || this.now()), facts, input });
      while (this.entries.size > 512) this.entries.delete(this.entries.keys().next().value!);
      return { ...card, aiReviewEvidenceKey: evidenceKey };
    });
    return { ...response, cards };
  }

  async review(memberId: string, signalId: string, evidenceKey: string, signal: AbortSignal,
    canReadGrade: (grade: Entry['grade']) => boolean = () => true) {
    this.prune();
    const entry = this.entries.get(this.key(memberId, signalId, evidenceKey));
    if (!entry || entry.expiresAt <= this.now()) throw new ScannerAiReviewError('AI_REVIEW_SOURCE_EXPIRED', 409);
    if (!canReadGrade(entry.grade)) throw new ScannerAiReviewError('SCANNER_GRADE_FORBIDDEN', 403);
    const base = { signalId, evidenceKey, safety, facts: [...entry.facts] };
    if (entry.blocked) return { ...base, status: 'BLOCKED_DATA' as const, reason: 'TRUSTED_CURRENT_EVIDENCE_REQUIRED', model: null, analysis: null };
    const result: MarketIntelligenceAiAnalysisResult = await this.analyzer.analyze(entry.input, signal);
    if (signal.aborted) throw signal.reason ?? new Error('AI_REVIEW_ABORTED');
    if (entry.expiresAt <= this.now()) throw new ScannerAiReviewError('AI_REVIEW_SOURCE_EXPIRED', 409);
    return { ...base, status: result.status === 'ANALYZED' ? 'REVIEWED' as const : 'UNAVAILABLE' as const,
      reason: result.reason, model: result.model, analysis: result.analysis };
  }
  private key(member: string, id: string, evidence: string) { return JSON.stringify([member, id, evidence]); }
  private prune() { for (const [key, entry] of this.entries) if (entry.expiresAt <= this.now()) this.entries.delete(key); }
}
export const scannerAiEvidenceReviewer = new ScannerAiEvidenceReviewer();
