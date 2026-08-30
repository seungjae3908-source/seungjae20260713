import { Router, type IRouter } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import {
  applyPaperTradingAction,
  PaperTradingError,
  type PaperTradingAction,
  type PaperTradingState,
} from '../services/paper-trading-engine.service';
import {
  PAPER_STATE_TRANSPORT_PUBLISH_RESULT_VERSION,
  publishAuthenticatedPaperTradingState,
  type PaperStateTransportPublishResult,
} from '../services/paper-trading-state-publisher.service';

const MAX_REQUEST_BYTES = 128 * 1024;

type PaperTradingDependencies = {
  evaluate: typeof applyPaperTradingAction;
  publishState: typeof publishAuthenticatedPaperTradingState;
  clock: () => Date;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeEnvelope(payload: Record<string, unknown> = {}) {
  return {
    mode: 'paper-only' as const,
    orderSubmitted: false as const,
    exchangeRequestSent: false as const,
    ...payload,
  };
}

function blockedTransport(reason: string): PaperStateTransportPublishResult {
  return Object.freeze({
    schemaVersion: PAPER_STATE_TRANSPORT_PUBLISH_RESULT_VERSION,
    status: 'BLOCKED_DATA',
    invoked: false,
    callbackEligible: false,
    reason,
    snapshotSchemaVersion: null,
    publisherAccountBound: false,
    stateDigestSha256: null,
    observedAtMs: null,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
    unknownIsZero: false,
  });
}

export function createPaperTradingRouter(
  dependencies: Partial<PaperTradingDependencies> = {},
): IRouter {
  const router: IRouter = Router();
  const evaluate = dependencies.evaluate ?? applyPaperTradingAction;
  const publishState = dependencies.publishState ?? publishAuthenticatedPaperTradingState;
  const clock = dependencies.clock ?? (() => new Date());

  router.post('/paper-trading/evaluate', async (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const declaredLength = Number(req.header('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return res.status(413).json(safeEnvelope({
        ok: false,
        code: 'REQUEST_TOO_LARGE',
        message: '모의거래 계산 요청 크기가 제한을 초과했습니다.',
      }));
    }

    let serializedLength = 0;
    try {
      serializedLength = Buffer.byteLength(JSON.stringify(req.body ?? null), 'utf8');
    } catch {
      serializedLength = MAX_REQUEST_BYTES + 1;
    }
    if (serializedLength > MAX_REQUEST_BYTES) {
      return res.status(413).json(safeEnvelope({
        ok: false,
        code: 'REQUEST_TOO_LARGE',
        message: '모의거래 계산 요청 크기가 제한을 초과했습니다.',
      }));
    }

    if (!isObject(req.body) || !isObject(req.body.state) || !isObject(req.body.action)) {
      return res.status(400).json(safeEnvelope({
        ok: false,
        code: 'INVALID_PAPER_REQUEST',
        message: '모의거래 상태와 액션을 확인하세요.',
      }));
    }

    const serverNow = clock();
    const nowValue = req.body.now;
    const now = typeof nowValue === 'string' || typeof nowValue === 'number'
      ? new Date(nowValue)
      : serverNow;
    if (!Number.isFinite(serverNow.getTime()) || !Number.isFinite(now.getTime()) || now.getTime() > serverNow.getTime()) {
      return res.status(400).json(safeEnvelope({
        ok: false,
        code: 'INVALID_TIMESTAMP',
        message: '모의거래 계산 시각을 확인하세요.',
      }));
    }

    try {
      const result = evaluate(
        req.body.state as PaperTradingState,
        req.body.action as PaperTradingAction,
        now,
      );
      let paperStateTransport: PaperStateTransportPublishResult;
      try {
        paperStateTransport = await publishState({
          state: result.state,
          authenticatedPublisherAccountId: req.member?.id ?? '',
          sourceSha: String(process.env.DEPLOY_SHA ?? '').trim().toLowerCase(),
          // A caller's historical simulation clock cannot create a future or renewed immutable observation.
          observedAtMs: serverNow.getTime(),
        });
      } catch {
        paperStateTransport = blockedTransport('PAPER_STATE_PUBLISHER_UNAVAILABLE');
      }
      return res.json(safeEnvelope({ ok: true, result, paperStateTransport,
        observedAt: serverNow.toISOString(), calculationClockSource: nowValue == null ? 'SERVER' : 'CLIENT_SIMULATION' }));
    } catch (error) {
      if (error instanceof PaperTradingError) {
        return res.status(error.statusCode).json(safeEnvelope({
          ok: false,
          code: error.code,
          message: error.message,
        }));
      }
      return res.status(500).json(safeEnvelope({
        ok: false,
        code: 'PAPER_TRADING_EVALUATION_FAILED',
        message: '모의거래 계산을 처리하지 못했습니다.',
      }));
    }
  });

  return router;
}

export default createPaperTradingRouter();
