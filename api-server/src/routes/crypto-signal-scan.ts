import { Router, type IRouter, type NextFunction, type Response } from 'express';
import {
  requireAuthenticated,
  requireCapability,
  type AuthenticatedRequest,
} from '../middleware/auth';
import {
  CryptoScannerProviderError,
  CryptoSignalScannerService,
  type CryptoSignalScanRequest,
} from '../services/crypto-signal-scanner.service';
import {
  CryptoPricePrecisionService,
  type CryptoPricePrecisionService as CryptoPricePrecisionServiceContract,
} from '../services/scanner-crypto-price-precision.service';
import { rankScannerCandidates } from '../services/scanner-candidate-ranking.service';
import {
  scannerStrategyForTimeframe,
  scannerStrategyTimeframeAllowed,
  type ScannerStrategyMode,
} from '../services/scanner-quant-strategy.service';
import {
  canReadScannerGrade,
  filterScannerResponseForTier,
  parseScannerGradeQuery,
} from '../services/scanner-access-control.service';
import { withScannerCanonicalActions } from '../services/scanner-market-action.service';
import { deliverScannerTelegramAlerts } from '../services/scanner-telegram-delivery.service';
import {
  ScannerRequestGuardError,
  scannerRequestGuard,
  type ScannerRequestGuard,
} from '../services/scanner-request-guard.service';
import {
  CryptoWilliamsAtrScannerOverlayService,
  type CryptoWilliamsOverlayRunner,
} from '../services/crypto-williams-atr-scanner-overlay.service';
import { withScannerOutcome } from '../services/scanner-signal.types';

export type CryptoScannerRunner = {
  scan(request: CryptoSignalScanRequest): ReturnType<typeof CryptoSignalScannerService.scan>;
};

type CryptoRouteCondition = CryptoSignalScanRequest['condition'] | 'williams';

export interface CryptoSignalScanRouteDependencies {
  scanner?: CryptoScannerRunner;
  guard?: ScannerRequestGuard;
  precision?: CryptoPricePrecisionServiceContract;
  williamsOverlay?: CryptoWilliamsOverlayRunner;
}

function requireScannerSession(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.member && !req.header('authorization')) return res.status(401).json({ error: 'LOGIN_REQUIRED' });
  return requireAuthenticated(req, res, next);
}

function number(value: unknown, minimum: number, maximum: number): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : undefined;
}

function requestKey(req: AuthenticatedRequest, market: 'spot' | 'futures'): string {
  const query = Object.entries(req.query)
    .filter(([key]) => key !== '_ts')
    .map(([key, value]) => `${key}=${String(value ?? '')}`)
    .sort()
    .join('&');
  return `${market}:${query}`;
}

function timeframe(value: unknown): CryptoSignalScanRequest['timeframe'] | null {
  const normalized = String(value ?? '5m') === '1H' ? '60m' : String(value ?? '5m');
  return ['1m', '3m', '5m', '15m', '60m', '4H', '1D'].includes(normalized)
    ? normalized as CryptoSignalScanRequest['timeframe']
    : null;
}

function strategy(value: unknown, selectedTimeframe: CryptoSignalScanRequest['timeframe']): ScannerStrategyMode | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  const selected = normalized === ''
    ? scannerStrategyForTimeframe(selectedTimeframe)
    : normalized === 'scalping' || normalized === 'swing' || normalized === 'position'
      ? normalized
      : null;
  return selected && scannerStrategyTimeframeAllowed(selected, selectedTimeframe) ? selected : null;
}

function condition(value: unknown): CryptoRouteCondition {
  const normalized = String(value ?? 'trend');
  return ['trend', 'volume', 'breakout', 'pullback', 'williams'].includes(normalized)
    ? normalized as CryptoRouteCondition
    : 'trend';
}

function routeError(res: Response, error: unknown) {
  if (error instanceof ScannerRequestGuardError) {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
    return res.status(error.status).json({
      ok: false, error: error.code, retryAfterSeconds: error.retryAfterSeconds,
      cards: [], alerts: [], failures: [], orderSubmitted: false, exchangeRequestSent: false,
    });
  }
  if (error instanceof CryptoScannerProviderError) {
    return res.status(502).json({
      ok: false, error: error.code, cards: [], alerts: [],
      failures: [{ symbol: '*', reason: 'provider_error', message: error.message }],
      dataState: 'unavailable', outcome: 'PROVIDER_FAILURE', orderSubmitted: false, exchangeRequestSent: false,
    });
  }
  return res.status(500).json({
    ok: false,
    error: error instanceof Error ? error.message.split(':')[0] : 'CRYPTO_SCAN_FAILED',
    cards: [], alerts: [], failures: [], orderSubmitted: false, exchangeRequestSent: false,
  });
}

export function createCryptoSignalScanRouter(dependencies: CryptoSignalScanRouteDependencies = {}): IRouter {
  const router: IRouter = Router();
  const scanner = dependencies.scanner ?? CryptoSignalScannerService;
  const guard = dependencies.guard ?? scannerRequestGuard;
  const precision = dependencies.precision ?? CryptoPricePrecisionService;
  const williamsOverlay = dependencies.williamsOverlay ?? CryptoWilliamsAtrScannerOverlayService;
  router.use(requireScannerSession);

  const handler = (market: 'spot' | 'futures') => async (req: AuthenticatedRequest, res: Response) => {
    const selectedTimeframe = timeframe(req.query.timeframe);
    if (!selectedTimeframe) return res.status(400).json({ error: 'CRYPTO_SCAN_TIMEFRAME_UNSUPPORTED' });
    const strategyMode = strategy(req.query.strategy, selectedTimeframe);
    if (!strategyMode) {
      return res.status(400).json({
        ok: false, error: 'CRYPTO_SCAN_STRATEGY_TIMEFRAME_MISMATCH',
        timeframe: selectedTimeframe, strategy: String(req.query.strategy ?? ''),
      });
    }
    const selectedCondition = condition(req.query.condition);
    const requestedGrade = parseScannerGradeQuery(req.query.grade);
    if (requestedGrade === null) return res.status(400).json({ ok: false, error: 'SCANNER_GRADE_UNSUPPORTED' });
    const membershipLevel = req.membershipLevel ?? 'pending';
    if (requestedGrade && !canReadScannerGrade(membershipLevel, requestedGrade)) {
      return res.status(403).json({ ok: false, error: 'SCANNER_GRADE_FORBIDDEN' });
    }
    const controller = new AbortController();
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(new Error('CRYPTO_SCAN_ABORTED'));
    };
    req.once('aborted', abort);
    res.once('close', abort);
    let lease: ReturnType<ScannerRequestGuard['acquire']> | null = null;
    try {
      lease = guard.acquire(req.member!.id, requestKey(req, market));
      const softMinimumScore = number(req.query.minimumScore, 0, 100);
      const scanned = await scanner.scan({
        memberId: req.member!.id,
        market,
        strategyMode,
        timeframe: selectedTimeframe,
        condition: selectedCondition === 'williams' ? 'breakout' : selectedCondition,
        cursor: number(req.query.cursor, 0, 1_000_000) ?? 0,
        batchSize: number(req.query.batchSize, 5, 40) ?? 24,
        minimumScore: undefined,
        maximumRiskScore: number(req.query.maximumRiskScore, 0, 100),
        signal: controller.signal,
      });
      if (controller.signal.aborted || res.writableEnded) return;
      const result = await precision.align(market, scanned, controller.signal);
      if (controller.signal.aborted || res.writableEnded) return;

      const ranking = rankScannerCandidates({
        cards: result.cards,
        market: result.market,
        strategy: strategyMode,
        softMinimumScore,
        limit: 10,
      });
      const baseRankedCards = ranking.cards.map((card) => card.signalGrade === 'B'
        ? { ...card, strongSignalEligible: false, signalState: 'CANDIDATE' as const }
        : card);
      const overlay = selectedCondition === 'williams'
        ? await williamsOverlay.apply({ market, cards: baseRankedCards, signal: controller.signal })
        : { cards: baseRankedCards, matchedCount: 0, unavailableCount: 0 };
      if (controller.signal.aborted || res.writableEnded) return;
      const rankedCards = overlay.cards.filter((card) => (
        market === 'spot'
          ? card.direction === 'LONG'
          : card.direction === 'LONG' || card.direction === 'SHORT'
      ));
      const actionableIds = new Set(rankedCards
        .filter((card) => card.signalGrade === 'S' || card.signalGrade === 'A')
        .map((card) => card.signalId));
      const cardBySignalId = new Map(rankedCards.map((card) => [card.signalId, card]));
      const sGradeCount = rankedCards.filter((card) => card.signalGrade === 'S').length;
      const aGradeCount = rankedCards.filter((card) => card.signalGrade === 'A').length;
      const bGradeCount = rankedCards.filter((card) => card.signalGrade === 'B').length;
      const actionableCount = sGradeCount + aGradeCount;
      const insufficientDataCount = result.failures.filter((failure) => failure.reason === 'invalid_data').length;
      const providerAcceptedCount = result.execution.completedCount;
      const dataSuccessCount = Math.max(0, providerAcceptedCount - insufficientDataCount);
      const preRankingFilteredCount = Math.max(0, dataSuccessCount - result.cards.length);
      const filteredByStrategyCount = preRankingFilteredCount + ranking.diagnostics.hardFilterRejectedCount;
      const rankedResult = {
        ...result,
        cards: rankedCards,
        alerts: result.alerts
          .filter((alert) => actionableIds.has(alert.signalId))
          .map((alert) => {
            const card = cardBySignalId.get(alert.signalId);
            return card
              ? {
                ...alert,
                entryZone: card.pricePlan.entryZone,
                stopLoss: card.pricePlan.stopLoss,
                targets: card.pricePlan.targets,
                evidence: card.matched,
              }
              : alert;
          }),
        execution: {
          ...result.execution,
          providerAcceptedCount,
          dataSuccessCount,
          insufficientDataCount,
          filteredByStrategyCount,
          excludedCount: Math.max(0, result.execution.completedCount - rankedCards.length),
          hardFilterPassCount: ranking.diagnostics.hardFilterPassCount,
          hardFilterRejectedCount: ranking.diagnostics.hardFilterRejectedCount,
          softCandidateCount: ranking.diagnostics.softCandidateCount,
          finalDisplayedCount: rankedCards.length,
          sGradeCount,
          aGradeCount,
          bGradeCount,
          backtestMissingCount: ranking.diagnostics.backtestMissingCount,
        },
        message: selectedCondition === 'williams'
          ? overlay.unavailableCount > 0 && overlay.matchedCount === 0
            ? `Williams+ATR 일봉 확인 실패/부족 ${overlay.unavailableCount}개 · 강한 신호 승격 없음`
            : actionableCount === 0
              ? `Williams+ATR 확인 신호 없음 · 일치 ${overlay.matchedCount}개 · B 관찰 ${bGradeCount}개`
              : `Williams+ATR + Quant S/A 일치 ${actionableCount}개 · B 관찰 ${bGradeCount}개`
          : dataSuccessCount === 0 && insufficientDataCount > 0
            ? `현재 묶음에서 공급자 응답은 받았지만 ${insufficientDataCount}종목의 분석 데이터가 부족합니다.`
            : rankedCards.length === 0
              ? '현재 묶음에서 추천 정책을 통과한 후보가 없습니다.'
              : actionableCount === 0
                ? `현재 진입 가능한 강한 신호 없음 · 관찰 후보 ${bGradeCount}개`
                : `S/A 진입 검토 ${actionableCount}개 · B 관찰 ${bGradeCount}개`,
      };
      const canonicalResult = withScannerCanonicalActions(rankedResult);
      const visibleResult = withScannerOutcome(filterScannerResponseForTier(canonicalResult, membershipLevel, requestedGrade ?? undefined));
      void deliverScannerTelegramAlerts(visibleResult.alerts);
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('X-Scanner-Request-Id', result.requestId);
      return res.json({ ...visibleResult, strategy: strategyMode, condition: selectedCondition });
    } catch (error) {
      if (controller.signal.aborted || res.writableEnded) return;
      return routeError(res, error);
    } finally {
      lease?.release();
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    }
  };

  router.get('/spot', requireCapability('canAccessBasicInfo'), handler('spot'));
  router.get('/futures', requireCapability('canAccessBasicInfo'), handler('futures'));
  return router;
}

export default createCryptoSignalScanRouter();
