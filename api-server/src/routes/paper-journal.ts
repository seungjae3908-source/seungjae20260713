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
import { registerCanonicalPortfolioAdvisorRoute } from './paper-journal-portfolio-advisor';
import {
  JOURNAL_COST_SAFETY,
  TOSS_CONTRACT_PREVIEW_DISABLED,
  TOSS_LIVE_READ_INTEGRATION,
  TRADE_BROKERS,
  TRADE_MARKETS,
  TRADE_RANGES,
  TRADE_SOURCES,
  buildUnifiedTradeJournal,
  normalizeTossOrderContract,
  tossJournalIntegrationStatus,
  type TossOrderContract,
  type TradeMarket,
  type TradeBroker,
  type TradeRange,
  type TradeSource,
  type UnifiedJournalFilters,
} from '../services/unified-trade-journal.service';
import { memberBrokerJournalSnapshot } from './account-connections';

const MAX_REQUEST_BYTES = 512 * 1024;

type PaperJournalDependencies = {
  repositoryFactory: (request: AuthenticatedRequest) => PaperJournalRepository;
  now: () => Date;
  reviewProvider: TradingReviewProvider | null;
  allowTossContractPreview: boolean;
  brokerJournalFactory: typeof memberBrokerJournalSnapshot;
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

function queryText(value: unknown, maximum = 80) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : null;
}

function unifiedFilters(query: Request['query']): UnifiedJournalFilters {
  const range = queryText(query.range, 10) ?? '30D';
  const market = queryText(query.market, 30) ?? 'ALL';
  const source = queryText(query.source, 30) ?? 'ALL';
  const broker = queryText(query.broker, 30) ?? 'ALL';
  const account = queryText(query.account, 80);
  const grade = queryText(query.grade, 5) ?? 'ALL';
  if (!TRADE_RANGES.includes(range as TradeRange)) throw new PaperJournalError('INVALID_JOURNAL_RANGE', '매매일지 조회 기간을 확인하세요.');
  if (market !== 'ALL' && !TRADE_MARKETS.includes(market as TradeMarket)) throw new PaperJournalError('INVALID_JOURNAL_MARKET', '매매일지 시장 필터를 확인하세요.');
  if (source !== 'ALL' && !TRADE_SOURCES.includes(source as TradeSource)) throw new PaperJournalError('INVALID_JOURNAL_SOURCE', '매매일지 출처 필터를 확인하세요.');
  if (broker !== 'ALL' && !TRADE_BROKERS.includes(broker as TradeBroker)) throw new PaperJournalError('INVALID_JOURNAL_BROKER', '매매일지 공급자 필터를 확인하세요.');
  if (account && !/^[A-Z]+-\*\*\*\*-[A-Z0-9-]+$/.test(account)) throw new PaperJournalError('INVALID_JOURNAL_ACCOUNT', '매매일지 계좌 별칭 필터를 확인하세요.');
  if (!['ALL', 'A', 'B', 'C', 'D'].includes(grade)) throw new PaperJournalError('INVALID_JOURNAL_GRADE', '매매 품질 등급 필터를 확인하세요.');
  return {
    range: range as TradeRange,
    market: market as TradeMarket | 'ALL',
    source: source as TradeSource | 'ALL',
    broker: broker as TradeBroker | 'ALL',
    account,
    strategy: queryText(query.strategy),
    timeframe: queryText(query.timeframe, 20),
    grade: grade as UnifiedJournalFilters['grade'],
  };
}

function includeBrokerJournal(query: Request['query']) {
  if (query.includeBroker == null || query.includeBroker === 'false') return false;
  if (query.includeBroker === 'true') return true;
  throw new PaperJournalError('INVALID_JOURNAL_BROKER_IMPORT', '브로커 일지 포함 설정을 확인하세요.');
}

function containsForbiddenContractField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenContractField);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, nested]) => (
    /(?:user_?id|account_?number|access_?token|refresh_?token|client_?secret|api_?key|secret_?key|authorization|cookie)/i.test(key)
      || containsForbiddenContractField(nested)
  ));
}

export function createPaperJournalRouter(
  dependencies: Partial<PaperJournalDependencies> = {},
): IRouter {
  const router: IRouter = Router();
  const repositoryFactory = dependencies.repositoryFactory ?? defaultRepositoryFactory;
  const now = dependencies.now ?? (() => new Date());
  const reviewProvider = dependencies.reviewProvider === undefined ? configuredTradingReviewProvider() : dependencies.reviewProvider;
  const allowTossContractPreview = dependencies.allowTossContractPreview === true;
  const brokerJournalFactory = dependencies.brokerJournalFactory ?? memberBrokerJournalSnapshot;

  const requireAiReview = (request: AuthenticatedRequest) => {
    if (!request.member || !hasCapability(request.member, 'canAccessAiTradingReview')) throw new PaperJournalError('CAPABILITY_REQUIRED', 'AI 거래 복기는 정회원과 관리자만 사용할 수 있습니다.', request.member ? 403 : 401);
    return request.member.id;
  };

  registerCanonicalPortfolioAdvisorRoute(router, {
    repositoryFactory,
    now,
    requirePortfolioAdvisor: requireAiReview,
  });

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

  router.get('/paper-journal/unified-ledger/status', (_request: AuthenticatedRequest, response) => response.json(analysisEnvelope({
    ok: true,
    result: {
      toss: tossJournalIntegrationStatus(),
      safety: JOURNAL_COST_SAFETY,
    },
  })));

  router.get('/paper-journal/unified-ledger', async (request: AuthenticatedRequest, response) => {
    try {
      const payloads = await repositoryFactory(request).listJournalPayloads(request.member?.id ?? '');
      const brokerRequested = includeBrokerJournal(request.query);
      const brokerJournal = brokerRequested ? await brokerJournalFactory(request) : null;
      const privateReadRequests = brokerJournal
        ? Object.values(brokerJournal.providers).reduce((sum, provider) => sum + provider.privateReadRequests, 0)
        : 0;
      return response.json(analysisEnvelope({
        ok: true,
        result: buildUnifiedTradeJournal([...payloads, ...(brokerJournal?.records ?? [])], unifiedFilters(request.query), now()),
        brokerImport: {
          requested: brokerRequested,
          importedRecords: brokerJournal?.records.length ?? 0,
          privateReadRequests,
          privateMutationRequests: brokerJournal?.safety.privateMutationRequests ?? 0,
          providers: brokerJournal?.providers ?? null,
        },
      }));
    } catch (cause) {
      return handleError(response, cause, 'UNIFIED_JOURNAL_FAILED', '통합 매매일지를 처리하지 못했습니다.', analysisEnvelope);
    }
  });

  router.post('/paper-journal/unified-ledger/toss-contract-preview', (request: AuthenticatedRequest, response) => {
    const envelope = (payload: Record<string, unknown> = {}) => analysisEnvelope({
      tossLiveReadIntegration: TOSS_LIVE_READ_INTEGRATION,
      safety: JOURNAL_COST_SAFETY,
      ...payload,
    });
    if (!allowTossContractPreview) {
      return response.status(503).json(envelope({ ok: false, code: TOSS_CONTRACT_PREVIEW_DISABLED, message: '공개 Toss 계약 미리보기는 비활성화되어 있습니다. 회원별 read-only 연결 경로를 사용하세요.' }));
    }
    if (requestSize(request) > MAX_REQUEST_BYTES) return response.status(413).json(envelope({ ok: false, code: 'REQUEST_TOO_LARGE', message: 'Toss 계약 검증 요청이 너무 큽니다.' }));
    try {
      const body = isObject(request.body) ? request.body : {};
      if (containsForbiddenContractField(body)) throw new PaperJournalError('SENSITIVE_TOSS_INPUT_FORBIDDEN', 'Secret, 전체 계좌번호 또는 사용자 식별자는 계약 검증에 포함할 수 없습니다.');
      if (!Array.isArray(body.orders) || body.orders.length > 100) throw new PaperJournalError('INVALID_TOSS_CONTRACT_FIXTURES', 'Toss 계약 fixture는 최대 100건까지 허용됩니다.');
      const alias = queryText(body.accountAlias, 80);
      if (!alias) throw new PaperJournalError('TOSS_ACCOUNT_ALIAS_REQUIRED', '실계좌번호가 아닌 테스트용 계좌 별칭이 필요합니다.');
      const records = body.orders.map((order) => normalizeTossOrderContract(order as TossOrderContract, alias, now().toISOString()));
      return response.json(envelope({ ok: true, records, privateBrokerRequests: 0, stored: false }));
    } catch (cause) {
      return handleError(response, cause, 'TOSS_CONTRACT_PREVIEW_FAILED', 'Toss 주문 계약 fixture를 검증하지 못했습니다.', envelope);
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