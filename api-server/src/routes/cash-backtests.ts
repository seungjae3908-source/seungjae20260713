import { Router, type IRouter } from 'express';
import { runCashMarketBacktest, type CashMarketBacktestInput } from '../services/cash-market-backtest.service';
import { BacktestMarketContractError, isBacktestMarket } from '../services/backtest-market-profile.service';

const MAX_REQUEST_BYTES = 64 * 1024;
const EXECUTION_TIMEOUT_MS = 25_000;
const MAX_CONCURRENT_EXECUTIONS = 2;
let activeExecutions = 0;

type CashBacktestDependencies = {
  execute: typeof runCashMarketBacktest;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(body: Record<string, unknown>, key: string, fallback?: number) {
  const value = body[key];
  if (value == null && fallback != null) return fallback;
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

function parseRequest(body: unknown): CashMarketBacktestInput {
  if (!isObject(body)) throw new BacktestMarketContractError('INVALID_REQUEST', 'JSON 요청 본문이 필요합니다.');
  if (!isBacktestMarket(body.market) || body.market === 'crypto-futures') {
    throw new BacktestMarketContractError('INVALID_CASH_MARKET', '현물 백테스트 시장은 kr-stock, us-stock, crypto-spot 중 하나여야 합니다.');
  }
  const strategy = String(body.strategy ?? '');
  if (!['trend_pullback', 'breakout', 'vwap_reclaim'].includes(strategy)) {
    throw new BacktestMarketContractError('UNSUPPORTED_STRATEGY', '지원하지 않는 현물 백테스트 전략입니다.');
  }
  const parameters: Record<string, number> = {};
  if (isObject(body.parameters)) {
    for (const [key, value] of Object.entries(body.parameters)) {
      if (typeof value === 'number' && Number.isFinite(value)) parameters[key] = value;
    }
  }
  const request: CashMarketBacktestInput = {
    market: body.market,
    symbol: String(body.symbol ?? ''),
    timeframe: String(body.timeframe ?? '15m'),
    startTime: finiteNumber(body, 'startTime'),
    endTime: finiteNumber(body, 'endTime'),
    initialCapital: finiteNumber(body, 'initialCapital'),
    strategy: strategy as CashMarketBacktestInput['strategy'],
    parameters,
    riskPercent: finiteNumber(body, 'riskPercent'),
    entryFeeRate: finiteNumber(body, 'entryFeeRate'),
    exitFeeRate: finiteNumber(body, 'exitFeeRate'),
    slippageRate: finiteNumber(body, 'slippageRate'),
    stopLossPercent: finiteNumber(body, 'stopLossPercent'),
    takeProfitR: finiteNumber(body, 'takeProfitR'),
    maximumTradesPerDay: finiteNumber(body, 'maximumTradesPerDay', 10),
    intrabarPriority: String(body.intrabarPriority ?? 'stop_first') as CashMarketBacktestInput['intrabarPriority'],
  };
  if (!Number.isFinite(request.startTime) || !Number.isFinite(request.endTime) || request.startTime >= request.endTime) {
    throw new BacktestMarketContractError('INVALID_PERIOD', '백테스트 기간이 올바르지 않습니다.');
  }
  if (!Number.isFinite(request.initialCapital) || request.initialCapital <= 0) {
    throw new BacktestMarketContractError('INVALID_CAPITAL', '초기 자본은 0보다 커야 합니다.');
  }
  if (!Number.isFinite(request.riskPercent) || request.riskPercent <= 0 || request.riskPercent > 1) {
    throw new BacktestMarketContractError('INVALID_RISK_PERCENT', '거래당 위험률은 0% 초과 1% 이하여야 합니다.');
  }
  for (const rate of [request.entryFeeRate, request.exitFeeRate, request.slippageRate]) {
    if (!Number.isFinite(rate) || rate < 0 || rate >= 1) {
      throw new BacktestMarketContractError('INVALID_COST_RATE', '수수료와 슬리피지 비율이 올바르지 않습니다.');
    }
  }
  if (!Number.isFinite(request.stopLossPercent) || request.stopLossPercent <= 0) {
    throw new BacktestMarketContractError('INVALID_STOP_LOSS', '손절률은 0보다 커야 합니다.');
  }
  if (!Number.isFinite(request.takeProfitR) || request.takeProfitR <= 0) {
    throw new BacktestMarketContractError('INVALID_TAKE_PROFIT', '목표 R은 0보다 커야 합니다.');
  }
  if (!Number.isInteger(request.maximumTradesPerDay) || request.maximumTradesPerDay < 1 || request.maximumTradesPerDay > 100) {
    throw new BacktestMarketContractError('INVALID_DAILY_TRADES', '일일 거래 수 제한은 1~100이어야 합니다.');
  }
  if (!['stop_first', 'target_first'].includes(request.intrabarPriority ?? 'stop_first')) {
    throw new BacktestMarketContractError('INVALID_INTRABAR_PRIORITY', '봉 내부 체결 우선순위가 올바르지 않습니다.');
  }
  return request;
}

function serializedSize(body: unknown) {
  try { return Buffer.byteLength(JSON.stringify(body ?? null), 'utf8'); }
  catch { return MAX_REQUEST_BYTES + 1; }
}

function safeError(error: unknown) {
  if (error instanceof BacktestMarketContractError) return { status: 400, code: error.code, message: error.message };
  return { status: 500, code: 'CASH_BACKTEST_EXECUTION_FAILED', message: '현물 백테스트를 완료하지 못했습니다.' };
}

async function withTimeout<T>(promise: Promise<T>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new BacktestMarketContractError('BACKTEST_TIMEOUT', '백테스트 실행 시간이 초과되었습니다.')), EXECUTION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createCashBacktestsRouter(dependencies: Partial<CashBacktestDependencies> = {}): IRouter {
  const router: IRouter = Router();
  const execute = dependencies.execute ?? runCashMarketBacktest;
  router.post('/backtests/cash/run', async (req, res) => {
    if (serializedSize(req.body) > MAX_REQUEST_BYTES) {
      return res.status(413).json({ ok: false, mode: 'backtest-only', orderSubmitted: false, code: 'REQUEST_TOO_LARGE', message: '백테스트 요청 크기가 제한을 초과했습니다.' });
    }
    if (activeExecutions >= MAX_CONCURRENT_EXECUTIONS) {
      return res.status(429).json({ ok: false, mode: 'backtest-only', orderSubmitted: false, code: 'BACKTEST_BUSY', message: '동시에 실행 가능한 백테스트 수를 초과했습니다.' });
    }
    activeExecutions += 1;
    try {
      const request = parseRequest(req.body);
      const result = await withTimeout(execute(request));
      return res.json(result);
    } catch (error) {
      const safe = safeError(error);
      return res.status(safe.status).json({ ok: false, mode: 'backtest-only', orderSubmitted: false, code: safe.code, message: safe.message });
    } finally {
      activeExecutions = Math.max(0, activeExecutions - 1);
    }
  });
  return router;
}

const router = createCashBacktestsRouter();
export default router;
export function resetCashBacktestRouteStateForTests() { activeExecutions = 0; }
