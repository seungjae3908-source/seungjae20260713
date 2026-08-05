export type BacktestMarket = 'kr-stock' | 'us-stock' | 'crypto-spot' | 'crypto-futures';
export type BacktestTradeAction = 'BUY' | 'SELL' | 'LONG' | 'SHORT';
export type BacktestPositionIntent = 'OPEN_OR_ADD' | 'REDUCE_OR_EXIT';

export type BacktestMarketProfile = Readonly<{
  market: BacktestMarket;
  allowedActions: readonly BacktestTradeAction[];
  openingActions: readonly BacktestTradeAction[];
  closingActions: readonly BacktestTradeAction[];
  maximumLeverage: number;
  fundingApplicable: boolean;
  shortOpeningAllowed: boolean;
  defaultRiskPercent: number;
}>;

export const BACKTEST_MARKET_PROFILES: Readonly<Record<BacktestMarket, BacktestMarketProfile>> = Object.freeze({
  'kr-stock': Object.freeze({
    market: 'kr-stock',
    allowedActions: Object.freeze(['BUY', 'SELL'] as const),
    openingActions: Object.freeze(['BUY'] as const),
    closingActions: Object.freeze(['SELL'] as const),
    maximumLeverage: 1,
    fundingApplicable: false,
    shortOpeningAllowed: false,
    defaultRiskPercent: 0.25,
  }),
  'us-stock': Object.freeze({
    market: 'us-stock',
    allowedActions: Object.freeze(['BUY', 'SELL'] as const),
    openingActions: Object.freeze(['BUY'] as const),
    closingActions: Object.freeze(['SELL'] as const),
    maximumLeverage: 1,
    fundingApplicable: false,
    shortOpeningAllowed: false,
    defaultRiskPercent: 0.25,
  }),
  'crypto-spot': Object.freeze({
    market: 'crypto-spot',
    allowedActions: Object.freeze(['BUY', 'SELL'] as const),
    openingActions: Object.freeze(['BUY'] as const),
    closingActions: Object.freeze(['SELL'] as const),
    maximumLeverage: 1,
    fundingApplicable: false,
    shortOpeningAllowed: false,
    defaultRiskPercent: 0.2,
  }),
  'crypto-futures': Object.freeze({
    market: 'crypto-futures',
    allowedActions: Object.freeze(['LONG', 'SHORT'] as const),
    openingActions: Object.freeze(['LONG', 'SHORT'] as const),
    closingActions: Object.freeze([] as const),
    maximumLeverage: 10,
    fundingApplicable: true,
    shortOpeningAllowed: true,
    defaultRiskPercent: 0.1,
  }),
});

export class BacktestMarketContractError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BacktestMarketContractError';
  }
}

export function isBacktestMarket(value: unknown): value is BacktestMarket {
  return typeof value === 'string' && Object.hasOwn(BACKTEST_MARKET_PROFILES, value);
}

export function normalizeBacktestSymbol(market: BacktestMarket, input: unknown): string {
  const symbol = String(input ?? '').trim().toUpperCase();
  if (market === 'kr-stock') {
    if (!/^\d{6}$/.test(symbol)) throw new BacktestMarketContractError('INVALID_KR_STOCK_SYMBOL', '국내주식 종목코드는 6자리 숫자여야 합니다.');
    return symbol;
  }
  if (market === 'us-stock') {
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) throw new BacktestMarketContractError('INVALID_US_STOCK_SYMBOL', '미국주식 티커 형식이 올바르지 않습니다.');
    return symbol;
  }
  if (market === 'crypto-spot') {
    const normalized = symbol.replace('/', '-');
    if (!/^(KRW|USDT|BTC)-[A-Z0-9]{2,15}$/.test(normalized)) throw new BacktestMarketContractError('INVALID_SPOT_SYMBOL', '코인 현물 종목은 KRW-BTC와 같은 형식이어야 합니다.');
    return normalized;
  }
  const normalized = symbol.replace(/[-_/]/g, '');
  if (!/^[A-Z0-9]{2,16}USDT$/.test(normalized)) throw new BacktestMarketContractError('INVALID_FUTURES_SYMBOL', '코인 선물 종목은 BTCUSDT와 같은 형식이어야 합니다.');
  return normalized;
}

export function resolveBacktestIntent(action: BacktestTradeAction): BacktestPositionIntent {
  return action === 'SELL' ? 'REDUCE_OR_EXIT' : 'OPEN_OR_ADD';
}

export function validateBacktestMarketOrder(input: {
  market: BacktestMarket;
  action: BacktestTradeAction;
  leverage: number;
  hasOpenPosition?: boolean;
  fundingRatePerInterval?: number;
}): BacktestPositionIntent {
  const profile = BACKTEST_MARKET_PROFILES[input.market];
  if (!profile.allowedActions.includes(input.action)) {
    throw new BacktestMarketContractError('ACTION_NOT_ALLOWED', `${input.market}에서 ${input.action} 방향은 허용되지 않습니다.`);
  }
  if (!Number.isFinite(input.leverage) || input.leverage < 1 || input.leverage > profile.maximumLeverage) {
    throw new BacktestMarketContractError('INVALID_MARKET_LEVERAGE', `${input.market} 레버리지는 1배 이상 ${profile.maximumLeverage}배 이하여야 합니다.`);
  }
  if (profile.closingActions.includes(input.action) && !input.hasOpenPosition) {
    throw new BacktestMarketContractError('CASH_SELL_WITHOUT_POSITION', '주식·현물 SELL은 보유분 축소 또는 청산에만 사용할 수 있습니다.');
  }
  if (!profile.fundingApplicable && input.fundingRatePerInterval != null && input.fundingRatePerInterval !== 0) {
    throw new BacktestMarketContractError('FUNDING_NOT_APPLICABLE', '주식·현물 백테스트에는 펀딩비를 적용할 수 없습니다.');
  }
  return resolveBacktestIntent(input.action);
}

export function buildBacktestPerformanceKey(input: {
  market: BacktestMarket;
  strategy: string;
  timeframe: string;
  action: BacktestTradeAction;
  regime: string;
  modelVersion?: string;
}): string {
  return [
    input.market,
    input.strategy || 'unspecified',
    input.timeframe || 'unspecified',
    input.action,
    input.regime || 'unclassified',
    input.modelVersion || 'backtest-market-v1',
  ].join('|');
}
