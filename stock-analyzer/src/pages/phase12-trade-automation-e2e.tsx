import AutoTradingPage from '@/pages/auto-trading';
import type { TradeAutomationStatus } from '@/components/trade-automation-settings';
import { useSearch } from 'wouter';
import type { TradingHolding } from '@/components/trading-holdings-panel';

const HOLDINGS: TradingHolding[] = [
  { id: 'manual-samsung', provider: 'toss', market: 'KR', symbol: '005930', displayName: '삼성전자',
    ownership: 'MANUAL', quantity: 2, averageEntryPrice: 70000, currentPrice: 71000,
    marketValue: 142000, unrealizedPnl: 2000, unrealizedPnlPercent: 1.43,
    currency: 'KRW', side: null, leverage: null, marginMode: null, entryEvidence: null },
  { id: 'auto-sk', provider: 'kiwoom', market: 'KR', symbol: '000660', displayName: 'SK하이닉스',
    ownership: 'AUTO', quantity: 1, averageEntryPrice: 200000, currentPrice: 202000,
    marketValue: 202000, unrealizedPnl: 2000, unrealizedPnlPercent: 1,
    currency: 'KRW', side: null, leverage: null, marginMode: null,
    entryEvidence: { planId: 'test-entry', strategyId: 'test-breakout', signalId: 'test-signal',
      observedAt: '2026-10-11T00:00:00Z', filledAt: '2026-10-11T00:01:00Z',
      entryPrice: 200000, targetPrices: [210000], stopPrice: 196000, protectionStatus: 'UNKNOWN',
      reasons: ['거래량 증가 + 돌파 조건 충족', '진입 당시 저장된 추세 정렬 근거'] } },
];

const emptySignalWindow = (days: 1 | 7 | 30) => ({ days, publicObservationAvailable: false,
  monitoringCycles: 0, monitoredSymbols: null, publicDataSuccesses: null, publicDataFailures: null,
  naturalSignals: null, eligibleCandidates: null, costPolicyBlocked: null, aiReviewBlocked: null,
  riskBlocked: null, handoffFailures: null, workerAdmissions: 0, actualLiveTrades: 0,
  strategyCounts: {}, primaryReasons: [] });
const emptySignalWindows = () => ({ '1d': emptySignalWindow(1), '7d': emptySignalWindow(7),
  '30d': emptySignalWindow(30) });

const FIXTURE: TradeAutomationStatus = {
  policy: {
    mode: 'automatic',
    automaticEnabled: false,
    emergencyStopped: false,
    newEntriesStopped: false,
    marketEnabled: {
      domestic_stock: true,
      us_stock: true,
      crypto_spot: true,
      crypto_futures: true,
    },
    exchangeEnabled: { bitget: true, upbit: true, kiwoom: true, toss: false },
    enabledAssets: { bitget: [], upbit: [], kiwoom: [], toss: [] },
    enabledStrategies: [],
    totalCapitalKrw: 5_000_000,
    maxOrderKrw: 1_000_000,
    dailyLossLimitPercent: 5,
    maxAssetPercent: 30,
    maxOpenPositions: 5,
    maxDailyOrders: 0,
    maxConsecutiveLosses: 3,
    bitgetLeverage: 2,
    pilotStage: 'approval-20',
    capitalAllocationByMarket: {
      domestic_stock: { configured: false, operatingCapitalKrw: 0, maxOrderKrw: 500_000, compoundAboveAllocation: false, policyVersion: 'user-market-capital-v1', updatedAt: null, accountScopeId: null },
      us_stock: { configured: false, operatingCapitalKrw: 0, maxOrderKrw: 500_000, compoundAboveAllocation: false, policyVersion: 'user-market-capital-v1', updatedAt: null, accountScopeId: null },
      crypto_spot: { configured: true, operatingCapitalKrw: 250_000, maxOrderKrw: 50_000, compoundAboveAllocation: false, policyVersion: 'user-market-capital-v1', updatedAt: '2026-10-14T08:59:00.000Z', accountScopeId: 'a'.repeat(24) },
      crypto_futures: { configured: false, operatingCapitalKrw: 0, maxOrderKrw: 500_000, compoundAboveAllocation: false, policyVersion: 'user-market-capital-v1', updatedAt: null, accountScopeId: null },
    },
  },
  connections: [
    { exchange: 'bitget', accountMode: 'paper', configured: true, lastVerifiedAt: null, lastErrorCode: null, credentialsExposed: false },
    { exchange: 'upbit', accountMode: 'paper', configured: true, lastVerifiedAt: null, lastErrorCode: null, credentialsExposed: false },
    { exchange: 'kiwoom', accountMode: 'paper', configured: true, lastVerifiedAt: null, lastErrorCode: null, credentialsExposed: false },
  ],
  emergencyStopped: false,
  credentialVault: { encryptionConfigured: true, keyValueExposed: false },
  lastOrder: null,
  dailyProfitTargetByMarket: {
    crypto_spot: {
      market: 'crypto_spot', tradingDay: '2026-10-14', timeZone: 'Asia/Seoul',
      enabled: true, targetPercent: 3, afterTargetAction: 'PROFIT_PROTECTION',
      realizedNetProfitKrw: 15_000, unrealizedPnlKrw: -500, highNetProfitKrw: 16_000,
      realizedReturnPercent: 3, remainingTargetPercent: 0, targetReached: true,
      profitProtectionActive: true, compoundProfitShare: 0.5, reserveProfitShare: 0.5,
      protectionRiskBudgetKrw: 1_000, newEntryAllowed: false,
      newEntryBlockReason: 'DAILY_PROFIT_TARGET_STRENGTHENED_SIGNAL_REQUIRED',
      observedAt: '2026-10-14T09:00:00.000Z',
    },
  },
  currentStrategyPlanByMarket: {
    crypto_spot: {
      strategyId: 'TREND_PULLBACK_REACCEL_V1', stopPrice: 98_000,
      targetPrices: [103_000, 105_000], updatedAt: '2026-10-14T09:00:00.000Z',
    },
  },
  capitalAllocationReadinessByMarket: {
    crypto_spot: {
      market: 'crypto_spot', provider: 'upbit', currency: 'KRW', verified: true,
      actualAvailableKrw: 500_000, roleMaximumKrw: 500_000, currentlyAllocatedKrw: 250_000,
      currentMaximumConfigurableKrw: 500_000, excludedKrw: 250_000,
      accountScopeId: 'a'.repeat(24), reason: null, observedAt: '2026-10-14T09:00:00.000Z',
      futuresMarginAllocationKrw: null, futuresNominalCeilingKrw: null,
    },
  },
  externalPilotSignalStatistics: {
    schemaVersion: 'external-strategy-pilot-signal-statistics-v1',
    naturalObservationSource: 'LIVE_PUBLIC_PRODUCER_HISTORY',
    userAdmissionSource: 'DURABLE_PLAN_ORDER_LEDGER', replayAndFixtureExcluded: true,
    byMarket: {
      domestic_stock: emptySignalWindows(), us_stock: emptySignalWindows(),
      crypto_futures: emptySignalWindows(),
      crypto_spot: {
        '1d': { ...emptySignalWindow(1), publicObservationAvailable: true, monitoringCycles: 1,
          monitoredSymbols: 3, publicDataSuccesses: 3, publicDataFailures: 0, naturalSignals: 0,
          eligibleCandidates: 0, costPolicyBlocked: 0, aiReviewBlocked: 0, riskBlocked: 0,
          handoffFailures: 0, primaryReasons: ['UPBIT_PILOT_NO_SIGNAL'] },
        '7d': emptySignalWindow(7), '30d': emptySignalWindow(30),
      },
    },
  },
};

export default function Phase12TradeAutomationE2EPage() {
  const search = useSearch();
  const initialMode = new URLSearchParams(search).get('mode') === 'paper' ? 'paper' : 'auto';
  const params = new URLSearchParams(search);
  return <AutoTradingPage fixture={FIXTURE} initialMode={initialMode}
    paperOrigin={params.get('kind') === 'manual' ? 'manual' : 'automatic'}
    holdingsFixture={params.get('holdings') === 'true' ? HOLDINGS.map(row => params.get('missingFillPrice') === 'true' && row.entryEvidence
      ? { ...row, entryEvidence: { ...row.entryEvidence, entryPrice: null } } : row) : []} />;
}
