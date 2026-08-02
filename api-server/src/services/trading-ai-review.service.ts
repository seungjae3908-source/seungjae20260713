import { createTradingReviewDataset, calculatePaperJournalAnalytics } from './paper-journal-analytics.service';
import {
  PaperJournalError,
  type AiProviderCallState,
  type TradingReviewDataset,
} from './paper-journal.types';
import {
  assertPrivacySafeDataset,
  type TradingReviewProvider,
  type TradingReviewProviderOutput,
} from './trading-review-provider';

export const AI_REVIEW_LIMITS = Object.freeze({
  maxPeriodDays: 90,
  maxRepresentativeTrades: 12,
  hourly: 3,
  daily: 10,
  concurrent: 1,
  timeoutMs: 30_000,
  idempotencyTtlMs: 10 * 60_000,
});

export const AI_REVIEW_RATE_LIMIT_SCOPE = 'process' as const;

type AttemptEntry = { at: number };
type IdempotencyEntry = {
  createdAt: number;
  state: 'in-flight' | 'succeeded';
  promise: Promise<TradingReviewProviderOutput>;
};

export type GenerateTradingAiReviewOutcome = {
  review: TradingReviewProviderOutput;
  providerCall: AiProviderCallState;
  rateLimitScope: typeof AI_REVIEW_RATE_LIMIT_SCOPE;
};

const attemptsByUser = new Map<string, AttemptEntry[]>();
const idempotencyByUser = new Map<string, Map<string, IdempotencyEntry>>();
const activeUsers = new Set<string>();

const preflightState = (): AiProviderCallState => ({ attempted: false, completed: false, reused: false });
const attemptedState = (): AiProviderCallState => ({ attempted: true, completed: false, reused: false });

export function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value == null || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function tradingAiReviewRuntimeConfig() {
  return {
    timeoutMs: parseBoundedInteger(process.env.TRADING_REVIEW_TIMEOUT_MS, AI_REVIEW_LIMITS.timeoutMs, 1_000, 30_000),
    dailyLimit: parseBoundedInteger(process.env.TRADING_REVIEW_DAILY_LIMIT, AI_REVIEW_LIMITS.daily, 1, 10),
  };
}

function cloneFailure(cause: unknown, providerCall: AiProviderCallState) {
  if (cause instanceof PaperJournalError) {
    return new PaperJournalError(cause.code, cause.message, cause.statusCode, providerCall);
  }
  return new PaperJournalError('AI_REVIEW_PROVIDER_ERROR', 'AI provider 처리에 실패했습니다.', 502, providerCall);
}

function preflightFailure(code: string, message: string, statusCode = 400) {
  return new PaperJournalError(code, message, statusCode, preflightState());
}

function cleanupExpired(now: number) {
  const dayAgo = now - 86_400_000;
  const idempotencyCutoff = now - AI_REVIEW_LIMITS.idempotencyTtlMs;
  for (const [userId, attempts] of attemptsByUser) {
    const retained = attempts.filter((entry) => entry.at >= dayAgo);
    if (retained.length) attemptsByUser.set(userId, retained);
    else attemptsByUser.delete(userId);
  }
  for (const [userId, entries] of idempotencyByUser) {
    for (const [key, entry] of entries) {
      if (entry.state === 'succeeded' && entry.createdAt < idempotencyCutoff) entries.delete(key);
    }
    if (!entries.size) idempotencyByUser.delete(userId);
  }
}

export function tradingAiReviewCacheStats() {
  return {
    attemptUsers: attemptsByUser.size,
    idempotencyUsers: idempotencyByUser.size,
    activeUsers: activeUsers.size,
  };
}

export function resetTradingAiReviewLimits() {
  attemptsByUser.clear();
  idempotencyByUser.clear();
  activeUsers.clear();
}

export function validatePeriod(start: unknown, end: unknown, now = new Date()) {
  const endDate = typeof end === 'string' && Number.isFinite(Date.parse(end)) ? new Date(end) : now;
  const startDate = typeof start === 'string' && Number.isFinite(Date.parse(start)) ? new Date(start) : new Date(endDate.getTime() - 30 * 86_400_000);
  if (startDate > endDate || endDate.getTime() - startDate.getTime() > AI_REVIEW_LIMITS.maxPeriodDays * 86_400_000) {
    throw new PaperJournalError('AI_REVIEW_PERIOD_INVALID', '분석 기간은 최대 90일입니다.');
  }
  return { periodStart: startDate.toISOString(), periodEnd: endDate.toISOString() };
}

export function buildAiReviewDataset(payloads: Record<string, unknown>[], start: unknown, end: unknown, now = new Date()) {
  const period = validatePeriod(start, end, now);
  const selected = payloads.filter((payload) => {
    const at = Date.parse(String(payload.closedAt ?? payload.filledAt ?? ''));
    return Number.isFinite(at) && at >= Date.parse(period.periodStart) && at <= Date.parse(period.periodEnd);
  });
  const dataset = createTradingReviewDataset(selected, calculatePaperJournalAnalytics(selected));
  assertPrivacySafeDataset(dataset);
  return dataset;
}

export function previewAiReview(dataset: TradingReviewDataset) {
  return {
    dataset,
    includedFields: ['periodStart', 'periodEnd', 'sampleSize', 'aggregateMetrics', 'behaviorSignals', 'strategyMetrics', 'symbolMetrics', 'timeMetrics', 'representativeTrades'],
    excludedFields: dataset.excludedFields,
    warnings: dataset.warnings,
  };
}

export async function generateTradingAiReview(input: {
  userId: string;
  idempotencyKey: string;
  consent: boolean;
  locale: string;
  reviewStyle: 'concise' | 'detailed';
  dataset: TradingReviewDataset;
  provider: TradingReviewProvider | null;
  now?: Date;
  signal?: AbortSignal;
}): Promise<GenerateTradingAiReviewOutcome> {
  if (input.consent !== true) throw preflightFailure('AI_REVIEW_CONSENT_REQUIRED', '외부 AI 전송 동의가 필요합니다.');
  if (!/^[a-zA-Z0-9:_-]{8,160}$/.test(input.idempotencyKey)) throw preflightFailure('AI_REVIEW_IDEMPOTENCY_INVALID', '유효한 idempotency key가 필요합니다.');
  if (!input.provider) throw preflightFailure('AI_REVIEW_PROVIDER_UNAVAILABLE', 'AI 거래 복기 기능을 현재 사용할 수 없습니다.', 503);
  try {
    assertPrivacySafeDataset(input.dataset);
  } catch (cause) {
    throw cloneFailure(cause, preflightState());
  }

  const now = (input.now ?? new Date()).getTime();
  cleanupExpired(now);
  const userEntries = idempotencyByUser.get(input.userId) ?? new Map<string, IdempotencyEntry>();
  if (!idempotencyByUser.has(input.userId)) idempotencyByUser.set(input.userId, userEntries);
  const duplicate = userEntries.get(input.idempotencyKey);
  if (duplicate) {
    try {
      const review = await duplicate.promise;
      return {
        review,
        providerCall: { attempted: false, completed: true, reused: true },
        rateLimitScope: AI_REVIEW_RATE_LIMIT_SCOPE,
      };
    } catch (cause) {
      throw cloneFailure(cause, { attempted: false, completed: false, reused: true });
    }
  }

  const config = tradingAiReviewRuntimeConfig();
  const dayAgo = now - 86_400_000;
  const hourAgo = now - 3_600_000;
  const attempts = (attemptsByUser.get(input.userId) ?? []).filter((entry) => entry.at >= dayAgo);
  if (attempts.length) attemptsByUser.set(input.userId, attempts);
  if (attempts.filter((entry) => entry.at >= hourAgo).length >= AI_REVIEW_LIMITS.hourly || attempts.length >= config.dailyLimit) {
    throw preflightFailure('AI_REVIEW_RATE_LIMITED', 'AI 호출 한도를 초과했습니다.', 429);
  }
  if (activeUsers.has(input.userId)) throw preflightFailure('AI_REVIEW_CONCURRENT_LIMIT', '이미 AI 복기를 생성 중입니다.', 429);

  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  attempts.push({ at: now });
  attemptsByUser.set(input.userId, attempts);
  activeUsers.add(input.userId);

  const promise = Promise.resolve().then(() => input.provider!.generateReview(
    { dataset: input.dataset, locale: input.locale, reviewStyle: input.reviewStyle },
    signal,
  )).catch((cause) => {
    if (signal.aborted && !(cause instanceof PaperJournalError)) {
      throw new PaperJournalError('AI_REVIEW_TIMEOUT', 'AI 거래 복기 요청 시간이 초과되었습니다.', 504);
    }
    throw cause;
  });
  const entry: IdempotencyEntry = { createdAt: now, state: 'in-flight', promise };
  userEntries.set(input.idempotencyKey, entry);

  try {
    const review = await promise;
    entry.state = 'succeeded';
    return {
      review,
      providerCall: { attempted: true, completed: true, reused: false },
      rateLimitScope: AI_REVIEW_RATE_LIMIT_SCOPE,
    };
  } catch (cause) {
    if (userEntries.get(input.idempotencyKey) === entry) userEntries.delete(input.idempotencyKey);
    throw cloneFailure(cause, attemptedState());
  } finally {
    activeUsers.delete(input.userId);
    if (!userEntries.size) idempotencyByUser.delete(input.userId);
    cleanupExpired(now);
  }
}
