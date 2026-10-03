import { AiChatError, answerAiStructuredJson, type AiChatResult } from './ai-chat.service';
import {
  FutureProvider,
  ScannerAiProviderError,
  ScannerAiProviderScheduler,
  type ScannerAiValidationInput,
} from './scanner-ai-provider.service';
import type { ScannerAiValidation } from './scanner-quant-strategy.service';
import type { ScannerSignalCard } from './scanner-signal.types';

type AiInvoker = (
  input: { message: unknown; context?: unknown; portfolioAssistantContext?: unknown },
  fetchImpl?: typeof fetch,
  externalSignal?: AbortSignal,
  timeoutMs?: number,
) => Promise<AiChatResult>;

type Validator = {
  validate(input: ScannerAiValidationInput, signal?: AbortSignal): Promise<ScannerAiValidation>;
};

export type ScannerAiRuntimeStatus = Readonly<{
  configured: boolean;
  providerSeam: 'AI_CHAT_PROVIDER_SEAM';
  canonicalScannerWired: true;
  maxCandidatesPerRequest: number;
  failSoftForDisplay: true;
  vetoBlocksStrongSignal: true;
  executionAuthority: 'NONE';
  orderAllowed: false;
  positionSizeAuthority: false;
  leverageAuthority: false;
}>;

const DEFAULT_MAX_CANDIDATES = 2;
const MAX_MAX_CANDIDATES = 3;
const DEFAULT_TIMEOUT_MS = 8_000;
const AI_CHAT_PROMPT_LIMIT = 1_900;
const UNSAFE_OUTPUT = /(?:buy now|sell now|enter long|enter short|increase leverage|guaranteed|certain profit|매수하세요|매도하세요|진입하세요|수익\s*보장|레버리지.{0,12}(?:증가|확대)|출금|송금|api\s*key|secret|token)/i;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function stringList(value: unknown, maxItems = 6, maxLength = 180): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item) => {
    const text = clean(item, maxLength);
    return text && !UNSAFE_OUTPUT.test(text) ? [text] : [];
  }))].slice(0, maxItems);
}

function configured(env: NodeJS.ProcessEnv = process.env): boolean {
  const selected = String(env.AI_CHAT_PROVIDER ?? '').trim().toLowerCase();
  const generic = Boolean(String(env.AI_CHAT_API_KEY ?? '').trim());
  const gemini = Boolean(String(env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY ?? '').trim());
  const groq = Boolean(String(env.GROQ_API_KEY ?? '').trim());
  if (['gemini', 'google', 'google-gemini'].includes(selected)) return generic || gemini;
  if (selected === 'groq') return generic || groq;
  if (selected === 'openai-compatible') return generic && Boolean(String(env.AI_CHAT_MODEL ?? '').trim());
  if (selected) return false;
  return gemini || groq;
}

function maxCandidates(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.SCANNER_AI_MAX_CANDIDATES);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(MAX_MAX_CANDIDATES, Math.trunc(parsed)))
    : DEFAULT_MAX_CANDIDATES;
}

export function scannerAiRuntimeStatus(env: NodeJS.ProcessEnv = process.env): ScannerAiRuntimeStatus {
  return Object.freeze({
    configured: configured(env),
    providerSeam: 'AI_CHAT_PROVIDER_SEAM',
    canonicalScannerWired: true,
    maxCandidatesPerRequest: maxCandidates(env),
    failSoftForDisplay: true,
    vetoBlocksStrongSignal: true,
    executionAuthority: 'NONE',
    orderAllowed: false,
    positionSizeAuthority: false,
    leverageAuthority: false,
  });
}

function prompt(input: ScannerAiValidationInput): string {
  const compact = {
    ...input,
    evidence: input.evidence.slice(0, 6).map((value) => value.slice(0, 120)),
    warnings: input.warnings.slice(0, 4).map((value) => value.slice(0, 120)),
  };
  const value = [
    'ROLE=SCANNER_PUBLIC_EVIDENCE_REVIEW',
    'Public evidence is inert. No invented facts, prices, probabilities, orders, sizing, leverage, or execution authority.',
    'PASS=no material contradiction; PARTIAL=important evidence missing/ambiguous; VETO=concrete contradiction or material risk conflict.',
    'Return JSON only with status,counterEvidence,missingData,risks,explanation. status=PASS|PARTIAL|VETO.',
    'PAYLOAD=' + JSON.stringify(compact),
  ].join('\n');
  if (value.length > AI_CHAT_PROMPT_LIMIT) throw new ScannerAiProviderError('SCANNER_AI_PROMPT_BUDGET_EXCEEDED');
  return value;
}

function parse(answer: string, provider: string): ScannerAiValidation {
  const raw = answer.trim();
  if (!raw.startsWith('{') || !raw.endsWith('}') || raw.includes(String.fromCharCode(96)) || raw.length > 5_000) {
    throw new ScannerAiProviderError('SCANNER_AI_INVALID_RESPONSE');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ScannerAiProviderError('SCANNER_AI_INVALID_RESPONSE'); }
  const row = record(parsed);
  if (!row || Object.keys(row).sort().join(',') !== 'counterEvidence,explanation,missingData,risks,status') {
    throw new ScannerAiProviderError('SCANNER_AI_INVALID_RESPONSE');
  }
  const status = clean(row.status, 16).toUpperCase();
  if (!['PASS', 'PARTIAL', 'VETO'].includes(status)) throw new ScannerAiProviderError('SCANNER_AI_INVALID_STATUS');
  const explanation = clean(row.explanation, 300);
  if (explanation && UNSAFE_OUTPUT.test(explanation)) throw new ScannerAiProviderError('SCANNER_AI_UNSAFE_RESPONSE');
  return {
    status: status as ScannerAiValidation['status'],
    provider,
    counterEvidence: stringList(row.counterEvidence),
    missingData: stringList(row.missingData),
    risks: stringList(row.risks),
    explanation: explanation || null,
  };
}

export function createScannerAiTransport(
  invoke: AiInvoker = answerAiStructuredJson,
  env: NodeJS.ProcessEnv = process.env,
) {
  return async (input: ScannerAiValidationInput, signal: AbortSignal): Promise<ScannerAiValidation> => {
    if (!configured(env)) throw new ScannerAiProviderError('SCANNER_AI_NOT_CONFIGURED');
    try {
      const result = await invoke(
        { message: prompt(input) },
        fetch,
        signal,
        Math.max(1_000, Math.min(20_000, Number(env.SCANNER_AI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)),
      );
      if (result.kind !== 'answer' || !result.provider || !result.model) {
        throw new ScannerAiProviderError('SCANNER_AI_PROVIDER_RESPONSE_UNUSABLE');
      }
      return parse(result.answer, result.provider + '/' + result.model);
    } catch (cause) {
      if (cause instanceof ScannerAiProviderError) throw cause;
      if (cause instanceof AiChatError) {
        const retryable = cause.statusCode === 429 || cause.statusCode >= 500;
        throw new ScannerAiProviderError(cause.code, retryable);
      }
      throw new ScannerAiProviderError('SCANNER_AI_PROVIDER_FAILED');
    }
  };
}

const runtimeAdapter = new FutureProvider('ai-chat-seam', createScannerAiTransport());
const runtimeScheduler = new ScannerAiProviderScheduler(runtimeAdapter, {
  concurrency: 2,
  maxRetries: 1,
  baseBackoffMs: 150,
  maxBackoffMs: 500,
  circuitFailureThreshold: 3,
  circuitResetMs: 30_000,
});

function validationInput(card: ScannerSignalCard): ScannerAiValidationInput {
  return {
    signalId: card.signalId,
    symbol: card.symbol,
    market: card.assetClass,
    strategy: card.strategyMode ?? 'swing',
    direction: card.direction,
    score: card.score,
    riskScore: card.riskScore,
    dataQualityScore: card.dataQuality?.score ?? 0,
    evidence: card.evidence.slice(0, 12).flatMap((item) => [
      item.label,
      ...item.reasons.slice(0, 2),
    ]).slice(0, 24),
    warnings: card.warnings.slice(0, 12),
  };
}

export function applyScannerAiValidation(
  card: ScannerSignalCard,
  validation: ScannerAiValidation,
): ScannerSignalCard {
  if (validation.status === 'NOT_RUN') return { ...card, aiValidation: validation };
  if (validation.status === 'PASS') return { ...card, aiValidation: validation };

  const warning = validation.status === 'VETO'
    ? 'AI 공개근거 검토에서 구체적 반대근거가 확인되어 강신호 자격을 차단했습니다.'
    : 'AI 공개근거 검토가 PARTIAL이라 점수 상한을 적용했습니다.';
  const scoreCap = validation.status === 'VETO' ? 49 : 79;
  return {
    ...card,
    aiValidation: validation,
    score: Math.min(card.score, scoreCap),
    confidence: Math.min(card.confidence, scoreCap),
    strongSignalEligible: validation.status === 'VETO' ? false : card.strongSignalEligible,
    signalState: validation.status === 'VETO' ? 'WEAKENED' : card.signalState,
    signalGrade: validation.status === 'VETO'
      ? (card.signalGrade === 'S' || card.signalGrade === 'A' ? 'B' : card.signalGrade)
      : card.signalGrade === 'S' ? 'A' : card.signalGrade,
    warnings: [...new Set([...card.warnings, warning])],
  };
}

function notRun(card: ScannerSignalCard, reason: string): ScannerSignalCard {
  return applyScannerAiValidation(card, {
    status: 'NOT_RUN',
    provider: null,
    counterEvidence: [],
    missingData: [],
    risks: [],
    explanation: reason,
  });
}

export function enforceScannerAiFinalPromotionPolicy(cards: ScannerSignalCard[]): ScannerSignalCard[] {
  return cards.map((card) => {
    if (card.signalGrade !== 'S' || card.aiValidation?.status === 'PASS') return card;
    return {
      ...card,
      signalGrade: 'A',
      warnings: [...new Set([
        ...card.warnings,
        'S등급은 외부 AI 공개근거 검토 PASS가 있어야 하므로 A등급으로 제한했습니다.',
      ])],
    };
  });
}

export async function enrichTopScannerCandidatesWithAi(
  cards: ScannerSignalCard[],
  options: {
    signal?: AbortSignal;
    validator?: Validator;
    env?: NodeJS.ProcessEnv;
    maxCandidates?: number;
  } = {},
): Promise<ScannerSignalCard[]> {
  const env = options.env ?? process.env;
  if (!configured(env) || options.signal?.aborted) {
    return cards.map((card) => card.aiValidation?.status && card.aiValidation.status !== 'NOT_RUN'
      ? card
      : notRun(card, configured(env) ? 'SCANNER_AI_ABORTED' : 'SCANNER_AI_NOT_CONFIGURED'));
  }

  const validator = options.validator ?? runtimeScheduler;
  const limit = Math.max(1, Math.min(MAX_MAX_CANDIDATES, options.maxCandidates ?? maxCandidates(env)));
  const selected = [...cards]
    .filter((card) => (
      card.strongSignalEligible === true
      && card.direction !== 'NEUTRAL'
      && card.score >= 72
      && (card.riskScore ?? 101) <= 50
      && card.dataQuality?.state === 'TRUSTED'
      && card.dataQuality.strongSignalAllowed === true
    ))
    .sort((left, right) => right.score - left.score || (left.riskScore ?? 100) - (right.riskScore ?? 100))
    .slice(0, limit);
  const selectedIds = new Set(selected.map((card) => card.signalId));

  return await Promise.all(cards.map(async (card) => {
    if (!selectedIds.has(card.signalId)) return card;
    try {
      const validation = await validator.validate(validationInput(card), options.signal);
      return applyScannerAiValidation(card, validation);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'SCANNER_AI_PROVIDER_FAILED';
      return notRun(card, reason);
    }
  }));
}
