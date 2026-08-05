import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { ScannerApprovalPlanService } from './scanner-approval-plan.service';
import type { Candle } from '../sample/types';
import type { TradingPlan } from './trade-automation.types';

const USER = '11111111-1111-1111-1111-111111111111';
const NOW = new Date();

function minuteCandles(): Candle[] {
  return [
    { time: new Date(NOW.getTime() - 60_000).toISOString(), open: 69_800, high: 70_000, low: 69_700, close: 69_900, volume: 10_000 },
    { time: NOW.toISOString(), open: 69_900, high: 70_100, low: 69_800, close: 70_000, volume: 12_000 },
  ];
}

function plan(): TradingPlan {
  const now = NOW.toISOString();
  return {
    id: 'scanner-plan',
    userId: USER,
    idempotencyKey: 'scanner-key',
    state: 'APPROVAL_PENDING',
    approvalExpiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    approvedAt: null,
    exchange: 'kiwoom',
    accountMode: 'paper',
    strategyId: 'scanner-1d-test',
    signalId: 'scanner-signal',
    symbol: '005930',
    market: 'KR',
    side: 'buy',
    orderType: 'market',
    quantity: 4,
    quoteAmount: null,
    limitPrice: null,
    estimatedKrw: 280_000,
    stopPrice: 67_000,
    targetPrices: [74_500, 77_500],
    splitRatios: [40, 30, 30],
    leverage: null,
    marginMode: null,
    reduceOnly: false,
    invalidateAction: 'hold',
    signalReasons: ['거래량 증가', '5일선 돌파'],
    signalWarnings: [],
    signalScore: 84,
    signalConfidence: 79,
    minimumSignalScore: 70,
    minimumSignalConfidence: 60,
    minimumRiskReward: 1.5,
    signalRiskReward: 1.5,
    signalCoreConditionsMaintained: true,
    signalExpiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    lastSignalValidatedAt: now,
    signalState: 'READY_FOR_APPROVAL',
    signalInvalidationReason: null,
    signalStateHistory: [],
    scannerContext: {
      market: 'KR',
      timeframe: '1D',
      selectedConditions: ['거래량 증가', '5일선 돌파'],
      volumeThreshold: null,
      tradingValueThreshold: null,
      marketCapThreshold: null,
      volumeLookbackDays: 20,
      tradingValueLookbackDays: 20,
      minimumScore: 70,
      minimumConfidence: 60,
      maximumRiskScore: 50,
      maxEntryDriftPercent: 2.5,
    },
    marketSnapshot: {
      observedAt: now,
      dataDelayMs: 0,
      oneMinuteMovePercent: 0.1,
      spreadPercent: 0.02,
      orderbookGapPercent: 0.02,
      halted: false,
      availableBalance: 1_000_000,
      accountValueKrw: 1_000_000,
      dailyPnlPercent: 0,
      assetExposurePercent: 0,
      openPositionCount: 0,
      dailyOrderCount: 0,
      consecutiveLosses: 0,
      existingPositionSide: null,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function service(currentPrice: number) {
  return new ScannerApprovalPlanService(new InMemoryTradingRepository(), {
    scan: async () => ({
      cards: [{
        ticker: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', assetType: 'STOCK',
        price: currentPrice, changePercent: 1, score: 84, confidence: 79,
        matched: ['거래량 증가', '5일선 돌파'], missing: [], breakoutProbability: 80,
        expectedPeriod: '단기', entry: [], stop: [], matchCount: 2, selectedCount: 2,
        riskLevel: 'LOW', riskScore: 10, liquidity: 10_000_000_000, marketCap: 1,
        dataState: 'ok', analyzedAt: NOW.toISOString(), scoreBreakdown: {},
      }],
      selected: ['거래량 증가', '5일선 돌파'],
      supportedIndicators: ['거래량 증가', '5일선 돌파'],
      scanned: 1,
      excludedCount: 0,
      appliedFilters: { volumeThreshold: null, tradingValueThreshold: null, marketCapThreshold: null, minimumScore: 70, maximumRiskScore: 50 },
      timeframe: '1D',
    }),
    getQuote: async () => ({
      price: currentPrice,
      changeAmount: 0,
      changePercent: 0,
      volume: 1_000_000,
      marketCap: 1,
      week52High: 80_000,
      week52Low: 50_000,
    }),
    getCandles: async () => minuteCandles(),
    getOrderbook: async () => ({ sel_fpr_bid: String(currentPrice + 10), buy_fpr_bid: String(currentPrice), tot_sel_req: '1000', tot_buy_req: '1200' }),
    now: () => NOW,
  });
}

test('final scanner revalidation keeps approval eligible inside the entry drift limit', async () => {
  const validation = await service(71_000).revalidatePaperPlan(USER, plan());
  assert.equal(validation.coreConditionsMaintained, true);
  assert.equal(validation.invalidationReason, null);
  assert.match(validation.reasons?.join(' ') ?? '', /현재가 변동 1\.43%/);
});

test('final scanner revalidation blocks price drift above 2.5 percent', async () => {
  const validation = await service(72_000).revalidatePaperPlan(USER, plan());
  assert.equal(validation.coreConditionsMaintained, false);
  assert.equal(validation.invalidationReason, 'SCANNER_ENTRY_PRICE_DRIFTED');
  assert.match(validation.warnings?.join(' ') ?? '', /SCANNER_ENTRY_PRICE_DRIFTED/);
});
