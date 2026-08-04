import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { ScannerApprovalPlanService, buildLongExitPlan, parseKiwoomTopOfBook } from './scanner-approval-plan.service';
import { normalizeTradingPolicy } from './trade-automation-risk.service';
import { DEFAULT_TRADING_POLICY, type TradingPlan } from './trade-automation.types';
import type { Candle } from '../sample/types';

const USER = '11111111-1111-1111-1111-111111111111';
// Keep the market snapshot fresh relative to the real risk engine clock. A
// fixed historical instant makes this otherwise-valid fixture fail closed as
// stale when CI runs later.
const NOW = new Date();

function candles(base = 70_000, count = 30): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = base - 1_500 + index * 50;
    return {
      time: new Date(NOW.getTime() - (count - index) * 60_000).toISOString(),
      open: close - 100,
      high: close + 500,
      low: close - 700,
      close,
      volume: 100_000 + index * 1_000,
    };
  });
}

function minuteCandles(): Candle[] {
  return [
    { time: new Date(NOW.getTime() - 60_000).toISOString(), open: 69_700, high: 69_900, low: 69_600, close: 69_800, volume: 10_000 },
    { time: NOW.toISOString(), open: 69_800, high: 70_100, low: 69_700, close: 70_000, volume: 12_000 },
  ];
}

function scanResult(overrides: Record<string, unknown> = {}) {
  const card = {
    ticker: '005930',
    name: '삼성전자',
    market: 'KR',
    currency: 'KRW',
    assetType: 'COMMON_STOCK',
    price: 70_000,
    changePercent: 1.2,
    score: 84,
    confidence: 79,
    matched: ['거래량 증가', '5일선 돌파'],
    missing: [],
    breakoutProbability: 82,
    expectedPeriod: '단기',
    entry: ['서버 계산'],
    stop: ['서버 계산'],
    matchCount: 2,
    selectedCount: 2,
    riskLevel: 'LOW',
    riskScore: 12,
    liquidity: 10_000_000_000,
    marketCap: 400_000_000_000_000,
    dataState: 'ok',
    analyzedAt: NOW.toISOString(),
    scoreBreakdown: {},
    ...overrides,
  };
  return {
    cards: [card],
    selected: ['거래량 증가', '5일선 돌파'],
    supportedIndicators: ['거래량 증가', '5일선 돌파'],
    scanned: 200,
    excludedCount: 199,
    appliedFilters: {
      volumeThreshold: null,
      tradingValueThreshold: null,
      marketCapThreshold: null,
      minimumScore: 70,
      maximumRiskScore: 50,
    },
    timeframe: '1D',
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    scan: async () => scanResult(),
    getQuote: async () => ({ price: 70_000, changeAmount: 800, changePercent: 1.2, volume: 1_000_000, marketCap: 1 }),
    getCandles: async (_symbol: string, timeframe: string) => timeframe === '1m' ? minuteCandles() : candles(),
    getOrderbook: async () => ({
      return_code: 0,
      sel_fpr_bid: '+70010',
      buy_fpr_bid: '+70000',
      sel_fpr_req: '1200',
      buy_fpr_req: '1500',
      tot_sel_req: '10000',
      tot_buy_req: '12500',
    }),
    now: () => NOW,
    ...overrides,
  } as any;
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    market: 'KR' as const,
    symbol: '005930',
    timeframe: '1D',
    selectedConditions: ['거래량 증가', '5일선 돌파'],
    requestedInvestmentKrw: 500_000,
    splitRatios: [40, 30, 30],
    minimumScore: 70,
    minimumConfidence: 60,
    maximumRiskScore: 50,
    ...overrides,
  } as any;
}

test('parses official Kiwoom best ask/bid fields and rejects crossed books', () => {
  const book = parseKiwoomTopOfBook({
    sel_fpr_bid: '+70010', buy_fpr_bid: '+70000', sel_fpr_req: '100', buy_fpr_req: '200',
    tot_sel_req: '1000', tot_buy_req: '1200',
  });
  assert.equal(book.ask, 70_010);
  assert.equal(book.bid, 70_000);
  assert.ok(book.spreadPercent > 0 && book.spreadPercent < 0.1);
  assert.throws(() => parseKiwoomTopOfBook({ sel_fpr_bid: '69900', buy_fpr_bid: '70000' }), /SCANNER_ORDERBOOK_INVALID/);
});

test('builds numeric ATR/support stop and target levels from real candles', () => {
  const plan = buildLongExitPlan(70_000, candles());
  assert.ok(plan.stopPrice < 70_000);
  assert.ok(plan.targetPrices[0] > 70_000);
  assert.ok(plan.targetPrices[1] > plan.targetPrices[0]);
  assert.ok(plan.riskReward >= 1.45);
  assert.throws(() => buildLongExitPlan(70_000, candles(70_000, 5)), /SCANNER_CANDLES_INSUFFICIENT/);
});

test('creates a server-verified KR paper approval plan and clamps investment to policy exposure', async () => {
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    totalCapitalKrw: 1_000_000,
    maxOrderKrw: 800_000,
    maxAssetPercent: 30,
  }));
  const service = new ScannerApprovalPlanService(repository, dependencies());
  const result = await service.createPaperPlan(USER, request());
  assert.equal(result.serverVerified, true);
  assert.equal(result.liveOrderEnabled, false);
  assert.equal(result.plan.exchange, 'kiwoom');
  assert.equal(result.plan.accountMode, 'paper');
  assert.equal(result.plan.state, 'APPROVAL_PENDING');
  assert.equal(result.plan.signalState, 'READY_FOR_APPROVAL');
  assert.equal(result.plan.signalScore, 84);
  assert.equal(result.plan.signalConfidence, 79);
  assert.deepEqual(result.plan.splitRatios, [40, 30, 30]);
  assert.ok(result.plan.estimatedKrw <= 300_000);
  assert.equal(result.approval?.approvalEnabled, true);
  assert.match(result.plan.signalReasons.join(' '), /서버 재계산 AI 점수 84/);
});

test('requires strict AND match and blocks missing, stale, or high-risk scanner results', async () => {
  const cases = [
    { card: { missing: ['5일선 돌파'], matched: ['거래량 증가'] }, error: /SCANNER_AND_CONDITIONS_NOT_MAINTAINED/ },
    { card: { dataState: 'stale' }, error: /SCANNER_DATA_STALE/ },
    { card: { riskLevel: 'HIGH', riskScore: 80 }, error: /SCANNER_RISK_BLOCKED/ },
  ];
  for (const item of cases) {
    const repository = new InMemoryTradingRepository();
    const service = new ScannerApprovalPlanService(repository, dependencies({
      scan: async () => scanResult(item.card),
    }));
    await assert.rejects(() => service.createPaperPlan(USER, request()), item.error);
  }
});

test('does not invent missing minute volatility data', async () => {
  const repository = new InMemoryTradingRepository();
  const service = new ScannerApprovalPlanService(repository, dependencies({
    getCandles: async (_symbol: string, timeframe: string) => timeframe === '1m' ? [] : candles(),
  }));
  await assert.rejects(() => service.createPaperPlan(USER, request()), /SCANNER_MINUTE_DATA_INSUFFICIENT/);
});

test('blocks US plans until a verified US order adapter exists', async () => {
  const repository = new InMemoryTradingRepository();
  const service = new ScannerApprovalPlanService(repository, dependencies());
  await assert.rejects(
    () => service.createPaperPlan(USER, request({ market: 'US', symbol: 'AAPL' })),
    /US_ORDER_ADAPTER_NOT_AVAILABLE/,
  );
});

test('blocks a second active plan for the same symbol', async () => {
  const repository = new InMemoryTradingRepository();
  const policy = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    totalCapitalKrw: 2_000_000,
    maxOrderKrw: 500_000,
    maxAssetPercent: 30,
  });
  await repository.savePolicy(USER, policy);
  const existing = {
    exchange: 'kiwoom', accountMode: 'paper', strategyId: 'scanner-existing', signalId: 'existing',
    symbol: '005930', market: 'KR', side: 'buy', orderType: 'market', quantity: 1, quoteAmount: null,
    limitPrice: null, estimatedKrw: 70_000, stopPrice: 65_000, targetPrices: [75_000], splitRatios: [100],
    signalReasons: ['existing'], signalWarnings: [], marketSnapshot: {
      observedAt: NOW.toISOString(), dataDelayMs: 0, oneMinuteMovePercent: 0, spreadPercent: 0.01,
      orderbookGapPercent: 0.01, halted: false, availableBalance: 2_000_000, accountValueKrw: 2_000_000,
      dailyPnlPercent: 0, assetExposurePercent: 0, openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0,
    },
    id: 'existing-plan', userId: USER, idempotencyKey: 'existing-key', state: 'APPROVAL_PENDING',
    approvalExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(), approvedAt: null,
    signalState: 'READY_FOR_APPROVAL', signalScore: 80, signalConfidence: 80,
    minimumSignalScore: 70, minimumSignalConfidence: 60, minimumRiskReward: 1.5,
    signalRiskReward: 2, signalCoreConditionsMaintained: true,
    signalExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(), lastSignalValidatedAt: NOW.toISOString(),
    signalInvalidationReason: null, signalStateHistory: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  } as TradingPlan;
  await repository.savePlan(existing);
  const service = new ScannerApprovalPlanService(repository, dependencies());
  await assert.rejects(() => service.createPaperPlan(USER, request()), /SCANNER_DUPLICATE_ACTIVE_SYMBOL/);
});
