import { createTradingReviewDataset, calculatePaperJournalAnalytics } from './paper-journal-analytics.service';
import { PaperJournalError, type TradingReviewDataset } from './paper-journal.types';
import { assertPrivacySafeDataset, type TradingReviewProvider, type TradingReviewProviderOutput } from './trading-review-provider';

export const AI_REVIEW_LIMITS = Object.freeze({ maxPeriodDays: 90, maxRepresentativeTrades: 12, hourly: 3, daily: 10, concurrent: 1, timeoutMs: 30_000 });
type Entry = { at: number; key: string; promise: Promise<TradingReviewProviderOutput> };
const byUser = new Map<string, Entry[]>();
const activeUsers = new Set<string>();

export function resetTradingAiReviewLimits() { byUser.clear(); activeUsers.clear(); }
export function validatePeriod(start: unknown, end: unknown, now = new Date()) {
  const endDate = typeof end === 'string' && Number.isFinite(Date.parse(end)) ? new Date(end) : now;
  const startDate = typeof start === 'string' && Number.isFinite(Date.parse(start)) ? new Date(start) : new Date(endDate.getTime() - 30 * 86_400_000);
  if (startDate > endDate || endDate.getTime() - startDate.getTime() > AI_REVIEW_LIMITS.maxPeriodDays * 86_400_000) throw new PaperJournalError('AI_REVIEW_PERIOD_INVALID', '분석 기간은 최대 90일입니다.');
  return { periodStart: startDate.toISOString(), periodEnd: endDate.toISOString() };
}
export function buildAiReviewDataset(payloads: Record<string, unknown>[], start: unknown, end: unknown, now = new Date()) {
  const period = validatePeriod(start, end, now);
  const selected = payloads.filter((payload) => { const at = Date.parse(String(payload.closedAt ?? payload.filledAt ?? '')); return Number.isFinite(at) && at >= Date.parse(period.periodStart) && at <= Date.parse(period.periodEnd); });
  const dataset = createTradingReviewDataset(selected, calculatePaperJournalAnalytics(selected));
  assertPrivacySafeDataset(dataset); return dataset;
}
export function previewAiReview(dataset: TradingReviewDataset) {
  return { dataset, includedFields: ['periodStart','periodEnd','sampleSize','aggregateMetrics','behaviorSignals','strategyMetrics','symbolMetrics','timeMetrics','representativeTrades'], excludedFields: dataset.excludedFields, warnings: dataset.warnings };
}
export async function generateTradingAiReview(input: { userId: string; idempotencyKey: string; consent: boolean; locale: string; reviewStyle: 'concise'|'detailed'; dataset: TradingReviewDataset; provider: TradingReviewProvider | null; now?: Date; signal?: AbortSignal }) {
  if (input.consent !== true) throw new PaperJournalError('AI_REVIEW_CONSENT_REQUIRED', '외부 AI 전송 동의가 필요합니다.');
  if (!/^[a-zA-Z0-9:_-]{8,160}$/.test(input.idempotencyKey)) throw new PaperJournalError('AI_REVIEW_IDEMPOTENCY_INVALID', '유효한 idempotency key가 필요합니다.');
  if (!input.provider) throw new PaperJournalError('AI_REVIEW_PROVIDER_UNAVAILABLE', 'AI 거래 복기 기능을 현재 사용할 수 없습니다.', 503);
  assertPrivacySafeDataset(input.dataset);
  const now = (input.now ?? new Date()).getTime(); const dayAgo = now - 86_400_000; const hourAgo = now - 3_600_000;
  const entries = (byUser.get(input.userId) ?? []).filter((entry) => entry.at >= dayAgo); byUser.set(input.userId, entries);
  const duplicate = entries.find((entry) => entry.key === input.idempotencyKey); if (duplicate) return duplicate.promise;
  if (entries.filter((entry) => entry.at >= hourAgo).length >= AI_REVIEW_LIMITS.hourly || entries.length >= AI_REVIEW_LIMITS.daily) throw new PaperJournalError('AI_REVIEW_RATE_LIMITED', 'AI 호출 한도를 초과했습니다.', 429);
  if (activeUsers.has(input.userId)) throw new PaperJournalError('AI_REVIEW_CONCURRENT_LIMIT', '이미 AI 복기를 생성 중입니다.', 429);
  const timeout = AbortSignal.timeout(Math.min(AI_REVIEW_LIMITS.timeoutMs, Math.max(1000, Number(process.env.TRADING_REVIEW_TIMEOUT_MS) || AI_REVIEW_LIMITS.timeoutMs)));
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  activeUsers.add(input.userId);
  const promise = input.provider.generateReview({ dataset: input.dataset, locale: input.locale, reviewStyle: input.reviewStyle }, signal)
    .catch((cause) => { if (signal.aborted && !(cause instanceof PaperJournalError)) throw new PaperJournalError('AI_REVIEW_TIMEOUT', 'AI 거래 복기 요청 시간이 초과되었습니다.', 504); throw cause; })
    .finally(() => activeUsers.delete(input.userId));
  entries.push({ at: now, key: input.idempotencyKey, promise });
  return promise;
}
