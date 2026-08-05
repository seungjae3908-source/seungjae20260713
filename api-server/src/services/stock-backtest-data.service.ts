import { getCandles } from '../providers/yahoo';
import type { CashBacktestCandle } from './cash-backtest-engine.service';
import { BacktestMarketContractError, normalizeBacktestSymbol } from './backtest-market-profile.service';

const MAX_CANDLES = 20_000;
const SUPPORTED_TIMEFRAMES = new Set(['1m', '5m', '15m', '30m', '60m', '1H', '1D', '1W', '1M']);

export async function loadStockBacktestCandles(input: {
  market: 'kr-stock' | 'us-stock';
  symbol: unknown;
  timeframe: string;
  startTime: number;
  endTime: number;
  loadCandlesImpl?: typeof getCandles;
}) {
  const symbol = normalizeBacktestSymbol(input.market, input.symbol);
  if (!SUPPORTED_TIMEFRAMES.has(input.timeframe)) {
    throw new BacktestMarketContractError('STOCK_UNSUPPORTED_TIMEFRAME', `주식 백테스트에서 ${input.timeframe} 시간봉은 지원하지 않습니다.`);
  }
  if (!Number.isFinite(input.startTime) || !Number.isFinite(input.endTime) || input.startTime >= input.endTime) {
    throw new BacktestMarketContractError('INVALID_PERIOD', '주식 백테스트 기간이 올바르지 않습니다.');
  }
  const rows = await (input.loadCandlesImpl ?? getCandles)(symbol, input.timeframe);
  const byTimestamp = new Map<number, CashBacktestCandle>();
  for (const row of rows) {
    const timestamp = typeof row.time === 'number' ? row.time : Date.parse(String(row.time));
    if (!Number.isFinite(timestamp) || timestamp < input.startTime || timestamp > input.endTime) continue;
    if (![row.open, row.high, row.low, row.close, row.volume].every((value) => typeof value === 'number' && Number.isFinite(value))) continue;
    if (row.open <= 0 || row.high <= 0 || row.low <= 0 || row.close <= 0 || row.volume < 0) continue;
    byTimestamp.set(timestamp, {
      timestamp,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      quoteVolume: row.close * row.volume,
      timeframe: input.timeframe,
      symbol,
      market: input.market,
      source: 'yahoo',
      isClosed: true,
    });
  }
  const candles = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  if (candles.length > MAX_CANDLES) throw new BacktestMarketContractError('CANDLE_LIMIT_EXCEEDED', '주식 백테스트 캔들 수가 상한을 초과했습니다.');
  const warnings: string[] = [];
  if (!candles.length) warnings.push('요청 기간에 사용할 수 있는 완료된 주식 캔들이 없습니다.');
  if (input.market === 'kr-stock') warnings.push('국내주식 Yahoo 심볼 매핑은 현재 KOSPI 기본 경로를 사용하며 KOSDAQ 종목은 공급자 보강이 필요할 수 있습니다.');
  return { candles, warnings, provider: 'yahoo' as const, orderSubmitted: false as const };
}
