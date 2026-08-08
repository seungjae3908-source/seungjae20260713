import { Router, type IRouter, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { calculatePaperJournalAnalytics, createTradingReviewDataset } from '../services/paper-journal-analytics.service';
import { createSupabasePaperJournalRepository } from '../services/paper-journal-supabase.repository';
import {
  deleteAllPaperJournalData,
  getPaperJournalSnapshot,
  resolvePaperJournalConflict,
  syncPaperJournal,
} from '../services/paper-journal-sync.service';
import {
  JOURNAL_ANALYSIS_MODE,
  PaperJournalError,
  type AiProviderCallState,
  type PaperJournalRepository,
} from '../services/paper-journal.types';
import { hasCapability } from '../../../packages/member-access/src/index.js';
import { buildAiReviewDataset, generateTradingAiReview, previewAiReview } from '../services/trading-ai-review.service';
import { configuredTradingReviewProvider, type TradingReviewProvider } from '../services/trading-review-provider';

const MAX_REQUEST_BYTES = 512 * 1024;

type PaperJournalDependencies = {
  repositoryFactory: (request: AuthenticatedRequest) => PaperJournalRepository;
  now: () => Date;
  reviewProvider: TradingReviewProvider | null;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requestSize(request: Request) {
  const declared = Number(request.header('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return declared;
  try {
    return Buffer.byteLength(JSON.stringify(request.body ?? null), 'utf8');
  } catch {
    return MAX_REQUEST_BYTES + 1;
  }
}

function syncEnvelope(payload: Record<string, unknown> = {}) {
  return {
    mode: 'journal-sync-only' as const,
    orderSubmitted: false as const,
    exchangeRequestSent: false as const,
    ...payload,
  };
}

function analysisEnvelope(payload: Record<string, unknown> = {}) {
  return {
    mode: JOURNAL_ANALYSIS_MODE,
    externalAiCalled: false as const,
    ...payload,
  };
}

function defaultRepositoryFactory(request: AuthenticatedRequest) {
  if (!request.member?.id || !request.accessToken) throw new PaperJournalError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);
  return createSupabasePaperJournalRepository(request.accessToken, request.member.id);
}

function filterPeriod(payloads: Record<string, unknown>[], start: unknown, end: unknown) {
  const startMs = typeof start === 'string' && Number.isFinite(Date.parse(start)) ? Date.parse(start) : null;
  const endMs = typeof end === 'string' && Number.isFinite(Date.parse(end)) ? Date.parse(end) : null;
  return payloads.filter((payload) => {
    const value = typeof payload.closedAt === 'string' ? payload.closedAt : payload.filledAt;
    const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(timestamp)) return false;
    return (startMs == null || timestamp >= startMs) && (endMs == null || timestamp <= endMs);
  });
}

export function createPaperJournalRouter(
  dependencies: Partial<PaperJournalDependencies> = {},
): IRouter {
  const router: IRouter = Router();
  const repositoryFactory = dependencies.repositoryFactory ?? defaultRepositoryFactory;
  const now = dependencies.now ?? (() => new Date());
  const reviewProvider = dependencies.reviewProvider === undefined ? configuredTradingReviewProvider() : dependencies.reviewProvider;

  const requireAiReview = (request: AuthenticatedRequest) => {
    if (!request.member || !hasCapability(request.member, 'canAccessAiTradingReview')) throw new PaperJournalError('CAPABILITY_REQUIRED', 'AI 거래 복기는 정회원과 관리자만 사용할 수 있습니다.', request.member ? 403 : 401);
    return request.member.id;
  };

  router.post('/paper-journal/sync', async (request: AuthenticatedRequest, response) => {
    if (requestSize(request) > MAX_REQUEST_BYTES) {
      return response.status(413).json(syncEnvelope({ ok: false, code: 'REQUEST_TOO_LARGE', message: '동기화 요청 크기가 제한을 초과했습니다.' }));
    }
    try {
      const result = await syncPaperJournal(repositoryFactory(request), request.member?.id ?? '', request.body, now());
      return response.json(result);
    } catch (cause) {
      return handleError(response, cause, 'JOURNAL_SYNC_FAILED', '거래일지를 동기화하지 못했습니다.', syncEnvelope);
    }
  });

  router.get('/paper-journal/snapshot', async (request: AuthenticatedRequest, response) => {
    try {
      const result = await getPaperJournalSnapshot(
        repositoryFactory(request),
        request.member?.id ?? '',
        request.query.cursor,
        request.query.limit,
        now(),
      );
      return response.json(result);
    } catch (cause) {
      return handleError(response, cause, 'JOURNAL_SNAPSHOT_FAILED', '거래일지 snapshot을 불러오지 못했습니다.', syncEnvelope);
    }
  });

  router.post('/paper-journal/conflicts/:id/resolve', async (request: AuthenticatedRequest, response) => {
    if (requestSize(request) > MAX_REQUEST_BYTES) {
      return response.status(413).json(syncEnvelope({ ok: false, code: 'REQUEST_TOO_LARGE', message: '충돌 해결 요청 크기가 제한을 초과했습니다.' }));
    }
    try {
      const choice = isObject(request.body) ? request.body.choice : null;
      const result = await resolvePaperJournalConflict(
        repositoryFactory(request),
        request.member?.id ?? '',
        request.params.id,
        choice,
        now(),
      );
      return response.json(result);
    } catch (cause) {
      return handleError(response, cause, 'CONFLICT_RESOLUTION_FAILED', '동기화 충돌을 해결하지 못했습니다.', syncEnvelope);
    }
  });

  router.delete('/paper-journal/all', async (request: AuthenticatedRequest, response) => {
    if (requestSize(request) > MAX_REQUEST_BYTES) {
      return response.status(413).json(syncEnvelope({ ok: false, code: 'REQUEST_TOO_LARGE', message: '삭제 요청 크기가 제한을 초과했습니다.' }));
    }
    try {
      const confirmation = isObject(request.body) ? request.body.confirmation : null;
      const result = await deleteAllPaperJournalData(repositoryFactory(request), request.member?.id ?? '', confirmation);
      return response.json(result);
    } catch (cause) {
      return handleError(response, cause, 'JOURNAL_DELETE_FAILED', '서버 거래일지를 삭제하지 못했습니다.', syncEnvelope);
    }
  });

  router.get('/paper-journal/analytics', async (request: AuthenticatedRequest, response) => {
    try {
      const payloads = filterPeriod(
        await repositoryFactory(request).listJournalPayloads(request.member?.id ?? ''),
        request.query.start,
        request.query.end,
      );
      return response.json(analysisEnvelope({ ok: true, result: calculatePaperJournalAnalytics(payloads) }));
    } catch (cause) {
      return handleError(response, cause, 'JOURNAL_ANALYTICS_FAILED', '거래 분석을 처리하지 못했습니다.', analysisEnvelope);
    }
  });

  router.post('/paper-journal/review-dataset', async (request: AuthenticatedRequest, response) => {
    if (requestSize(request) > MAX_REQUEST_BYTES) {
      return response.status(413).json(analysisEnvelope({ ok: false, code: 'REQUEST_TOO_LARGE', message: '복기 데이터 요청 크기가 제한을 초과했습니다.' }));
    }
    try {
      const body = isObject(request.body) ? request.body : {};
      if ('user_id' in body || 'userId' in body) throw new PaperJournalError('CLIENT_USER_ID_FORBIDDEN', '사용자 ID는 로그인 세션에서만 결정됩니다.');
      const payloads = filterPeriod(
        await repositoryFactory(request).listJournalPayloads(request.member?.id ?? ''),
        body.periodStart,
        body.periodEnd,
      );
      const analytics = calculatePaperJournalAnalytics(payloads);
      return response.json(analysisEnvelope({ ok: true, result: createTradingReviewDataset(payloads, analytics) }));
    } catch (cause) {
      return handleError(response, cause, 'REVIEW_DATASET_FAILED', '복기용 구조화 데이터를 만들지 못했습니다.', analysisEnvelope);
    }
  });

  router.post('/paper-journal/ai-review/preview', async (request: AuthenticatedRequest, response) => {
    const envelope = (payload: Record<string, unknown>) => ({ mode: 'ai-review-preview', externalAiCalled: false, providerCall: { attempted: false, completed: false, reused: false }, rateLimitScope: 'process', orderSubmitted: false, exchangeRequestSent: false, ...payload });
    if (requestSize(request) > MAX_REQUEST_BYTES) return response.status(413).json(envelope({ ok: false, error: { code: 'REQUEST_TOO_LARGE', message: '요청 크기가 제한을 초과했습니다.' } }));
    try {
      const userId = requireAiReview(request); const body = isObject(request.body) ? request.body : {};
      if ('user_id' in body || 'userId' in body) throw new PaperJournalError('CLIENT_USER_ID_FORBIDDEN', '사용자 ID는 로그인 세션에서만 결정됩니다.');
      const dataset = buildAiReviewDataset(await repositoryFactory(request).listJournalPayloads(userId), body.periodStart, body.periodEnd, now());
      return response.json(envelope({ ok: true, result: previewAiReview(dataset) }));
    } catch (cause) { return handleAiError(response, cause, envelope); }
  });

  router.post('/paper-journal/ai-review/generate', async (request: AuthenticatedRequest, response) => {
    const envelope = (payload: Record<string, unknown>) => ({ mode: 'ai-review-only', externalAiCalled: false, providerCall: { attempted: false, completed: false, reused: false }, rateLimitScope: 'process', orderSubmitted: false, exchangeRequestSent: false, ...payload });
    if (requestSize(request) > MAX_REQUEST_BYTES) return response.status(413).json(envelope({ ok: false, error: { code: 'REQUEST_TOO_LARGE', message: '요청 크기가 제한을 초과했습니다.' } }));
    try {
      const userId = requireAiReview(request); const body = isObject(request.body) ? request.body : {};
      if ('user_id' in body || 'userId' in body || 'dataset' in body) throw new PaperJournalError('CLIENT_DATASET_FORBIDDEN', '분석 데이터는 서버에서 생성합니다.');
      const dataset = buildAiReviewDataset(await repositoryFactory(request).listJournalPayloads(userId), body.periodStart, body.periodEnd, now());
      const outcome = await generateTradingAiReview({ userId, consent: body.consent === true, idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '', locale: typeof body.locale === 'string' ? body.locale.slice(0, 12) : 'ko-KR', reviewStyle: body.reviewStyle === 'detailed' ? 'detailed' : 'concise', dataset, provider: reviewProvider, now: now() });
      return response.json({ ...envelope({ ok: true, result: outcome.review }), externalAiCalled: outcome.providerCall.attempted, providerCall: outcome.providerCall, rateLimitScope: outcome.rateLimitScope });
    } catch (cause) { return handleAiError(response, cause, envelope); }
  });

  return router;
}

function handleAiError(response: Response, cause: unknown, envelope: (payload: Record<string, unknown>) => Record<string, unknown>) {
  const error = cause instanceof PaperJournalError ? cause : new PaperJournalError('AI_REVIEW_FAILED', 'AI 거래 복기를 처리하지 못했습니다.', 500);
  const providerCall: AiProviderCallState = error.providerCall ?? { attempted: false, completed: false, reused: false };
  return response.status(error.statusCode).json({ ...envelope({ ok: false, error: { code: error.code, message: error.message } }), externalAiCalled: providerCall.attempted, providerCall, rateLimitScope: 'process' });
}

function handleError(
  response: Response,
  cause: unknown,
  fallbackCode: string,
  fallbackMessage: string,
  envelope: (payload?: Record<string, unknown>) => Record<string, unknown>,
) {
  if (cause instanceof PaperJournalError) {
    return response.status(cause.statusCode).json(envelope({ ok: false, code: cause.code, message: cause.message }));
  }
  return response.status(500).json(envelope({ ok: false, code: fallbackCode, message: fallbackMessage }));
}

export default createPaperJournalRouter();
