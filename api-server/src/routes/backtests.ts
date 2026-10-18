import { Router, type IRouter, type Request } from 'express';
import { requireAdmin, type AuthenticatedRequest } from '../middleware/auth';
import { ProviderError } from '../lib/errors';
import { logger } from '../lib/logger';
import { ProductPaperSourceError, productPaperSourceRegistry, type ProductPaperSourceRegistry } from '../services/product-paper-source-registry.service';
import {
  BACKTEST_LIMITS,
  BacktestValidationError,
  evaluateSelectionBias,
  recordSelectionRun,
  resetSelectionRunsForTests,
  runBacktest,
  selectionBiasWarning,
  validateBacktestRequest,
  type BacktestRequest,
} from '../services/backtest-engine.service';
import { loadHistoricalBacktestCandles } from '../services/backtest-data.service';
import { getFuturesContractRules } from '../services/futures-contract-rules.service';
import { buildBacktestPaperHandoffBundle, type BacktestPaperCanonicalStrategyInput } from '../services/backtest-paper-handoff.service';

const MAX_REQUEST_BYTES = 64 * 1024;
const EXECUTION_TIMEOUT_MS = 25_000;
const MAX_CONCURRENT_EXECUTIONS = 2;
let activeExecutions = 0;

type BacktestDependencies = {
  loadCandles: typeof loadHistoricalBacktestCandles;
  loadContractRules: typeof getFuturesContractRules;
  execute: typeof runBacktest;
  researchCodeSha: () => string;
  sourceRegistry: ProductPaperSourceRegistry;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberField(body: Record<string, unknown>, key: string, fallback?: number) {
  const value = body[key];
  if (value == null && fallback != null) return fallback;
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

function optionalNumber(body: Record<string, unknown>, key: string) {
  const value = body[key];
  return value == null ? undefined : typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

function parseRequest(body: unknown): BacktestRequest {
  if (!isObject(body)) throw new BacktestValidationError('INVALID_REQUEST', 'JSON 요청 본문이 필요합니다.');
  const parameters: Record<string, number | boolean> = {};
  if (isObject(body.parameters)) {
    for (const [key, value] of Object.entries(body.parameters)) {
      if (typeof value === 'number' || typeof value === 'boolean') parameters[key] = value;
    }
  }
  const trailingInput = isObject(body.trailingStop) ? body.trailingStop : null;
  const splitInput = isObject(body.validationSplit) ? body.validationSplit : null;
  const request: BacktestRequest = {
    market: String(body.market ?? '') as BacktestRequest['market'],
    symbol: String(body.symbol ?? '').trim().toUpperCase(),
    timeframe: String(body.timeframe ?? ''),
    startTime: numberField(body, 'startTime'),
    endTime: numberField(body, 'endTime'),
    initialCapital: numberField(body, 'initialCapital'),
    strategy: String(body.strategy ?? '') as BacktestRequest['strategy'],
    side: String(body.side ?? '') as BacktestRequest['side'],
    parameters,
    riskPercent: numberField(body, 'riskPercent'),
    leverage: numberField(body, 'leverage'),
    entryFeeRate: numberField(body, 'entryFeeRate'),
    exitFeeRate: numberField(body, 'exitFeeRate'),
    slippageRate: numberField(body, 'slippageRate'),
    fundingRatePerInterval: optionalNumber(body, 'fundingRatePerInterval'),
    fundingIntervalHours: optionalNumber(body, 'fundingIntervalHours'),
    stopLossMode: String(body.stopLossMode ?? '') as BacktestRequest['stopLossMode'],
    stopLossValue: numberField(body, 'stopLossValue'),
    takeProfitMode: String(body.takeProfitMode ?? '') as BacktestRequest['takeProfitMode'],
    takeProfitValue: numberField(body, 'takeProfitValue'),
    trailingStop: trailingInput
      ? {
          enabled: trailingInput.enabled === true,
          activationR: optionalNumber(trailingInput, 'activationR'),
          distanceR: optionalNumber(trailingInput, 'distanceR'),
        }
      : undefined,
    maximumConcurrentPositions: numberField(body, 'maximumConcurrentPositions', 1),
    maximumTradesPerDay: numberField(body, 'maximumTradesPerDay', 10),
    intrabarPriority: String(body.intrabarPriority ?? 'stop_first') as BacktestRequest['intrabarPriority'],
    validationSplit: splitInput
      ? {
          trainingPercent: numberField(splitInput, 'trainingPercent'),
          validationPercent: numberField(splitInput, 'validationPercent'),
          testPercent: numberField(splitInput, 'testPercent'),
        }
      : undefined,
  };
  if (!['percent', 'atr', 'swing'].includes(request.stopLossMode)) {
    throw new BacktestValidationError('INVALID_STOP_MODE', '손절 방식이 올바르지 않습니다.');
  }
  if (!['risk_multiple', 'percent'].includes(request.takeProfitMode)) {
    throw new BacktestValidationError('INVALID_TARGET_MODE', '목표 방식이 올바르지 않습니다.');
  }
  if (!['stop_first', 'target_first'].includes(request.intrabarPriority ?? 'stop_first')) {
    throw new BacktestValidationError('INVALID_INTRABAR_PRIORITY', '봉 내부 체결 우선순위가 올바르지 않습니다.');
  }
  validateBacktestRequest(request);
  return request;
}

function serializedSize(body: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(body ?? null), 'utf8');
  } catch {
    return MAX_REQUEST_BYTES + 1;
  }
}

export type BacktestFailureReason =
  | 'INVALID_REQUEST'
  | 'PROVIDER_BLOCKED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'PROVIDER_NETWORK'
  | 'INTERNAL';

export interface BacktestSafeError {
  status: number;
  code: string;
  reason: BacktestFailureReason;
  message: string;
}

const PROVIDER_LABEL: Record<string, string> = {
  BITGET: '코인선물(비트겟)',
  UPBIT: '코인현물(업비트)',
};

function providerLabel(raw: string): string {
  const prefix = /^([A-Z]+)_/u.exec(raw)?.[1] ?? '';
  return PROVIDER_LABEL[prefix] ?? '과거 데이터';
}

/**
 * Maps any backtest failure to a safe, specific Korean reason the UI can show.
 * Provider/network failures used to collapse into BACKTEST_EXECUTION_FAILED,
 * hiding e.g. a 403 block from the exchange's public API. Raw error text and
 * stacks are never returned to the client; they are logged server-side.
 */
export function classifyBacktestError(error: unknown): BacktestSafeError {
  if (error instanceof BacktestValidationError) {
    const reason: BacktestFailureReason = error.code === 'PROVIDER_TIMEOUT' || error.code === 'BACKTEST_TIMEOUT'
      ? 'PROVIDER_TIMEOUT'
      : 'INVALID_REQUEST';
    return { status: 400, code: error.code, reason, message: error.message };
  }
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const name = error instanceof Error ? error.name : '';
  const causeCode = String((error as { cause?: { code?: unknown } } | null)?.cause?.code ?? (error as { code?: unknown } | null)?.code ?? '');
  const label = providerLabel(raw);
  const httpStatus = Number(/_HTTP_(\d{3})\b/u.exec(raw)?.[1] ?? Number.NaN);

  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 451) {
    return { status: 502, code: 'PROVIDER_BLOCKED', reason: 'PROVIDER_BLOCKED',
      message: `${label} 제공기관이 서버 요청을 차단했습니다(HTTP ${httpStatus}). 잠시 후 다시 시도하거나 다른 시장을 선택해 주세요.` };
  }
  if (httpStatus === 429 || (error instanceof ProviderError && error.code === 'RATE_LIMITED')) {
    return { status: 503, code: 'PROVIDER_RATE_LIMITED', reason: 'PROVIDER_RATE_LIMITED',
      message: `${label} 제공기관의 요청 한도를 초과했습니다. 1~2분 뒤 다시 시도해 주세요.` };
  }
  if (name === 'AbortError' || name === 'TimeoutError' || causeCode === 'ETIMEDOUT' || causeCode === 'UND_ERR_CONNECT_TIMEOUT' || /TIMEOUT/iu.test(raw)) {
    return { status: 504, code: 'PROVIDER_TIMEOUT', reason: 'PROVIDER_TIMEOUT',
      message: `${label} 제공기관 응답 시간이 초과되었습니다. 기간을 줄이거나 잠시 후 다시 시도해 주세요.` };
  }
  if (Number.isFinite(httpStatus) || error instanceof ProviderError) {
    return { status: 502, code: 'PROVIDER_UNAVAILABLE', reason: 'PROVIDER_UNAVAILABLE',
      message: `${label} 제공기관에서 캔들을 받지 못했습니다. 잠시 후 다시 시도해 주세요.` };
  }
  if (/INVALID_RESPONSE/u.test(raw)) {
    return { status: 502, code: 'PROVIDER_INVALID_RESPONSE', reason: 'PROVIDER_INVALID_RESPONSE',
      message: `${label} 제공기관 응답 형식이 올바르지 않아 실행을 중단했습니다.` };
  }
  if (/^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET)$/u.test(causeCode) || (name === 'TypeError' && /fetch failed/iu.test(raw))) {
    return { status: 502, code: 'PROVIDER_NETWORK', reason: 'PROVIDER_NETWORK',
      message: `${label} 제공기관에 연결하지 못했습니다. 서버 네트워크 상태를 확인한 뒤 다시 시도해 주세요.` };
  }
  return { status: 500, code: 'BACKTEST_EXECUTION_FAILED', reason: 'INTERNAL',
    message: '백테스트 계산 중 내부 오류가 발생했습니다. 같은 오류가 반복되면 관리자에게 알려 주세요.' };
}

async function withTimeout<T>(promise: Promise<T>, controller: AbortController) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new BacktestValidationError('BACKTEST_TIMEOUT', '백테스트 실행 시간이 초과되었습니다.'));
        }, EXECUTION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function attachAbort(req: Request, controller: AbortController) {
  const abort = () => controller.abort();
  req.once('aborted', abort);
  return () => req.off('aborted', abort);
}

export function createBacktestsRouter(dependencies: Partial<BacktestDependencies> = {}): IRouter {
  const router: IRouter = Router();
  const deps: BacktestDependencies = {
    loadCandles: dependencies.loadCandles ?? loadHistoricalBacktestCandles,
    loadContractRules: dependencies.loadContractRules ?? getFuturesContractRules,
    execute: dependencies.execute ?? runBacktest,
    researchCodeSha: dependencies.researchCodeSha ?? (() => String(process.env.DEPLOY_SHA ?? '').trim().toLowerCase()),
    sourceRegistry: dependencies.sourceRegistry ?? productPaperSourceRegistry,
  };

  router.post('/backtests/run', async (req, res) => {
    const declaredLength = Number(req.header('content-length') ?? 0);
    if ((Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) || serializedSize(req.body) > MAX_REQUEST_BYTES) {
      return res.status(413).json({ ok: false, mode: 'backtest-only', orderSubmitted: false, code: 'REQUEST_TOO_LARGE', message: '백테스트 요청 크기가 제한을 초과했습니다.' });
    }
    if (activeExecutions >= MAX_CONCURRENT_EXECUTIONS) {
      return res.status(429).json({ ok: false, mode: 'backtest-only', orderSubmitted: false, code: 'BACKTEST_BUSY', message: '동시에 실행 가능한 백테스트 수를 초과했습니다.' });
    }

    const controller = new AbortController();
    let acceptedRequestForHandoff: BacktestRequest | null = null;
    let acceptedStrategyIdentityInputs: Readonly<Record<string, BacktestPaperCanonicalStrategyInput>> = {};
    const detachAbort = attachAbort(req, controller);
    activeExecutions += 1;
    try {
      const request = parseRequest(req.body);
      const execution = (async () => {
        const [history, rules] = await Promise.all([
          deps.loadCandles({ market: request.market, symbol: request.symbol, timeframe: request.timeframe, startTime: request.startTime, endTime: request.endTime, signal: controller.signal }),
          request.market === 'crypto-futures' ? deps.loadContractRules(request.symbol) : Promise.resolve({ symbol: request.symbol, quantityStep: null, quantityPrecision: null, minimumQuantity: null, minimumNotional: null, maximumLeverage: 1, maintenanceMarginRate: null, status: 'live' as const, updatedAt: new Date().toISOString(), warnings: [] as string[] }),
        ]);
        const started = performance.now();
        const acceptedRequest: BacktestRequest = {
          ...request,
          quantityStep: rules.quantityStep,
          quantityPrecision: rules.quantityPrecision,
          minimumQuantity: rules.minimumQuantity,
          minimumNotional: rules.minimumNotional,
          maximumLeverage: rules.maximumLeverage,
          contractRulesStatus: rules.status,
        };
        const result = deps.execute(acceptedRequest, history.candles);
        const paperHandoffBundle = buildBacktestPaperHandoffBundle(acceptedRequest, history.candles, deps.researchCodeSha());
        acceptedRequestForHandoff = acceptedRequest;
        acceptedStrategyIdentityInputs = paperHandoffBundle.strategyIdentityInputs;
        result.paperHandoffs = paperHandoffBundle.handoffs;
        const runs = recordSelectionRun((req as AuthenticatedRequest).member?.id ?? `ip:${req.ip ?? ''}`, acceptedRequest);
        result.selectionBias = evaluateSelectionBias(runs, result.sharpeRatio, acceptedRequest.startTime, acceptedRequest.endTime);
        const biasWarning = selectionBiasWarning(result.selectionBias);
        if (biasWarning) result.warnings = [...result.warnings, biasWarning];
        const executionMs = performance.now() - started;
        result.warnings = [...new Set([...history.warnings, ...rules.warnings, ...result.warnings, `과거 캔들 제공자 요청 ${history.requestCount}회, 순수 계산 ${executionMs.toFixed(1)}ms`])];
        return result;
      })();
      const result = await withTimeout(execution, controller);
      if (controller.signal.aborted) throw new BacktestValidationError('BACKTEST_ABORTED', '백테스트 요청이 취소되었습니다.');
      const runReference = acceptedRequestForHandoff && deps.sourceRegistry.captureBacktest(
        (req as AuthenticatedRequest).member?.id ?? '', acceptedRequestForHandoff,
        result.paperHandoffs ?? [], deps.researchCodeSha(), acceptedStrategyIdentityInputs,
      );
      if (runReference) result.paperHandoffRunId = runReference;
      return res.json({
        ok: true,
        mode: 'backtest-only',
        orderSubmitted: false,
        limits: { maximumCandles: BACKTEST_LIMITS.maximumCandles, maximumDurationMs: BACKTEST_LIMITS.maximumDurationMs, timeoutMs: EXECUTION_TIMEOUT_MS },
        result,
      });
    } catch (error) {
      const safe = classifyBacktestError(error);
      if (safe.reason !== 'INVALID_REQUEST') {
        logger.warn({
          event: 'backtest_run_failed',
          code: safe.code,
          reason: safe.reason,
          market: isObject(req.body) ? String(req.body.market ?? '') : '',
          symbol: isObject(req.body) ? String(req.body.symbol ?? '').slice(0, 32) : '',
          timeframe: isObject(req.body) ? String(req.body.timeframe ?? '') : '',
          err: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
        }, 'backtest run failed');
      }
      return res.status(safe.status).json({ ok: false, mode: 'backtest-only', orderSubmitted: false, code: safe.code, reason: safe.reason, message: safe.message });
    } finally {
      activeExecutions = Math.max(0, activeExecutions - 1);
      detachAbort();
    }
  });

  router.post('/backtests/paper/validate', requireAdmin, (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const safety = { mode: 'paper-only', executionAuthority: 'NONE', evidenceCredit: 0,
      orderSubmitted: false, exchangeRequestSent: false, privateTradingApiAllowed: false };
    if (serializedSize(req.body) > MAX_REQUEST_BYTES) return res.status(413).json({ ok: false, code: 'REQUEST_TOO_LARGE', ...safety });
    try {
      const source = deps.sourceRegistry.resolveBacktest(req.member!.id, req.body, deps.researchCodeSha());
      return res.status(503).json({ ok: false, code: 'CANONICAL_STRATEGY_PAPER_CONSUMER_UNAVAILABLE',
        sourceValidated: true, executionConnected: false, backtestCandidate: source.handoff,
        researchFrozenCandidateProven: false, validationReceiptProven: false, ...safety });
    } catch (error) {
      return res.status(error instanceof ProductPaperSourceError ? error.status : 400).json({ ok: false,
        code: error instanceof ProductPaperSourceError ? error.code : 'BACKTEST_PAPER_SOURCE_INVALID', ...safety });
    }
  });

  return router;
}

const router = createBacktestsRouter();
export default router;
export function resetBacktestRouteStateForTests() { activeExecutions = 0; resetSelectionRunsForTests(); }
