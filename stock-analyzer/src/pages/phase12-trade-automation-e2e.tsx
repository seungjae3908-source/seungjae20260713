import AutoTradingPage from '@/pages/auto-trading';
import type { TradeAutomationStatus } from '@/components/trade-automation-settings';

const FIXTURE: TradeAutomationStatus = {
  policy: {
    mode: 'automatic',
    automaticEnabled: false,
    emergencyStopped: false,
    marketEnabled: {
      domestic_stock: true,
      us_stock: true,
      crypto_spot: true,
      crypto_futures: true,
    },
    exchangeEnabled: { bitget: true, upbit: true, kiwoom: true },
    enabledAssets: { bitget: [], upbit: [], kiwoom: [] },
    enabledStrategies: [],
    totalCapitalKrw: 5_000_000,
    maxOrderKrw: 1_000_000,
    dailyLossLimitPercent: 5,
    maxAssetPercent: 30,
    maxOpenPositions: 5,
    maxDailyOrders: 10,
    maxConsecutiveLosses: 3,
    bitgetLeverage: 2,
  },
  connections: [
    { exchange: 'bitget', accountMode: 'paper', configured: true, lastVerifiedAt: null, lastErrorCode: null, credentialsExposed: false },
    { exchange: 'upbit', accountMode: 'paper', configured: true, lastVerifiedAt: null, lastErrorCode: null, credentialsExposed: false },
    { exchange: 'kiwoom', accountMode: 'paper', configured: true, lastVerifiedAt: null, lastErrorCode: null, credentialsExposed: false },
  ],
  emergencyStopped: false,
  credentialVault: { encryptionConfigured: true, keyValueExposed: false },
  lastOrder: null,
};

export default function Phase12TradeAutomationE2EPage() {
  return <AutoTradingPage fixture={FIXTURE} />;
}
