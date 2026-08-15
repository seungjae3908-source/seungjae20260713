import type { IRouter, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { PaperJournalError, type PaperJournalRepository } from '../services/paper-journal.types';
import { buildUnifiedTradeJournal, JOURNAL_COST_SAFETY } from '../services/unified-trade-journal.service';
import { buildPortfolioIntelligence } from '../services/portfolio-intelligence.service.ts';
import {
  InvestmentCopilotQueryError,
  queryInvestmentCopilot,
} from '../services/investment-copilot-query.service.ts';
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

function copilotEnvelope(payload: Record<string, unknown> = {}) {
  return {
    ...envelope(payload),
    mode: 'portfolio-copilot-tool' as const,
  };
}

type Dependencies = {
  repositoryFactory: (request: AuthenticatedRequest) => PaperJournalRepository;
  now: () => Date;
  requirePortfolioAdvisor: (request: AuthenticatedRequest) => string;
};

function failure(
  response: Response,
  cause: unknown,
  wrap: (payload?: Record<string, unknown>) => Record<string, unknown> = envelope,
) {
  if (cause instanceof PaperJournalError) {
    return response.status(cause.statusCode).json(wrap({ ok: false, code: cause.code, message: cause.message }));
  }
  if (cause instanceof AdvisorContextError) {
    return response.status(400).json(wrap({ ok: false, code: cause.code, message: '민감정보 또는 허용되지 않은 AI context가 포함되어 있습니다.' }));
  }
  if (cause instanceof InvestmentCopilotQueryError) {
    return response.status(cause.statusCode).json(wrap({ ok: false, code: cause.code, message: cause.message }));
  }
  if (cause instanceof Error && cause.message.startsWith('PORTFOLIO_HOLDINGS_READ_FAILED:')) {
    return response.status(503).json(wrap({ ok: false, code: 'PORTFOLIO_HOLDINGS_UNAVAILABLE', message: '포트폴리오 보유 데이터를 읽지 못했습니다.' }));
  }
  return response.status(500).json(wrap({ ok: false, code: 'PORTFOLIO_ADVISOR_FAILED', message: '포트폴리오 분석을 처리하지 못했습니다.' }));
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

  router.post('/paper-journal/portfolio-advisor/query', async (request: AuthenticatedRequest, response) => {
    if (requestSize(request) > MAX_REQUEST_BYTES) {
      return response.status(413).json(copilotEnvelope({ ok: false, code: 'REQUEST_TOO_LARGE', message: '포트폴리오 질문 크기가 제한을 초과했습니다.' }));
    }
    try {
      dependencies.requirePortfolioAdvisor(request);
      const body = isObject(request.body) ? request.body : {};
      if (containsClientPortfolioState(body)) {
        throw new PaperJournalError(
          'CLIENT_PORTFOLIO_STATE_FORBIDDEN',
          '포트폴리오 상태는 인증된 서버 snapshot에서만 결정됩니다.',
        );
      }
      sanitizeAdvisorContext(body);
      if (!request.accessToken) throw new PaperJournalError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);

      const snapshot = await buildPortfolioIntelligence({ accessToken: request.accessToken });
      const result = queryInvestmentCopilot(snapshot, body.message);
      return response.json(copilotEnvelope({
        ok: true,
        result,
        sourceOfTruth: 'PORTFOLIO_INTELLIGENCE_V2',
        providerBridgeStatus: 'NOT_CALLED_BY_THIS_READ_ONLY_ROUTE',
      }));
    } catch (cause) {
      return failure(response, cause, copilotEnvelope);
    }
  });
}
