import type { IRouter, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { PaperJournalError, type PaperJournalRepository } from '../services/paper-journal.types';
import { buildUnifiedTradeJournal, JOURNAL_COST_SAFETY } from '../services/unified-trade-journal.service';
import {
  AdvisorContextError,
  buildCanonicalJournalPortfolioAdvisor,
  sanitizeAdvisorContext,
} from '../modules/portfolio/index.ts';

const MAX_REQUEST_BYTES = 512 * 1024;
const clientPortfolioStateKey = /^(?:user_?id|positions?|holdings?|portfolio|cash|cashEvidence|priceEvidence|riskEvidence|account|broker|credentials?)$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requestSize(request: AuthenticatedRequest): number {
  const declared = Number(request.header('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return declared;
  try {
    return Buffer.byteLength(JSON.stringify(request.body ?? null), 'utf8');
  } catch {
    return MAX_REQUEST_BYTES + 1;
  }
}

function containsClientPortfolioState(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsClientPortfolioState);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, nested]) => clientPortfolioStateKey.test(key) || containsClientPortfolioState(nested));
}

function envelope(payload: Record<string, unknown> = {}) {
  return {
    mode: 'portfolio-advisor-preview' as const,
    externalAiCalled: false as const,
    orderSubmitted: false as const,
    exchangeRequestSent: false as const,
    privateTradingApiRequests: 0 as const,
    orderAuthority: 'none' as const,
    safety: JOURNAL_COST_SAFETY,
    ...payload,
  };
}

type Dependencies = {
  repositoryFactory: (request: AuthenticatedRequest) => PaperJournalRepository;
  now: () => Date;
  requirePortfolioAdvisor: (request: AuthenticatedRequest) => string;
};

function failure(response: Response, cause: unknown) {
  if (cause instanceof PaperJournalError) {
    return response.status(cause.statusCode).json(envelope({ ok: false, code: cause.code, message: cause.message }));
  }
  if (cause instanceof AdvisorContextError) {
    return response.status(400).json(envelope({ ok: false, code: cause.code, message: '민감정보 또는 허용되지 않은 AI context가 포함되어 있습니다.' }));
  }
  return response.status(500).json(envelope({ ok: false, code: 'PORTFOLIO_ADVISOR_FAILED', message: '포트폴리오 분석을 처리하지 못했습니다.' }));
}

export function registerCanonicalPortfolioAdvisorRoute(router: IRouter, dependencies: Dependencies): void {
  router.post('/paper-journal/portfolio-advisor/preview', async (request: AuthenticatedRequest, response) => {
    if (requestSize(request) > MAX_REQUEST_BYTES) {
      return response.status(413).json(envelope({ ok: false, code: 'REQUEST_TOO_LARGE', message: '포트폴리오 분석 요청 크기가 제한을 초과했습니다.' }));
    }
    try {
      const userId = dependencies.requirePortfolioAdvisor(request);
      const body = isObject(request.body) ? request.body : {};
      if (containsClientPortfolioState(body)) {
        throw new PaperJournalError(
          'CLIENT_PORTFOLIO_STATE_FORBIDDEN',
          '포트폴리오 상태와 사용자 식별자는 canonical journal에서만 결정됩니다.',
        );
      }
      sanitizeAdvisorContext(body);
      const payloads = await dependencies.repositoryFactory(request).listJournalPayloads(userId);
      const journal = buildUnifiedTradeJournal(payloads, { range: 'ALL' }, dependencies.now());
      const result = buildCanonicalJournalPortfolioAdvisor(journal, dependencies.now());
      return response.json(envelope({ ok: true, result }));
    } catch (cause) {
      return failure(response, cause);
    }
  });
}