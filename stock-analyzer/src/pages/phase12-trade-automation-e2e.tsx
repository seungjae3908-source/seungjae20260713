import AutoTradingPage from '@/pages/auto-trading';
import type { TradeAutomationStatus } from '@/components/trade-automation-settings';
import type { TradeApprovalPlan } from '@/components/trade-approval-queue';

const PLANS: TradeApprovalPlan[] = [
  {
    id: 'paper-plan', exchange: 'upbit', accountMode: 'paper', strategyId: 'breakout-v1',
    symbol: 'BTC', market: 'KRW', side: 'buy', estimatedKrw: 40_000,
    stopPrice: 98_000, targetPrices: [104_000, 108_000], signalReasons: ['추세 확정', '거래량 증가'],
    state: 'APPROVAL_PENDING', approvalExpiresAt: '2099-01-01T00:00:00.000Z',
    signalState: 'confirmed', signalExpiresAt: '2099-01-01T00:00:00.000Z',
    entryZoneLow: 99_000, entryZoneHigh: 101_000, estimatedSlippagePercent: 0.1,
    averageSpreadPercent: 0.1,
    marketSnapshot: { currentPrice: 100_000, observedAt: '2099-01-01T00:00:00.000Z', dataDelayMs: 100 },
    riskAssessment: {
      allowed: true, blockCodes: [], warnings: [], expectedValueR: 0.325,
      riskBudgetKrw: 1_000, maximumOrderKrw: 50_000, stopDistancePercent: 2,
      pilotStage: 'approval-20',
    },
    internalIdentityExposed: false,
  },
  {
    id: 'live-plan', exchange: 'bitget', accountMode: 'live', strategyId: 'breakout-v1',
    symbol: 'SOLUSDT', market: 'USDT-FUTURES', side: 'long', estimatedKrw: 20_000,
    stopPrice: 145, targetPrices: [158], signalReasons: ['신호 약화'],
    state: 'APPROVAL_PENDING', approvalExpiresAt: '2099-01-01T00:00:00.000Z',
    signalState: 'weakening', signalExpiresAt: '2099-01-01T00:00:00.000Z',
    entryZoneLow: 149, entryZoneHigh: 151, estimatedSlippagePercent: 0.1,
    averageSpreadPercent: 0.1,
    marketSnapshot: { currentPrice: 150, observedAt: '2099-01-01T00:00:00.000Z', dataDelayMs: 100 },
    riskAssessment: {
      allowed: false, blockCodes: ['SIGNAL_NOT_CONFIRMED', 'PILOT_FUTURES_ASSET_LIMIT'],
      warnings: [], expectedValueR: 0.2, riskBudgetKrw: 500, maximumOrderKrw: 15_000,
      stopDistancePercent: 3.33, pilotStage: 'approval-20',
    },
    internalIdentityExposed: false,
  },
];

const FIXTURE: TradeAutomationStatus & { plans: TradeApprovalPlan[] } = {
  policy: {
    mode: 'approval', automaticEnabled: false, emergencyStopped: false,
    exchangeEnabled: { bitget: false, upbit: false, kiwoom: false },
    enabledAssets: { bitget: ['BTC'], upbit: ['BTC'], kiwoom: ['005930'] },
    enabledStrategies: ['breakout-v1'], totalCapitalKrw: 5_000_000,
    maxOrderKrw: 1_000_000, dailyLossLimitPercent: 5, maxAssetPercent: 30,
    maxOpenPositions: 5, maxDailyOrders: 10, maxConsecutiveLosses: 3, bitgetLeverage: 2,
    riskOptimizationEnabled: true, pilotStage: 'approval-20',
    riskPerTradePercent: { bitget: 0.1, upbit: 0.2, kiwoom: 0.25 },
    totalDailyLossLimitPercent: 1, minExpectedValueR: 0.15,
    minStrategySampleSize: 50, minProfitFactor: 1.2, maxStrategyDrawdownPercent: 15,
    maxEstimatedSlippagePercent: 0.25, maxAverageSpreadPercent: 0.15,
    maxCorrelatedExposurePercent: 40, maxEconomicsAgeHours: 24,
  },
  connections: [
    { exchange: 'bitget', accountMode: 'paper', configured: true, lastVerifiedAt: null, lastErrorCode: null, credentialsExposed: false },
    { exchange: 'upbit', accountMode: 'paper', configured: true, lastVerifiedAt: null, lastErrorCode: null, credentialsExposed: false },
    { exchange: 'kiwoom', accountMode: 'mock', configured: true, lastVerifiedAt: null, lastErrorCode: null, credentialsExposed: false },
  ],
  emergencyStopped: false,
  liveExecutionServerEnabled: { bitget: false, upbit: false, kiwoom: false },
  credentialVault: { encryptionConfigured: true, keyValueExposed: false },
  lastOrder: null,
  plans: PLANS,
};

export default function Phase12TradeAutomationE2EPage() {
  return <AutoTradingPage fixture={FIXTURE} />;
}
