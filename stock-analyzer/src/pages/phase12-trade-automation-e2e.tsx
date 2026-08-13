import type { ComponentProps } from 'react';
import AutoTradingPage from '@/pages/auto-trading';
import { TradeAutomationSettings } from '@/components/trade-automation-settings';
import type { TradeApprovalQueueItem } from '@/components/trade-approval-queue';
import type { AutoTradingV2Fixture } from '@/components/auto-trading-v2-panel';

type TradeAutomationStatus = NonNullable<ComponentProps<typeof TradeAutomationSettings>['fixture']>;

const FIXTURE: TradeAutomationStatus = {
  policy: {
    mode: 'approval', automaticEnabled: false, emergencyStopped: false,
    exchangeEnabled: { bitget: false, upbit: false, kiwoom: false },
    enabledAssets: { bitget: ['BTC'], upbit: ['BTC'], kiwoom: ['005930'] },
    enabledStrategies: ['breakout-v1'], totalCapitalKrw: 5_000_000,
    maxOrderKrw: 1_000_000, dailyLossLimitPercent: 5, maxAssetPercent: 30,
    maxOpenPositions: 5, maxDailyOrders: 10, maxConsecutiveLosses: 3, bitgetLeverage: 2,
  },
  connections: [
    { exchange: 'bitget', accountMode: 'paper', configured: true, lastVerifiedAt: null, lastErrorCode: null, credentialsExposed: false },
    { exchange: 'upbit', accountMode: 'paper', configured: true, lastVerifiedAt: null, lastErrorCode: null, credentialsExposed: false },
    { exchange: 'kiwoom', accountMode: 'mock', configured: true, lastVerifiedAt: null, lastErrorCode: null, credentialsExposed: false },
  ],
  emergencyStopped: false,
  credentialVault: { encryptionConfigured: true, keyValueExposed: false },
  lastOrder: null,
};

const READY_AT = new Date().toISOString();
const EXPIRES_AT = new Date(Date.now() + 10 * 60_000).toISOString();
const SOON_EXPIRES_AT = new Date(Date.now() + 4_000).toISOString();

const V2_FIXTURE: AutoTradingV2Fixture = {
  status: {
    ok: true,
    autoTradingUi: true,
    paperTrading: true,
    shadowTrading: true,
    liveTrading: false,
    liveLocked: true,
    privateTradingApiAllowed: false,
    realOrderCount: 0,
    realCancelCount: 0,
    privateTradingApiCount: 0,
    config: {
      mode: 'PAPER',
      equityKrw: 1_000_000,
      riskPerTradePercent: 0.25,
      leverage: 3,
      stopMode: 'ATR_STOP',
      atrMultiplier: 2,
      dailyPnlPercent: 0,
      weeklyDrawdownPercent: 0,
      consecutiveLosses: 0,
      safeHalt: false,
      newEntryDisabled: false,
      haltReasons: [],
      updatedAt: READY_AT,
    },
    effectiveMode: 'PAPER',
    strategy: {
      id: 'crypto-futures-pullback-v1',
      version: '1.0.0',
      eligibility: 'PAPER_READY',
      parameterSelection: 'PARAMETER_STABILITY',
      rvolCandidatesPercent: [300, 400, 500, 600],
      selectedRvolPercent: 400,
      researchOnlyProfitClaim: false,
    },
    supportedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
    marginMode: 'ISOLATED',
    leverageCap: 5,
    positions: [{
      mode: 'PAPER', symbol: 'BTCUSDT', direction: 'LONG', status: 'ACTIVE',
      strategyId: 'crypto-futures-pullback-v1', strategyVersion: '1.0.0',
      entryPrice: 116_500, stopPrice: 114_000, targetPrice: 120_577.5, trailingStop: null,
      notionalKrw: 250_000, requiredMarginKrw: 83_333.33, leverage: 3, riskPerTradePercent: 0.25,
      realizedPnlKrw: 0, unrealizedPnlKrw: 1_250, fundingCostKrw: 35,
      positionProtected: true, updatedAt: READY_AT,
    }],
    reconciliation: { state: 'SAFE', tradingEnabled: true, reasons: [], privateTradingApiCount: 0 },
    latest: [{
      kind: 'journal', id: 'atv2-signal-fixture', updatedAt: READY_AT,
      payload: {
        recordType: 'auto_trading_v2_signal', symbol: 'BTCUSDT', direction: 'LONG',
        allowed: true, blockReasons: [], observedAt: READY_AT,
      },
    }],
    health: {
      app: 'UP', marketData: 'PUBLIC_ONLY', signalEngine: 'READY', riskEngine: 'READY',
      executionEngine: 'SIMULATION_READY', reconciliation: 'SAFE', database: 'UP',
      telegram: 'QUEUE_INTEGRATED', overall: 'UP',
    },
  },
  snapshots: [
    { symbol: 'BTCUSDT', observedAt: READY_AT, markPrice: 117_000, indexPrice: 116_995, spreadPercent: 0.015, markIndexDislocationPercent: 0.004, fundingRate: 0.0001, btc1dClose: 118_000, btc1dMa20: 110_000, btc1hClose: 117_000, btc1hMa20: 115_000, symbol1hClose: 117_000, symbol1hMa20: 115_000, atrPercent: 1.4, expansionRvolPercent: 430, volumeContraction: true, pullbackDistancePercent: 0.22, continuationLong: true, continuationShort: false, dataStale: false },
    { symbol: 'ETHUSDT', observedAt: READY_AT, markPrice: 4_300, indexPrice: 4_299, spreadPercent: 0.02, markIndexDislocationPercent: 0.02, fundingRate: 0.00008, btc1dClose: 118_000, btc1dMa20: 110_000, btc1hClose: 117_000, btc1hMa20: 115_000, symbol1hClose: 4_310, symbol1hMa20: 4_250, atrPercent: 1.7, expansionRvolPercent: 350, volumeContraction: true, pullbackDistancePercent: 0.3, continuationLong: false, continuationShort: false, dataStale: false },
    { symbol: 'SOLUSDT', observedAt: READY_AT, markPrice: 205, indexPrice: 204.9, spreadPercent: 0.03, markIndexDislocationPercent: 0.04, fundingRate: 0.00012, btc1dClose: 118_000, btc1dMa20: 110_000, btc1hClose: 117_000, btc1hMa20: 115_000, symbol1hClose: 198, symbol1hMa20: 202, atrPercent: 2.2, expansionRvolPercent: 510, volumeContraction: true, pullbackDistancePercent: 0.18, continuationLong: true, continuationShort: false, dataStale: false },
    { symbol: 'XRPUSDT', observedAt: READY_AT, markPrice: 3.05, indexPrice: 3.049, spreadPercent: 0.04, markIndexDislocationPercent: 0.03, fundingRate: 0.00015, btc1dClose: 118_000, btc1dMa20: 110_000, btc1hClose: 117_000, btc1hMa20: 115_000, symbol1hClose: 3.07, symbol1hMa20: 3.0, atrPercent: 2.5, expansionRvolPercent: 620, volumeContraction: false, pullbackDistancePercent: 0.4, continuationLong: true, continuationShort: false, dataStale: false },
  ],
};

function readyPlan(overrides: Partial<TradeApprovalQueueItem> = {}): TradeApprovalQueueItem {
  return {
    id: 'ready-plan',
    exchange: 'upbit',
    accountMode: 'paper',
    strategyId: 'scanner-breakout-v1',
    signalId: 'signal-ready',
    symbol: 'BTC',
    market: 'KRW',
    side: 'buy',
    orderType: 'market',
    estimatedKrw: 100_000,
    quantity: null,
    limitPrice: null,
    stopPrice: 90_000,
    targetPrices: [108_000, 112_000],
    splitRatios: [50, 30, 20],
    leverage: null,
    signalReasons: ['거래량 증가', 'VWAP 상단 유지', '시장방향 일치'],
    signalWarnings: [],
    signalScore: 82,
    signalConfidence: 78,
    signalRiskReward: 2.1,
    signalState: 'READY_FOR_APPROVAL',
    signalInvalidationReason: null,
    state: 'APPROVAL_PENDING',
    approvalExpiresAt: EXPIRES_AT,
    updatedAt: READY_AT,
    approval: {
      approvalEnabled: true,
      signalState: 'READY_FOR_APPROVAL',
      planState: 'APPROVAL_PENDING',
      reasonCode: null,
      expiresAt: EXPIRES_AT,
      lastValidatedAt: READY_AT,
    },
    order: null,
    ...overrides,
  };
}

const APPROVAL_FIXTURE: TradeApprovalQueueItem[] = [
  readyPlan(),
  readyPlan({
    id: 'soon-plan',
    signalId: 'signal-soon',
    symbol: 'ETH',
    estimatedKrw: 200_000,
    approvalExpiresAt: SOON_EXPIRES_AT,
    approval: {
      approvalEnabled: true,
      signalState: 'READY_FOR_APPROVAL',
      planState: 'APPROVAL_PENDING',
      reasonCode: null,
      expiresAt: SOON_EXPIRES_AT,
      lastValidatedAt: READY_AT,
    },
  }),
  readyPlan({
    id: 'live-plan',
    signalId: 'signal-live',
    symbol: 'BTCUSDT',
    exchange: 'bitget',
    market: 'USDT-FUTURES',
    accountMode: 'live',
    side: 'long',
    leverage: 2,
  }),
  readyPlan({
    id: 'invalid-plan',
    signalId: 'signal-invalid',
    symbol: '005930',
    exchange: 'kiwoom',
    market: 'KR',
    accountMode: 'mock',
    estimatedKrw: 500_000,
    quantity: 7,
    stopPrice: 69_000,
    targetPrices: [75_000],
    splitRatios: [40, 30, 30],
    signalReasons: ['지지선 반등'],
    signalWarnings: ['지지선 이탈'],
    signalScore: 59,
    signalConfidence: 54,
    signalRiskReward: 0.9,
    signalState: 'INVALIDATED',
    signalInvalidationReason: 'SIGNAL_CORE_CONDITION_BROKEN',
    state: 'EXPIRED',
    approvalExpiresAt: EXPIRES_AT,
    approval: {
      approvalEnabled: false,
      signalState: 'INVALIDATED',
      planState: 'EXPIRED',
      reasonCode: 'SIGNAL_INVALIDATED',
      expiresAt: EXPIRES_AT,
      lastValidatedAt: READY_AT,
    },
  }),
];

export default function Phase12TradeAutomationE2EPage() {
  return <AutoTradingPage fixture={FIXTURE} approvalFixture={APPROVAL_FIXTURE} v2Fixture={V2_FIXTURE} />;
}
