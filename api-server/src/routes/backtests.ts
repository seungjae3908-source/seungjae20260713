import { Router, type IRouter, type Request } from 'express';
import {
  BACKTEST_LIMITS,
  BacktestValidationError,
  runBacktest,
  validateBacktestRequest,
  type BacktestRequest,
} from '../services/backtest-engine.service';
import { loadHistoricalBacktestCandles } from '../services/backtest-data.service';
import { getFuturesContractRules } from '../services/futures-contract-rules.service';

const MAX_REQUEST_BYTES = 64 * 1024;
const EXECUTION_TIMEOUT_MS = 25_000;
const MAX_CONCURRENT_EXECUTIONS = 2;
let activeExecutions = 0;

type BacktestDependencies = {
  loadCandles: typeof loadHistoricalBacktestCandles;
  loadContractRules: typeof getFuturesContractRules;
  execute: typeof runBacktest;
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
  const parameters = isObject(body.parameters)
    ? Object.fromEntries(Object.entries(body.parameters).filter(([, value]) => typeof value === 'number' || typeof value === 'boolean'))
    : {};
  const trailingInput = isObject(body.trailingStop) ? body.trailingStop : null;
  const splitInput = isObject(body.validationSplit) ? body.validationSplit : null;
  const request: BacktestRequest = {
    market: String(body.market ?? '') as BacktestRequest['market'],
    symbol: String(body.symbol ?? '').trim().toUpperCase(),
    timeframe: String(body.timeframe ?? '15m'),
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

function safeError(error: unknown) {
  if (error instanceof BacktestValidationError) return { status: 400, code: error.code, message: error.message };
  return { status: 500, code: 'BACKTEST_EXECUTION_FAILED', message: '백테스트를 완료하지 못했습니다.' };
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
    const detachAbort = attachAbort(req, controller);
    activeExecutions += 1;
    try {
      const request = parseRequest(req.body);
      const execution = (async () => {
        const [history, rules] = await Promise.all([
          deps.loadCandles({ symbol: request.symbol, timeframe: request.timeframe, startTime: request.startTime, endTime: request.endTime, signal: controller.signal }),
          deps.loadContractRules(request.symbol),
        ]);
        const started = performance.now();
        const result = deps.execute({
          ...request,
          quantityStep: rules.quantityStep,
          quantityPrecision: rules.quantityPrecision,
          minimumQuantity: rules.minimumQuantity,
          minimumNotional: rules.minimumNotional,
          maximumLeverage: rules.maximumLeverage,
          contractRulesStatus: rules.status,
        }, history.candles);
        const executionMs = performance.now() - started;
        result.warnings = [...new Set([...history.warnings, ...rules.warnings, ...result.warnings, `과거 캔들 제공자 요청 ${history.requestCount}회, 순수 계산 ${executionMs.toFixed(1)}ms`])];
        return result;
      })();
      const result = await withTimeout(execution, controller);
      return res.json({
        ok: true,
        mode: 'backtest-only',
        orderSubmitted: false,
        limits: { maximumCandles: BACKTEST_LIMITS.maximumCandles, maximumDurationMs: BACKTEST_LIMITS.maximumDurationMs, timeoutMs: EXECUTION_TIMEOUT_MS },
        result,
      });
    } catch (error) {
      const safe = safeError(error);
      return res.status(safe.status).json({ ok: false, mode: 'backtest-only', orderSubmitted: false, code: safe.code, message: safe.message });
    } finally {
      activeExecutions = Math.max(0, activeExecutions - 1);
      detachAbort();
    }
  });

  return router;
}

const router = createBacktestsRouter();
export default router;
export function resetBacktestRouteStateForTests() { activeExecutions = 0; }
