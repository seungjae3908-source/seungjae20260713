import AutoTradingPage from '@/pages/auto-trading';
import type { TradeAutomationStatus } from '@/components/trade-automation-settings';

const FIXTURE: TradeAutomationStatus = {
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
};

export default function Phase12TradeAutomationE2EPage() {
  return <AutoTradingPage fixture={FIXTURE} />;
}
