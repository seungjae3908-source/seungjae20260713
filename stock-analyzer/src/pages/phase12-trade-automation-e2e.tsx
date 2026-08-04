import AutoTradingPage from '@/pages/auto-trading';
import type { TradeAutomationStatus } from '@/components/trade-automation-settings';
import type { TradeApprovalQueueItem } from '@/components/trade-approval-queue';
import type { TradeSignalAlertItem } from '@/components/trade-signal-alerts';

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

const READY_AT = '2099-08-04T05:00:00.000Z';
const EXPIRES_AT = '2099-08-04T05:10:00.000Z';

const ALERT_FIXTURE: TradeSignalAlertItem[] = [
  {
    id: 'ready-plan:1:maintained', planId: 'ready-plan', signalId: 'signal-ready',
    symbol: 'BTC', market: 'KRW', exchange: 'upbit', kind: 'CONDITION_MAINTAINED', cycle: 1,
    title: 'BTC 조건 유지 확인', message: '점수 82 · 신뢰도 78% · 현재 조건 유지 중',
    eventState: 'READY_FOR_APPROVAL', currentSignalState: 'READY_FOR_APPROVAL',
    approvalEnabled: true, approvalReasonCode: null, approvalExpiresAt: EXPIRES_AT,
    score: 82, confidence: 78, reasonCode: 'SIGNAL_READY', createdAt: READY_AT,
  },
  {
    id: 'invalid-plan:1:released', planId: 'invalid-plan', signalId: 'signal-invalid',
    symbol: '005930', market: 'KR', exchange: 'kiwoom', kind: 'CONDITION_RELEASED', cycle: 1,
    title: '005930 조건 해제', message: 'SIGNAL_CORE_CONDITION_BROKEN · 주문 승인 불가',
    eventState: 'INVALIDATED', currentSignalState: 'INVALIDATED', approvalEnabled: false,
    approvalReasonCode: 'SIGNAL_INVALIDATED', approvalExpiresAt: EXPIRES_AT,
    score: 59, confidence: 54, reasonCode: 'SIGNAL_CORE_CONDITION_BROKEN', createdAt: READY_AT,
  },
];

const APPROVAL_FIXTURE: TradeApprovalQueueItem[] = [
  {
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
  },
  {
    id: 'invalid-plan',
    exchange: 'kiwoom',
    accountMode: 'mock',
    strategyId: 'scanner-pullback-v1',
    signalId: 'signal-invalid',
    symbol: '005930',
    market: 'KR',
    side: 'buy',
    orderType: 'market',
    estimatedKrw: 500_000,
    quantity: 7,
    limitPrice: null,
    stopPrice: 69_000,
    targetPrices: [75_000],
    splitRatios: [40, 30, 30],
    leverage: null,
    signalReasons: ['지지선 반등'],
    signalWarnings: ['지지선 이탈'],
    signalScore: 59,
    signalConfidence: 54,
    signalRiskReward: 0.9,
    signalState: 'INVALIDATED',
    signalInvalidationReason: 'SIGNAL_CORE_CONDITION_BROKEN',
    state: 'EXPIRED',
    approvalExpiresAt: EXPIRES_AT,
    updatedAt: READY_AT,
    approval: {
      approvalEnabled: false,
      signalState: 'INVALIDATED',
      planState: 'EXPIRED',
      reasonCode: 'SIGNAL_INVALIDATED',
      expiresAt: EXPIRES_AT,
      lastValidatedAt: READY_AT,
    },
    order: null,
  },
];

export default function Phase12TradeAutomationE2EPage() {
  return <AutoTradingPage fixture={FIXTURE} approvalFixture={APPROVAL_FIXTURE} alertFixture={ALERT_FIXTURE} />;
}
