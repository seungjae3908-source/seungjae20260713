import { createHash } from 'node:crypto';
import { PaperJournalError } from './paper-journal.types';

export const JOURNAL_INTEGRATION_BASE_SHA = '868734a1ef2120cdafebb4a518ba8dd0a7d40e0f' as const;
export const TOSS_OPENAPI_SPEC_VERSION = '1.2.14' as const;
export const TOSS_LIVE_READ_INTEGRATION = 'MEMBER_CONFIGURED_READ_ONLY' as const;
export const TOSS_CONTRACT_PREVIEW_DISABLED = 'TOSS_CONTRACT_PREVIEW_DISABLED' as const;
export const AI_EXTERNAL_REVIEW_STATUS = 'AI_EXTERNAL_REVIEW_DISABLED_FREE_ONLY' as const;
export const PAID_STATUS = 'PAID_STATUS_UNVERIFIED' as const;

export const JOURNAL_COST_SAFETY = Object.freeze({
  paidApiKeyRequired: false,
  paidServiceActivation: false,
  replitPaidDeploy: false,
  replitAgentPaidAction: false,
  serverUpgrade: false,
  databaseUpgrade: false,
  finalCostDelta: '0_KRW',
  actualOrderRequests: 0,
  cancelRequests: 0,
  amendRequests: 0,
  transferRequests: 0,
  withdrawalRequests: 0,
  privateBrokerRequests: 0,
});

export const TRADE_SOURCES = [
  'TOSS_MANUAL',
  'TOSS_API',
  'KIWOOM_API',
  'UPBIT_API',
  'BITGET_API',
  'APP_PAPER',
  'APP_SHADOW',
  'APP_AUTO',
] as const;
export const TRADE_MARKETS = ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'] as const;
export const TRADE_RANGES = ['TODAY', '7D', '30D', '90D', '1Y', 'ALL'] as const;
export const TRADE_BROKERS = ['TOSS', 'KIWOOM', 'UPBIT', 'BITGET', 'APP', 'MANUAL'] as const;

export type TradeSource = typeof TRADE_SOURCES[number];
export type TradeMarket = typeof TRADE_MARKETS[number];
export type TradeRange = typeof TRADE_RANGES[number];
export type TradeBroker = typeof TRADE_BROKERS[number];
export type TradeCurrency = 'KRW' | 'USD' | 'USDT';
export type CanonicalOrderStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'UNKNOWN';
export type SnapshotContextSource = 'PRE_TRADE_SNAPSHOT' | 'POST_HOC_RECONSTRUCTION' | 'NO_PRE_TRADE_CONTEXT';

export type TechnicalSnapshot = Readonly<{
  snapshotId: string;
  contextSource: SnapshotContextSource;
  capturedAt: string | null;
  timeframe: string | null;
  price: number | null;
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  movingAverageFast: number | null;
  movingAverageSlow: number | null;
  support: number | null;
  resistance: number | null;
  volumeRatio: number | null;
  volatilityPercent: number | null;
  signalScore: number | null;
  marketRegime: string | null;
  marketStructure: string | null;
  signalReasons: readonly string[];
}>;

export type UnifiedTradeOrder = {
  schemaVersion: 1;
  recordType: 'unified_trade_order';
  source: TradeSource;
  broker: TradeBroker;
  accountIdMasked: string;
  market: TradeMarket;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT' | null;
  positionEffect: 'OPEN' | 'CLOSE' | null;
  clientOrderId: string | null;
  brokerOrderId: string;
  fillId: string | null;
  executionKey: string;
  idempotencyBasis: 'broker-fill-id' | 'aggregate-cumulative';
  orderedAt: string;
  filledAt: string | null;
  observedAt: string;
  quantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  averageFillPrice: number | null;
  fees: number;
  tax: number;
  currency: TradeCurrency;
  status: CanonicalOrderStatus;
  strategy: string | null;
  timeframe: string | null;
  stopLossPrice: number | null;
  targetPrice: number | null;
  ruleViolation: boolean;
  warnings: string[];
  technicalSnapshot: TechnicalSnapshot;
};

export type TossOrderContract = {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: string;
  timeInForce: string;
  status: string;
  price: string | null;
  quantity: string;
  orderAmount: string | null;
  currency: 'KRW' | 'USD';
  orderedAt: string;
  canceledAt: string | null;
  execution: {
    filledQuantity: string;
    averageFilledPrice: string | null;
    filledAmount: string | null;
    commission: string | null;
    tax: string | null;
    filledAt: string | null;
    settlementDate: string | null;
  };
};

export type TradeLeg = {
  orderId: string;
  at: string;
  price: number;
  quantity: number;
  fees: number;
  tax: number;
};

export type TradeReview = {
  performanceScore: number;
  qualityScore: number;
  grade: 'A' | 'B' | 'C' | 'D';
  good: string[];
  bad: string[];
  improvements: string[];
  mistakes: string[];
  deterministic: true;
  externalAiCalled: false;
};

export type UnifiedTradeCycle = {
  id: string;
  source: TradeSource;
  broker: UnifiedTradeOrder['broker'];
  accountIdMasked: string;
  market: TradeMarket;
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  currency: TradeCurrency;
  status: 'OPEN' | 'CLOSED';
  openedAt: string;
  closedAt: string | null;
  entryPrice: number;
  exitPrice: number | null;
  initialEntry: TradeLeg;
  additions: TradeLeg[];
  partialExits: TradeLeg[];
  finalExit: TradeLeg | null;
  totalQuantity: number;
  closedQuantity: number;
  remainingQuantity: number;
  holdingTimeMs: number | null;
  grossPnl: number;
  fees: number;
  tax: number;
  netPnl: number;
  netReturnPercent: number | null;
  strategy: string | null;
  timeframe: string | null;
  stopLossPrice: number | null;
  targetPrice: number | null;
  ruleViolation: boolean;
  warnings: string[];
  technicalSnapshot: TechnicalSnapshot;
  review: TradeReview;
};

export type JournalIntegrityIssue = {
  code: string;
  orderId: string | null;
  message: string;
};

export type UnifiedJournalFilters = {
  range?: TradeRange;
  market?: TradeMarket | 'ALL';
  source?: TradeSource | 'ALL';
  broker?: TradeBroker | 'ALL';
  account?: string | null;
  strategy?: string | null;
  timeframe?: string | null;
  grade?: TradeReview['grade'] | 'ALL';
};

type CurrencyMetric = { currency: TradeCurrency; value: number };
type GroupMetric = { key: string; sampleSize: number; winRate: number | null; averageReturnPercent: number | null };

export type UnifiedJournalAnalytics = {
  sampleSize: number;
  openTrades: number;
  closedTrades: number;
  winRate: number | null;
  profitFactor: number | null;
  averageReturnPercent: number | null;
  maximumConsecutiveLosses: number;
  netPnlByCurrency: CurrencyMetric[];
  totalCostsByCurrency: CurrencyMetric[];
  byMarket: GroupMetric[];
  bySource: GroupMetric[];
  byStrategy: GroupMetric[];
  byTimeframe: GroupMetric[];
  byGrade: GroupMetric[];
  mistakes: Array<{ code: string; count: number }>;
  monthlyReport: Array<{ month: string; sampleSize: number; winRate: number | null; averageReturnPercent: number | null; netPnlByCurrency: CurrencyMetric[] }>;
  warnings: string[];
};

export type UnifiedTradeJournalResult = {
  integrationBaseSha: typeof JOURNAL_INTEGRATION_BASE_SHA;
  generatedAt: string;
  trades: UnifiedTradeCycle[];
  analytics: UnifiedJournalAnalytics;
  integrityIssues: JournalIntegrityIssue[];
  toss: ReturnType<typeof tossJournalIntegrationStatus>;
  aiReviewStatus: typeof AI_EXTERNAL_REVIEW_STATUS;
  safety: typeof JOURNAL_COST_SAFETY;
};

const TERMINAL = new Set<CanonicalOrderStatus>(['FILLED', 'CANCELED', 'REJECTED']);
const EPSILON = 1e-10;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function nonNegativeDecimal(value: unknown, field: string): number;
function nonNegativeDecimal(value: unknown, field: string, nullable: true): number | null;
function nonNegativeDecimal(value: unknown, field: string, nullable = false): number | null {
  if (nullable && value == null) return null;
  const parsed = finite(value);
  if (parsed == null || parsed < 0) throw new PaperJournalError('INVALID_TRADE_DECIMAL', `${field} 값을 확인하세요.`);
  return parsed;
}

function isoDate(value: unknown, field: string): string;
function isoDate(value: unknown, field: string, nullable: true): string | null;
function isoDate(value: unknown, field: string, nullable = false): string | null {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new PaperJournalError('INVALID_TRADE_TIMESTAMP', `${field} 시각을 확인하세요.`);
  }
  return value;
}

function stringValue(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw new PaperJournalError('INVALID_TRADE_FIELD', `${field} 값을 확인하세요.`);
  return value.trim();
}

function hash(value: string, size = 16) {
  return createHash('sha256').update(value).digest('hex').slice(0, size);
}

export function maskBrokerAccountReference(broker: string, accountReference: string) {
  const normalized = stringValue(accountReference, 'accountReference');
  return `${broker.toUpperCase()}-****-${hash(`${broker}:${normalized}`, 10)}`;
}

function assertMaskedAccount(value: unknown) {
  const masked = stringValue(value, 'accountIdMasked');
  if (!masked.includes('****')) {
    throw new PaperJournalError('FULL_ACCOUNT_IDENTIFIER_FORBIDDEN', '전체 계좌 식별자는 저장할 수 없습니다.');
  }
  return masked;
}

function nullableText(value: unknown, max = 80) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function nullableFinite(value: unknown) {
  return finite(value);
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 160)).slice(0, 30)
    : [];
}

function deepFreezeSnapshot(snapshot: TechnicalSnapshot): TechnicalSnapshot {
  Object.freeze(snapshot.signalReasons);
  return Object.freeze(snapshot);
}

function technicalSnapshot(value: unknown, fallbackId: string): TechnicalSnapshot {
  if (!isObject(value)) {
    return deepFreezeSnapshot({
      snapshotId: `no-context:${hash(fallbackId)}`,
      contextSource: 'NO_PRE_TRADE_CONTEXT',
      capturedAt: null,
      timeframe: null,
      price: null,
      rsi: null,
      macd: null,
      macdSignal: null,
      movingAverageFast: null,
      movingAverageSlow: null,
      support: null,
      resistance: null,
      volumeRatio: null,
      volatilityPercent: null,
      signalScore: null,
      marketRegime: null,
      marketStructure: null,
      signalReasons: [],
    });
  }
  const contextSource = ['PRE_TRADE_SNAPSHOT', 'POST_HOC_RECONSTRUCTION'].includes(String(value.contextSource))
    ? value.contextSource as SnapshotContextSource
    : 'NO_PRE_TRADE_CONTEXT';
  if (contextSource === 'NO_PRE_TRADE_CONTEXT') return technicalSnapshot(null, fallbackId);
  return deepFreezeSnapshot({
    snapshotId: nullableText(value.snapshotId, 120) ?? `snapshot:${hash(fallbackId)}`,
    contextSource,
    capturedAt: typeof value.capturedAt === 'string' && Number.isFinite(Date.parse(value.capturedAt)) ? value.capturedAt : null,
    timeframe: nullableText(value.timeframe, 20),
    price: nullableFinite(value.price),
    rsi: nullableFinite(value.rsi),
    macd: nullableFinite(value.macd),
    macdSignal: nullableFinite(value.macdSignal),
    movingAverageFast: nullableFinite(value.movingAverageFast),
    movingAverageSlow: nullableFinite(value.movingAverageSlow),
    support: nullableFinite(value.support),
    resistance: nullableFinite(value.resistance),
    volumeRatio: nullableFinite(value.volumeRatio),
    volatilityPercent: nullableFinite(value.volatilityPercent),
    signalScore: nullableFinite(value.signalScore),
    marketRegime: nullableText(value.marketRegime, 80),
    marketStructure: nullableText(value.marketStructure, 80),
    signalReasons: stringArray(value.signalReasons),
  });
}

function tossStatus(value: string): CanonicalOrderStatus {
  const status = value.toUpperCase();
  if (status === 'PARTIAL_FILLED') return 'PARTIALLY_FILLED';
  if (['PENDING', 'PENDING_CANCEL', 'PENDING_REPLACE'].includes(status)) return 'OPEN';
  if (status === 'FILLED') return 'FILLED';
  if (['CANCELED', 'REPLACED'].includes(status)) return 'CANCELED';
  if (['REJECTED', 'CANCEL_REJECTED', 'REPLACE_REJECTED'].includes(status)) return 'REJECTED';
  return 'UNKNOWN';
}

export function normalizeTossOrderContract(
  value: TossOrderContract,
  accountReference: string,
  observedAt = new Date().toISOString(),
): UnifiedTradeOrder {
  if (!isObject(value) || !isObject(value.execution)) throw new PaperJournalError('TOSS_ORDER_CONTRACT_INVALID', 'Toss 주문 계약을 확인하세요.');
  const brokerOrderId = stringValue(value.orderId, 'orderId');
  const quantity = nonNegativeDecimal(value.quantity, 'quantity');
  if (quantity <= 0) throw new PaperJournalError('INVALID_TRADE_QUANTITY', '주문 수량은 0보다 커야 합니다.');
  const filledQuantity = nonNegativeDecimal(value.execution.filledQuantity, 'filledQuantity');
  if (filledQuantity > quantity + EPSILON) throw new PaperJournalError('FILLED_QUANTITY_EXCEEDED', '체결 수량이 주문 수량을 초과했습니다.');
  const filledAt = isoDate(value.execution.filledAt, 'filledAt', true);
  const averageFillPrice = nonNegativeDecimal(value.execution.averageFilledPrice, 'averageFilledPrice', true);
  if (filledQuantity > 0 && (averageFillPrice == null || filledAt == null)) {
    throw new PaperJournalError('TOSS_EXECUTION_INCOMPLETE', '체결된 주문의 평균가와 체결시각이 필요합니다.');
  }
  const currency = value.currency === 'KRW' || value.currency === 'USD' ? value.currency : null;
  if (!currency) throw new PaperJournalError('UNSUPPORTED_TOSS_CURRENCY', '지원하지 않는 Toss 주문 통화입니다.');
  const side = value.side === 'BUY' || value.side === 'SELL' ? value.side : null;
  if (!side) throw new PaperJournalError('UNSUPPORTED_TOSS_SIDE', '지원하지 않는 Toss 주문 방향입니다.');
  const executionKey = filledQuantity > 0
    ? `TOSS_AGGREGATE:${brokerOrderId}:${filledQuantity}:${filledAt}`
    : `TOSS_ORDER:${brokerOrderId}:UNFILLED`;
  return {
    schemaVersion: 1,
    recordType: 'unified_trade_order',
    source: 'TOSS_API',
    broker: 'TOSS',
    accountIdMasked: maskBrokerAccountReference('TOSS', accountReference),
    market: currency === 'KRW' ? 'KR_STOCK' : 'US_STOCK',
    symbol: stringValue(value.symbol, 'symbol').toUpperCase(),
    side,
    positionSide: 'LONG',
    positionEffect: side === 'BUY' ? 'OPEN' : 'CLOSE',
    clientOrderId: null,
    brokerOrderId,
    fillId: null,
    executionKey,
    idempotencyBasis: 'aggregate-cumulative',
    orderedAt: isoDate(value.orderedAt, 'orderedAt'),
    filledAt,
    observedAt: isoDate(observedAt, 'observedAt'),
    quantity,
    filledQuantity,
    remainingQuantity: Math.max(0, quantity - filledQuantity),
    averageFillPrice,
    fees: nonNegativeDecimal(value.execution.commission, 'commission', true) ?? 0,
    tax: nonNegativeDecimal(value.execution.tax, 'tax', true) ?? 0,
    currency,
    status: tossStatus(stringValue(value.status, 'status')),
    strategy: null,
    timeframe: null,
    stopLossPrice: null,
    targetPrice: null,
    ruleViolation: false,
    warnings: ['TOSS_ORDER_EXECUTION_IS_CUMULATIVE_AGGREGATE_WITHOUT_FILL_ID'],
    technicalSnapshot: technicalSnapshot(null, executionKey),
  };
}

function normalizeCanonicalOrder(payload: Record<string, unknown>): UnifiedTradeOrder | null {
  if (payload.recordType !== 'unified_trade_order') return null;
  if (!TRADE_SOURCES.includes(payload.source as TradeSource)) throw new PaperJournalError('INVALID_TRADE_SOURCE', '거래 출처를 확인하세요.');
  if (!TRADE_MARKETS.includes(payload.market as TradeMarket)) throw new PaperJournalError('INVALID_TRADE_MARKET', '거래 시장을 확인하세요.');
  const side = payload.side === 'BUY' || payload.side === 'SELL' ? payload.side : null;
  if (!side) throw new PaperJournalError('INVALID_TRADE_SIDE', '거래 방향을 확인하세요.');
  const quantity = nonNegativeDecimal(payload.quantity, 'quantity');
  const filledQuantity = nonNegativeDecimal(payload.filledQuantity, 'filledQuantity');
  const remainingQuantity = nonNegativeDecimal(payload.remainingQuantity, 'remainingQuantity');
  if (quantity <= 0 || filledQuantity > quantity + EPSILON || Math.abs(quantity - filledQuantity - remainingQuantity) > EPSILON) {
    throw new PaperJournalError('TRADE_QUANTITY_MISMATCH', '주문·체결·잔여 수량이 일치하지 않습니다.');
  }
  const brokerOrderId = stringValue(payload.brokerOrderId, 'brokerOrderId');
  const fillId = nullableText(payload.fillId, 160);
  const filledAt = isoDate(payload.filledAt, 'filledAt', true);
  const averageFillPrice = nonNegativeDecimal(payload.averageFillPrice, 'averageFillPrice', true);
  if (filledQuantity > 0 && (averageFillPrice == null || filledAt == null)) throw new PaperJournalError('TRADE_EXECUTION_INCOMPLETE', '체결 정보가 불완전합니다.');
  const currency = ['KRW', 'USD', 'USDT'].includes(String(payload.currency)) ? payload.currency as TradeCurrency : null;
  if (!currency) throw new PaperJournalError('INVALID_TRADE_CURRENCY', '거래 통화를 확인하세요.');
  const broker = ['TOSS', 'APP', 'UPBIT', 'BITGET', 'KIWOOM', 'MANUAL'].includes(String(payload.broker))
    ? payload.broker as UnifiedTradeOrder['broker']
    : null;
  if (!broker) throw new PaperJournalError('INVALID_TRADE_BROKER', '거래 중개사를 확인하세요.');
  const status = ['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'UNKNOWN'].includes(String(payload.status))
    ? payload.status as CanonicalOrderStatus
    : 'UNKNOWN';
  const executionKey = fillId
    ? `${broker}:${brokerOrderId}:${fillId}`
    : `${broker}_AGGREGATE:${brokerOrderId}:${filledQuantity}:${filledAt ?? 'UNFILLED'}`;
  return {
    schemaVersion: 1,
    recordType: 'unified_trade_order',
    source: payload.source as TradeSource,
    broker,
    accountIdMasked: assertMaskedAccount(payload.accountIdMasked),
    market: payload.market as TradeMarket,
    symbol: stringValue(payload.symbol, 'symbol').toUpperCase(),
    side,
    positionSide: payload.positionSide === 'SHORT' ? 'SHORT' : payload.positionSide === 'LONG' ? 'LONG' : null,
    positionEffect: payload.positionEffect === 'OPEN' || payload.positionEffect === 'CLOSE' ? payload.positionEffect : null,
    clientOrderId: nullableText(payload.clientOrderId, 160),
    brokerOrderId,
    fillId,
    executionKey,
    idempotencyBasis: fillId ? 'broker-fill-id' : 'aggregate-cumulative',
    orderedAt: isoDate(payload.orderedAt, 'orderedAt'),
    filledAt,
    observedAt: isoDate(payload.observedAt ?? payload.updatedAt ?? payload.filledAt ?? payload.orderedAt, 'observedAt'),
    quantity,
    filledQuantity,
    remainingQuantity,
    averageFillPrice,
    fees: nonNegativeDecimal(payload.fees, 'fees', true) ?? 0,
    tax: nonNegativeDecimal(payload.tax, 'tax', true) ?? 0,
    currency,
    status,
    strategy: nullableText(payload.strategy, 80),
    timeframe: nullableText(payload.timeframe, 20),
    stopLossPrice: nullableFinite(payload.stopLossPrice),
    targetPrice: nullableFinite(payload.targetPrice),
    ruleViolation: payload.ruleViolation === true,
    warnings: stringArray(payload.warnings),
    technicalSnapshot: technicalSnapshot(payload.technicalSnapshot, executionKey),
  };
}

function reconcileOrders(orders: UnifiedTradeOrder[], issues: JournalIntegrityIssue[]) {
  const byOrder = new Map<string, UnifiedTradeOrder>();
  const executionKeys = new Map<string, UnifiedTradeOrder>();
  for (const order of [...orders].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))) {
    const key = `${order.broker}:${order.accountIdMasked}:${order.brokerOrderId}:${order.fillId ?? 'AGGREGATE'}`;
    const previousOrder = byOrder.get(key);
    const existingExecution = executionKeys.get(order.executionKey);
    if (existingExecution) {
      if (JSON.stringify(existingExecution) !== JSON.stringify(order)) {
        issues.push({ code: 'IDEMPOTENCY_KEY_CONFLICT', orderId: order.brokerOrderId, message: '같은 체결 키에 서로 다른 내용이 감지되었습니다.' });
        if (previousOrder && TERMINAL.has(previousOrder.status) && !TERMINAL.has(order.status)) {
          issues.push({ code: 'TERMINAL_STATUS_REGRESSION', orderId: order.brokerOrderId, message: '종료된 주문이 진행 상태로 후퇴했습니다.' });
        }
      }
      continue;
    }
    executionKeys.set(order.executionKey, order);
    const previous = byOrder.get(key);
    if (!previous) {
      byOrder.set(key, order);
      continue;
    }
    if (Math.abs(previous.quantity - order.quantity) > EPSILON) {
      issues.push({ code: 'ORDER_QUANTITY_MISMATCH', orderId: order.brokerOrderId, message: '같은 주문의 원 주문 수량이 변경되었습니다.' });
      continue;
    }
    if (order.filledQuantity + EPSILON < previous.filledQuantity) {
      issues.push({ code: 'FILLED_QUANTITY_REGRESSION', orderId: order.brokerOrderId, message: '누적 체결 수량이 이전 관측보다 감소했습니다.' });
      continue;
    }
    if (TERMINAL.has(previous.status) && !TERMINAL.has(order.status)) {
      issues.push({ code: 'TERMINAL_STATUS_REGRESSION', orderId: order.brokerOrderId, message: '종료된 주문이 진행 상태로 후퇴했습니다.' });
      continue;
    }
    byOrder.set(key, order);
  }
  return [...byOrder.values()].filter((order) => order.filledQuantity > 0 && order.averageFillPrice != null && order.filledAt != null);
}

function grade(score: number): TradeReview['grade'] {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  return 'D';
}

function reviewCycle(cycle: Omit<UnifiedTradeCycle, 'review'>): TradeReview {
  const performanceScore = cycle.netReturnPercent == null
    ? 50
    : Math.round(Math.max(0, Math.min(100, 50 + cycle.netReturnPercent * 5)));
  let qualityScore = 35;
  const good: string[] = [];
  const bad: string[] = [];
  const improvements: string[] = [];
  const mistakes: string[] = [];
  if (cycle.technicalSnapshot.contextSource === 'PRE_TRADE_SNAPSHOT') {
    qualityScore += 15;
    good.push('진입 전 기술 분석 스냅샷을 보존했습니다.');
  } else {
    bad.push('진입 전 기술 분석 근거가 없어 사후 추정으로 대체하지 않았습니다.');
    improvements.push('다음 거래부터 진입 직전 차트·지표 스냅샷을 저장하세요.');
    mistakes.push('MISSING_PRE_TRADE_CONTEXT');
  }
  if (cycle.strategy) { qualityScore += 10; good.push('전략 이름이 기록되었습니다.'); }
  else { bad.push('전략 분류가 없습니다.'); improvements.push('거래 전에 허용 전략을 선택하세요.'); mistakes.push('STRATEGY_UNSPECIFIED'); }
  if (cycle.stopLossPrice != null) { qualityScore += 10; good.push('손절 기준을 사전에 기록했습니다.'); }
  else { bad.push('손절 기준이 기록되지 않았습니다.'); improvements.push('진입 전에 손절 기준을 수치로 고정하세요.'); mistakes.push('STOP_NOT_RECORDED'); }
  if (!cycle.ruleViolation) { qualityScore += 15; good.push('기록된 규칙 위반이 없습니다.'); }
  else { bad.push('거래 규칙 위반이 기록되었습니다.'); improvements.push('동일 규칙 위반을 차단할 체크리스트를 추가하세요.'); mistakes.push('RULE_VIOLATION'); }
  const entryNotional = cycle.entryPrice * Math.max(cycle.totalQuantity, EPSILON);
  const costRatio = entryNotional > 0 ? (cycle.fees + cycle.tax) / entryNotional * 100 : null;
  if (costRatio != null && costRatio <= 1) qualityScore += 5;
  else if (costRatio != null) { bad.push('비용 비중이 진입금액의 1%를 초과했습니다.'); improvements.push('수수료·세금을 포함한 최소 기대수익 기준을 높이세요.'); mistakes.push('HIGH_COST_RATIO'); }
  if (cycle.status === 'CLOSED') qualityScore += 5;
  if (cycle.targetPrice != null && cycle.exitPrice != null) qualityScore += 5;
  qualityScore = Math.round(Math.max(0, Math.min(100, qualityScore)));
  if (cycle.netPnl > 0) good.push('비용 차감 후 순손익이 양수입니다.');
  if (cycle.netPnl < 0) improvements.push('손실 거래의 진입 근거와 무효화 시점을 다시 확인하세요.');
  return { performanceScore, qualityScore, grade: grade(qualityScore), good, bad, improvements, mistakes, deterministic: true, externalAiCalled: false };
}

type OpenCycle = Omit<UnifiedTradeCycle, 'review'> & { entryValue: number; exitValue: number };

function finishCycle(cycle: OpenCycle): UnifiedTradeCycle {
  const { entryValue: _entryValue, exitValue: _exitValue, ...result } = cycle;
  return { ...result, review: reviewCycle(result) };
}

function buildCyclesFromOrders(orders: UnifiedTradeOrder[], issues: JournalIntegrityIssue[]) {
  const cycles: UnifiedTradeCycle[] = [];
  const open = new Map<string, OpenCycle>();
  const counters = new Map<string, number>();
  const sorted = [...orders].sort((left, right) => Date.parse(left.filledAt!) - Date.parse(right.filledAt!));
  for (const order of sorted) {
    const positionSide = order.positionSide ?? 'LONG';
    const effect = order.positionEffect ?? (order.side === 'BUY' ? 'OPEN' : 'CLOSE');
    const key = `${order.source}:${order.accountIdMasked}:${order.market}:${order.symbol}:${positionSide}`;
    const leg: TradeLeg = {
      orderId: order.brokerOrderId,
      at: order.filledAt!,
      price: order.averageFillPrice!,
      quantity: order.filledQuantity,
      fees: order.fees,
      tax: order.tax,
    };
    if (effect === 'OPEN') {
      const existing = open.get(key);
      if (!existing) {
        const sequence = (counters.get(key) ?? 0) + 1;
        counters.set(key, sequence);
        const unsigned: Omit<UnifiedTradeCycle, 'review'> = {
          id: `cycle:${hash(`${key}:${order.filledAt}:${sequence}`, 24)}`,
          source: order.source,
          broker: order.broker,
          accountIdMasked: order.accountIdMasked,
          market: order.market,
          symbol: order.symbol,
          positionSide,
          currency: order.currency,
          status: 'OPEN',
          openedAt: order.filledAt!,
          closedAt: null,
          entryPrice: order.averageFillPrice!,
          exitPrice: null,
          initialEntry: leg,
          additions: [],
          partialExits: [],
          finalExit: null,
          totalQuantity: order.filledQuantity,
          closedQuantity: 0,
          remainingQuantity: order.filledQuantity,
          holdingTimeMs: null,
          grossPnl: 0,
          fees: order.fees,
          tax: order.tax,
          netPnl: -order.fees - order.tax,
          netReturnPercent: null,
          strategy: order.strategy,
          timeframe: order.timeframe ?? order.technicalSnapshot.timeframe,
          stopLossPrice: order.stopLossPrice,
          targetPrice: order.targetPrice,
          ruleViolation: order.ruleViolation,
          warnings: [...order.warnings],
          technicalSnapshot: order.technicalSnapshot,
        };
        open.set(key, { ...unsigned, entryValue: leg.price * leg.quantity, exitValue: 0 });
      } else {
        existing.additions.push(leg);
        existing.entryValue += leg.price * leg.quantity;
        existing.totalQuantity += leg.quantity;
        existing.remainingQuantity += leg.quantity;
        existing.entryPrice = existing.entryValue / existing.totalQuantity;
        existing.fees += leg.fees;
        existing.tax += leg.tax;
        existing.netPnl = existing.grossPnl - existing.fees - existing.tax;
        existing.ruleViolation ||= order.ruleViolation;
        existing.warnings.push(...order.warnings);
      }
      continue;
    }
    const current = open.get(key);
    if (!current) {
      issues.push({ code: 'UNMATCHED_EXIT', orderId: order.brokerOrderId, message: '대응하는 진입 없이 청산 체결이 감지되었습니다.' });
      continue;
    }
    const closeQuantity = Math.min(current.remainingQuantity, leg.quantity);
    if (leg.quantity > current.remainingQuantity + EPSILON) {
      issues.push({ code: 'EXIT_QUANTITY_EXCEEDED', orderId: order.brokerOrderId, message: '청산 수량이 현재 포지션 수량을 초과했습니다.' });
    }
    const allocated = { ...leg, quantity: closeQuantity, fees: leg.fees * closeQuantity / leg.quantity, tax: leg.tax * closeQuantity / leg.quantity };
    const sign = positionSide === 'LONG' ? 1 : -1;
    current.grossPnl += (allocated.price - current.entryPrice) * allocated.quantity * sign;
    current.exitValue += allocated.price * allocated.quantity;
    current.closedQuantity += allocated.quantity;
    current.remainingQuantity = Math.max(0, current.remainingQuantity - allocated.quantity);
    current.fees += allocated.fees;
    current.tax += allocated.tax;
    current.exitPrice = current.exitValue / current.closedQuantity;
    current.netPnl = current.grossPnl - current.fees - current.tax;
    current.netReturnPercent = current.entryValue > 0 ? current.netPnl / current.entryValue * 100 : null;
    current.ruleViolation ||= order.ruleViolation;
    current.warnings.push(...order.warnings);
    if (current.remainingQuantity > EPSILON) {
      current.partialExits.push(allocated);
    } else {
      current.status = 'CLOSED';
      current.finalExit = allocated;
      current.closedAt = allocated.at;
      current.holdingTimeMs = Math.max(0, Date.parse(allocated.at) - Date.parse(current.openedAt));
      cycles.push(finishCycle(current));
      open.delete(key);
    }
  }
  for (const current of open.values()) cycles.push(finishCycle(current));
  return cycles;
}

function inferMarket(payload: Record<string, unknown>): TradeMarket {
  if (TRADE_MARKETS.includes(payload.market as TradeMarket)) return payload.market as TradeMarket;
  if (payload.currency === 'KRW') return 'KR_STOCK';
  if (payload.currency === 'USD') return 'US_STOCK';
  return 'CRYPTO_FUTURES';
}

function directCycle(payload: Record<string, unknown>): UnifiedTradeCycle | null {
  if (payload.recordType === 'unified_trade_order') return null;
  const status = String(payload.status ?? '').toLowerCase();
  const entryPrice = finite(payload.entryPrice);
  const exitPrice = finite(payload.exitPrice);
  const openedAt = typeof payload.filledAt === 'string' && Number.isFinite(Date.parse(payload.filledAt)) ? payload.filledAt : null;
  const closedAt = typeof payload.closedAt === 'string' && Number.isFinite(Date.parse(payload.closedAt)) ? payload.closedAt : null;
  const side = payload.side === 'short' || payload.positionSide === 'SHORT' ? 'SHORT' : 'LONG';
  if (!['closed', 'open', 'partially_closed'].includes(status) || entryPrice == null || !openedAt) return null;
  const source = TRADE_SOURCES.includes(payload.source as TradeSource) ? payload.source as TradeSource : 'APP_PAPER';
  const sourceBroker: Record<TradeSource, TradeBroker> = {
    TOSS_MANUAL: 'TOSS',
    TOSS_API: 'TOSS',
    KIWOOM_API: 'KIWOOM',
    UPBIT_API: 'UPBIT',
    BITGET_API: 'BITGET',
    APP_PAPER: 'APP',
    APP_SHADOW: 'APP',
    APP_AUTO: 'APP',
  };
  const broker = TRADE_BROKERS.includes(payload.broker as TradeBroker)
    ? payload.broker as TradeBroker
    : sourceBroker[source];
  const currency = ['KRW', 'USD', 'USDT'].includes(String(payload.currency)) ? payload.currency as TradeCurrency : 'USDT';
  const totalQuantity = finite(payload.initialQuantity ?? payload.quantity) ?? 0;
  if (totalQuantity <= 0) return null;
  const fees = Math.max(0, finite(payload.fees) ?? ((finite(payload.entryFee) ?? 0) + (finite(payload.exitFee) ?? 0)));
  const tax = Math.max(0, finite(payload.tax) ?? 0);
  const grossPnl = finite(payload.grossPnl) ?? 0;
  const netPnl = finite(payload.netPnl) ?? grossPnl - fees - tax;
  const closedQuantity = finite(payload.closedQuantity) ?? (status === 'closed' ? totalQuantity : 0);
  const remainingQuantity = Math.max(0, finite(payload.remainingQuantity) ?? totalQuantity - closedQuantity);
  const id = nullableText(payload.tradeId ?? payload.id, 160) ?? `direct:${hash(JSON.stringify(payload), 24)}`;
  const initialEntry: TradeLeg = { orderId: nullableText(payload.orderId, 160) ?? id, at: openedAt, price: entryPrice, quantity: totalQuantity, fees: Math.max(0, finite(payload.entryFee) ?? 0), tax: 0 };
  const finalExit = status === 'closed' && closedAt && exitPrice != null
    ? { orderId: nullableText(payload.exitOrderId, 160) ?? `${id}:exit`, at: closedAt, price: exitPrice, quantity: closedQuantity, fees: Math.max(0, finite(payload.exitFee) ?? 0), tax }
    : null;
  const unsigned: Omit<UnifiedTradeCycle, 'review'> = {
    id,
    source,
    broker,
    accountIdMasked: typeof payload.accountIdMasked === 'string' && payload.accountIdMasked.includes('****') ? payload.accountIdMasked : 'APP-****-LOCAL',
    market: inferMarket(payload),
    symbol: nullableText(payload.symbol, 40)?.toUpperCase() ?? 'UNKNOWN',
    positionSide: side,
    currency,
    status: status === 'closed' ? 'CLOSED' : 'OPEN',
    openedAt,
    closedAt: status === 'closed' ? closedAt : null,
    entryPrice,
    exitPrice: exitPrice ?? null,
    initialEntry,
    additions: [],
    partialExits: [],
    finalExit,
    totalQuantity,
    closedQuantity,
    remainingQuantity,
    holdingTimeMs: closedAt ? Math.max(0, Date.parse(closedAt) - Date.parse(openedAt)) : null,
    grossPnl,
    fees,
    tax,
    netPnl,
    netReturnPercent: entryPrice * totalQuantity > 0 ? netPnl / (entryPrice * totalQuantity) * 100 : null,
    strategy: nullableText(payload.strategy ?? payload.strategyName, 80),
    timeframe: nullableText(payload.timeframe, 20),
    stopLossPrice: nullableFinite(payload.stopLossPrice),
    targetPrice: nullableFinite(payload.targetPrice ?? payload.takeProfitPrice1),
    ruleViolation: payload.ruleViolation === true,
    warnings: stringArray(payload.warnings),
    technicalSnapshot: technicalSnapshot(payload.technicalSnapshot, id),
  };
  return { ...unsigned, review: reviewCycle(unsigned) };
}

function startForRange(range: TradeRange, now: Date) {
  if (range === 'ALL') return Number.NEGATIVE_INFINITY;
  if (range === 'TODAY') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
  const days = range === '7D' ? 7 : range === '30D' ? 30 : range === '90D' ? 90 : 365;
  return now.getTime() - days * 86_400_000;
}

function filterCycles(cycles: UnifiedTradeCycle[], filters: UnifiedJournalFilters, now: Date) {
  const range = TRADE_RANGES.includes(filters.range as TradeRange) ? filters.range as TradeRange : '30D';
  const start = startForRange(range, now);
  return cycles.filter((cycle) => {
    const time = Date.parse(cycle.closedAt ?? cycle.openedAt);
    return time >= start
      && (!filters.market || filters.market === 'ALL' || cycle.market === filters.market)
      && (!filters.source || filters.source === 'ALL' || cycle.source === filters.source)
      && (!filters.broker || filters.broker === 'ALL' || cycle.broker === filters.broker)
      && (!filters.account || cycle.accountIdMasked === filters.account)
      && (!filters.strategy || cycle.strategy === filters.strategy)
      && (!filters.timeframe || cycle.timeframe === filters.timeframe)
      && (!filters.grade || filters.grade === 'ALL' || cycle.review.grade === filters.grade);
  });
}

function groupMetric(cycles: UnifiedTradeCycle[], selector: (cycle: UnifiedTradeCycle) => string): GroupMetric[] {
  const groups = new Map<string, UnifiedTradeCycle[]>();
  for (const cycle of cycles) {
    const key = selector(cycle);
    groups.set(key, [...(groups.get(key) ?? []), cycle]);
  }
  return [...groups.entries()].map(([key, items]) => {
    const returns = items.map((item) => item.netReturnPercent).filter((item): item is number => item != null);
    return {
      key,
      sampleSize: items.length,
      winRate: items.length >= 5 ? items.filter((item) => item.netPnl > 0).length / items.length * 100 : null,
      averageReturnPercent: items.length >= 5 && returns.length === items.length ? returns.reduce((sum, item) => sum + item, 0) / returns.length : null,
    };
  }).sort((left, right) => left.key.localeCompare(right.key));
}

function currencyMetrics(cycles: UnifiedTradeCycle[], selector: (cycle: UnifiedTradeCycle) => number): CurrencyMetric[] {
  const totals = new Map<TradeCurrency, number>();
  for (const cycle of cycles) totals.set(cycle.currency, (totals.get(cycle.currency) ?? 0) + selector(cycle));
  return [...totals.entries()].map(([currency, value]) => ({ currency, value })).sort((a, b) => a.currency.localeCompare(b.currency));
}

function maximumConsecutiveLosses(cycles: UnifiedTradeCycle[]) {
  let current = 0;
  let maximum = 0;
  for (const cycle of [...cycles].sort((a, b) => Date.parse(a.closedAt!) - Date.parse(b.closedAt!))) {
    current = cycle.netPnl < 0 ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function analytics(cycles: UnifiedTradeCycle[]): UnifiedJournalAnalytics {
  const closed = cycles.filter((cycle) => cycle.status === 'CLOSED');
  const returns = closed.map((cycle) => cycle.netReturnPercent).filter((item): item is number => item != null);
  const wins = closed.filter((cycle) => cycle.netPnl > 0);
  const losses = closed.filter((cycle) => cycle.netPnl < 0);
  const grossProfit = wins.reduce((sum, cycle) => sum + cycle.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, cycle) => sum + cycle.netPnl, 0));
  const mistakes = new Map<string, number>();
  for (const cycle of closed) for (const code of cycle.review.mistakes) mistakes.set(code, (mistakes.get(code) ?? 0) + 1);
  const months = new Map<string, UnifiedTradeCycle[]>();
  for (const cycle of closed) {
    const month = cycle.closedAt!.slice(0, 7);
    months.set(month, [...(months.get(month) ?? []), cycle]);
  }
  const enough = closed.length >= 5;
  return {
    sampleSize: cycles.length,
    openTrades: cycles.length - closed.length,
    closedTrades: closed.length,
    winRate: enough ? wins.length / closed.length * 100 : null,
    profitFactor: enough && grossLoss > 0 ? grossProfit / grossLoss : null,
    averageReturnPercent: enough && returns.length === closed.length ? returns.reduce((sum, item) => sum + item, 0) / returns.length : null,
    maximumConsecutiveLosses: maximumConsecutiveLosses(closed),
    netPnlByCurrency: currencyMetrics(closed, (cycle) => cycle.netPnl),
    totalCostsByCurrency: currencyMetrics(closed, (cycle) => cycle.fees + cycle.tax),
    byMarket: groupMetric(closed, (cycle) => cycle.market),
    bySource: groupMetric(closed, (cycle) => cycle.source),
    byStrategy: groupMetric(closed, (cycle) => cycle.strategy ?? 'UNSPECIFIED'),
    byTimeframe: groupMetric(closed, (cycle) => cycle.timeframe ?? 'UNSPECIFIED'),
    byGrade: groupMetric(closed, (cycle) => cycle.review.grade),
    mistakes: [...mistakes.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    monthlyReport: [...months.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([month, items]) => {
      const monthReturns = items.map((item) => item.netReturnPercent).filter((item): item is number => item != null);
      return {
        month,
        sampleSize: items.length,
        winRate: items.length >= 5 ? items.filter((item) => item.netPnl > 0).length / items.length * 100 : null,
        averageReturnPercent: items.length >= 5 && monthReturns.length === items.length ? monthReturns.reduce((sum, item) => sum + item, 0) / monthReturns.length : null,
        netPnlByCurrency: currencyMetrics(items, (item) => item.netPnl),
      };
    }),
    warnings: enough ? [] : ['확정 통계에는 종료 거래가 최소 5건 필요하며 부족한 지표는 N/A로 표시됩니다.'],
  };
}

export function tossJournalIntegrationStatus() {
  return Object.freeze({
    provider: 'TOSS',
    officialSpecVersion: TOSS_OPENAPI_SPEC_VERSION,
    officialBaseUrl: 'https://openapi.tossinvest.com',
    orderListPath: '/api/v1/orders',
    orderDetailPath: '/api/v1/orders/{orderId}',
    authentication: 'OAUTH2_CLIENT_CREDENTIALS_AND_ACCOUNT_HEADER',
    paidStatus: PAID_STATUS,
    liveReadIntegration: TOSS_LIVE_READ_INTEGRATION,
    contractNormalizerAvailable: true,
    executionGranularity: 'ORDER_CUMULATIVE_AGGREGATE_NO_FILL_ID',
    livePrivateRequests: 0,
    actualOrders: 0,
  });
}

export function buildUnifiedTradeJournal(
  payloads: readonly Record<string, unknown>[],
  filters: UnifiedJournalFilters = {},
  now = new Date(),
): UnifiedTradeJournalResult {
  const issues: JournalIntegrityIssue[] = [];
  const orders: UnifiedTradeOrder[] = [];
  const direct: UnifiedTradeCycle[] = [];
  for (const payload of payloads) {
    try {
      const order = normalizeCanonicalOrder(payload);
      if (order) orders.push(order);
      else {
        const cycle = directCycle(payload);
        if (cycle) direct.push(cycle);
      }
    } catch (cause) {
      issues.push({
        code: cause instanceof PaperJournalError ? cause.code : 'INVALID_JOURNAL_PAYLOAD',
        orderId: nullableText(payload.brokerOrderId, 160),
        message: cause instanceof Error ? cause.message : '거래일지 레코드를 정규화하지 못했습니다.',
      });
    }
  }
  const reconciled = reconcileOrders(orders, issues);
  const cycles = filterCycles([...direct, ...buildCyclesFromOrders(reconciled, issues)], filters, now)
    .sort((left, right) => Date.parse(right.closedAt ?? right.openedAt) - Date.parse(left.closedAt ?? left.openedAt));
  return {
    integrationBaseSha: JOURNAL_INTEGRATION_BASE_SHA,
    generatedAt: now.toISOString(),
    trades: cycles,
    analytics: analytics(cycles),
    integrityIssues: issues,
    toss: tossJournalIntegrationStatus(),
    aiReviewStatus: AI_EXTERNAL_REVIEW_STATUS,
    safety: JOURNAL_COST_SAFETY,
  };
}
