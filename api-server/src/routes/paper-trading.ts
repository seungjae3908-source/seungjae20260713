import { Router, type IRouter } from 'express';
import { resolveCanonicalStrategyIdentity } from '../../../market-prediction-lab/src/canonical-strategy-identity-v1.js';
import type { BacktestPaperHandoff } from '../../../packages/strategy-hypothesis/src/backtest-paper-handoff.js';
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
import { manualPaperCanonicalCandidateId } from '../services/manual-paper-canonical-contract.service';
import { ProductPaperSourceError, productPaperSourceRegistry, type ProductPaperSourceRegistry } from '../services/product-paper-source-registry.service';
import type { PaperBacktestCandidateIdentity } from '../services/paper-trading.types';
import type { ManualPaperCanonicalEvidenceSource } from '../services/manual-paper-canonical-evidence-source.service';
import { productManualPaperCanonicalEvidenceSource } from '../services/manual-paper-canonical-runtime-evidence-source.service';

const MAX_REQUEST_BYTES = 128 * 1024;

type PaperTradingDependencies = {
  evaluate: typeof applyPaperTradingAction;
  publishState: typeof publishAuthenticatedPaperTradingState;
  canonicalClock: () => Date;
  canonicalEvidenceSource: ManualPaperCanonicalEvidenceSource;
  sourceRegistry: ProductPaperSourceRegistry;
  researchCodeSha: () => string;
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

type BacktestResolvedSource = Readonly<{
  sourceSha: string;
  handoff: BacktestPaperHandoff;
  strategyIdentityInput: Readonly<Record<string, unknown>>;
}>;

function acceptedBacktestCandidate(source: BacktestResolvedSource): PaperBacktestCandidateIdentity {
  const handoff = source.handoff;
  const required = [
    handoff.candidateId, handoff.strategyId, handoff.parameterHash, handoff.market, handoff.symbol,
    handoff.timeframe, handoff.side, handoff.riskPolicyRef, handoff.costPolicyRef, handoff.exitPolicyRef,
  ];
  if (required.some((value) => typeof value !== 'string' || value.length === 0) || typeof handoff.leverage !== 'number') {
    throw new ProductPaperSourceError('BACKTEST_PAPER_IDENTITY_REQUIRED', 409);
  }
  const resolved = resolveCanonicalStrategyIdentity(source.strategyIdentityInput);
  if (resolved.status !== 'IDENTITY_COMPLETE' || !resolved.identity) {
    throw new ProductPaperSourceError('BACKTEST_CANONICAL_STRATEGY_IDENTITY_REQUIRED', 409);
  }
  const identity = resolved.identity;
  if (identity.strategyId !== handoff.strategyId || identity.parameterHash !== handoff.parameterHash
    || identity.market !== handoff.market || identity.direction !== handoff.side
    || identity.timeframe !== handoff.timeframe || identity.researchCodeSha !== source.sourceSha
    || identity.costPolicyVersion !== handoff.costPolicyRef || identity.riskPolicyVersion !== handoff.riskPolicyRef) {
    throw new ProductPaperSourceError('BACKTEST_CANONICAL_STRATEGY_IDENTITY_MISMATCH', 409);
  }
  return Object.freeze({
    candidateId: handoff.candidateId as string,
    strategyId: handoff.strategyId as string,
    parameterHash: handoff.parameterHash as string,
    market: handoff.market as string,
    symbol: handoff.symbol as string,
    timeframe: handoff.timeframe as string,
    side: handoff.side as 'LONG' | 'SHORT',
    leverage: handoff.leverage as number,
    riskPolicyRef: handoff.riskPolicyRef as string,
    costPolicyRef: handoff.costPolicyRef as string,
    exitPolicyRef: handoff.exitPolicyRef as string,
  });
}

function sameBacktestCandidate(left: PaperBacktestCandidateIdentity | undefined, right: PaperBacktestCandidateIdentity): boolean {
  if (!left) return false;
  return (['candidateId', 'strategyId', 'parameterHash', 'market', 'symbol', 'timeframe', 'side', 'leverage',
    'riskPolicyRef', 'costPolicyRef', 'exitPolicyRef'] as const).every((field) => left[field] === right[field]);
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
  const canonicalEvidenceSource = dependencies.canonicalEvidenceSource
    ?? productManualPaperCanonicalEvidenceSource;
  const sourceRegistry = dependencies.sourceRegistry ?? productPaperSourceRegistry;
  const researchCodeSha = dependencies.researchCodeSha ?? (() => String(process.env.DEPLOY_SHA ?? '').trim().toLowerCase());

  router.post('/paper-trading/evaluate', async (req: AuthenticatedRequest, res) => {
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

    const nowValue = req.body.now;
    const now = typeof nowValue === 'string' || typeof nowValue === 'number'
      ? new Date(nowValue)
      : new Date();
    if (!Number.isFinite(now.getTime())) {
      return res.status(400).json(safeEnvelope({
        ok: false,
        code: 'INVALID_TIMESTAMP',
        message: '모의거래 계산 시각을 확인하세요.',
      }));
    }

    try {
      const state = req.body.state as PaperTradingState;
      let action = req.body.action as PaperTradingAction;
      if (action.type === 'place_order' && action.request.backtestCandidate) {
        throw new ProductPaperSourceError('CLIENT_BACKTEST_PAPER_AUTHORITY_FORBIDDEN', 400);
      }
      const authenticatedAccountId = req.member?.id ?? '';
      let backtestCandidate: PaperBacktestCandidateIdentity | undefined;
      const backtestRequested = req.body.backtestCandidate !== undefined || req.body.backtestRunId !== undefined;
      if (backtestRequested) {
        if (action.type !== 'place_order') {
          throw new ProductPaperSourceError('BACKTEST_PAPER_PLACE_ORDER_REQUIRED', 400);
        }
        if (action.request.canonicalIdentity) {
          throw new ProductPaperSourceError('CLIENT_BACKTEST_PAPER_AUTHORITY_FORBIDDEN', 400);
        }
        const source = sourceRegistry.resolveBacktest(authenticatedAccountId, {
          mode: req.body.mode,
          accountMode: req.body.accountMode,
          adapter: req.body.adapter,
          backtestCandidate: req.body.backtestCandidate,
          backtestRunId: req.body.backtestRunId,
        }, researchCodeSha()) as BacktestResolvedSource;
        backtestCandidate = acceptedBacktestCandidate(source);
        const requestedSide = action.request.side === 'short' ? 'SHORT' : action.request.side === 'long' ? 'LONG' : null;
        if (String(action.request.symbol ?? '').trim().toUpperCase() !== backtestCandidate.symbol
          || requestedSide !== backtestCandidate.side || action.request.leverage !== backtestCandidate.leverage) {
          throw new ProductPaperSourceError('BACKTEST_PAPER_ACTION_IDENTITY_MISMATCH', 409);
        }
        action = {
          ...action,
          request: { ...action.request, backtestCandidate },
        } as PaperTradingAction;
      }
      const candidateId = backtestCandidate?.candidateId ?? manualPaperCanonicalCandidateId(state, action);
      const ownerNow = dependencies.canonicalClock?.() ?? new Date();
      const canonicalEvidence = await canonicalEvidenceSource({
        authenticatedAccountId,
        candidateId,
        action,
        state,
        nowMs: ownerNow.getTime(),
      });
      if (canonicalEvidence && canonicalEvidence.authenticatedAccountId !== authenticatedAccountId) {
        throw new PaperTradingError('CANONICAL_PAPER_ACCOUNT_BINDING_MISMATCH', 'Canonical Paper account binding이 일치하지 않습니다.');
      }
      if (backtestCandidate && !canonicalEvidence) {
        throw new PaperTradingError('SERVER_OWNED_BACKTEST_PAPER_EVIDENCE_REQUIRED', 'Backtest 후보의 Canonical Paper owner evidence가 필요합니다.', 503);
      }
      const result = evaluate(
        state,
        action,
        canonicalEvidence ? ownerNow : now,
        canonicalEvidence,
      );
      if (backtestCandidate && !sameBacktestCandidate(result.order?.backtestCandidate, backtestCandidate)) {
        throw new PaperTradingError('BACKTEST_PAPER_EXECUTION_IDENTITY_NOT_PRESERVED', 'Backtest 후보 identity가 Paper execution consumer에서 보존되지 않았습니다.');
      }
      if (backtestCandidate && result.position && !sameBacktestCandidate(result.position.backtestCandidate, backtestCandidate)) {
        throw new PaperTradingError('BACKTEST_PAPER_POSITION_IDENTITY_NOT_PRESERVED', 'Backtest 후보 identity가 Paper position에서 보존되지 않았습니다.');
      }
      let paperStateTransport: PaperStateTransportPublishResult;
      try {
        paperStateTransport = await publishState({
          state: result.state,
          authenticatedPublisherAccountId: req.member?.id ?? '',
          sourceSha: String(process.env.DEPLOY_SHA ?? '').trim().toLowerCase(),
          observedAtMs: canonicalEvidence ? ownerNow.getTime() : now.getTime(),
        });
      } catch {
        paperStateTransport = blockedTransport('PAPER_STATE_PUBLISHER_UNAVAILABLE');
      }
      return res.json(safeEnvelope({ ok: true, result, paperStateTransport }));
    } catch (error) {
      if (error instanceof ProductPaperSourceError) {
        return res.status(error.status).json(safeEnvelope({
          ok: false,
          code: error.code,
          message: 'Backtest Paper source를 검증하지 못했습니다.',
        }));
      }
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
