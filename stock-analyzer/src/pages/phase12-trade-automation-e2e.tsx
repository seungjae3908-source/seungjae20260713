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
    maxDailyOrders: 10,
    maxConsecutiveLosses: 3,
    bitgetLeverage: 2,
    pilotStage: 'approval-20',
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
  const search = useSearch();
  const initialMode = new URLSearchParams(search).get('mode') === 'paper' ? 'paper' : 'auto';
  const params = new URLSearchParams(search);
  return <AutoTradingPage fixture={FIXTURE} initialMode={initialMode}
    paperOrigin={params.get('kind') === 'manual' ? 'manual' : 'automatic'}
    holdingsFixture={params.get('holdings') === 'true' ? HOLDINGS.map(row => params.get('missingFillPrice') === 'true' && row.entryEvidence
      ? { ...row, entryEvidence: { ...row.entryEvidence, entryPrice: null } } : row) : []} />;
}
