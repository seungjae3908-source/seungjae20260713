export type BrokerProviderId = 'toss' | 'kiwoom' | 'upbit' | 'bitget';

export type BrokerMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';

export type BrokerCapability =
  | 'accounts'
  | 'balances'
  | 'holdings'
  | 'positions'
  | 'open_orders'
  | 'order_history'
  | 'fills'
  | 'place_order'
  | 'cancel_order'
  | 'amend_order'
  | 'reconcile_order';

export type BrokerProviderCapabilities = {
  provider: BrokerProviderId;
  markets: readonly BrokerMarket[];
  capabilities: readonly BrokerCapability[];
  supportsLiveTrading: boolean;
  supportsOfficialMock: boolean;
  supportsPrivateWebSocket: boolean;
  withdrawalSupported: false;
  transferSupported: false;
};

export type BrokerConnectionState =
  | 'UNCONFIGURED'
  | 'WAITING_FOR_ACCESS'
  | 'CONFIGURED'
  | 'CONNECTED_READ_ONLY'
  | 'TRADE_READY'
  | 'AUTH_EXPIRED'
  | 'PERMISSION_MISSING'
  | 'PROVIDER_DOWN';

export type BrokerConnectionStatus = {
  provider: BrokerProviderId;
  state: BrokerConnectionState;
  configured: boolean;
  connected: boolean;
  readPermission: boolean;
  tradePermission: boolean;
  checkedAt: string;
  errorCode: string | null;
};

export type BrokerAccount = {
  provider: BrokerProviderId;
  accountId: string;
  accountMasked: string | null;
  accountType: string | null;
  currency: string | null;
};

export type BrokerBalance = {
  provider: BrokerProviderId;
  accountId: string;
  currency: string;
  available: number | null;
  locked: number | null;
  equity: number | null;
  observedAt: string;
};

export type BrokerHolding = {
  provider: BrokerProviderId;
  accountId: string;
  market: BrokerMarket;
  symbol: string;
  name: string | null;
  currency: string;
  quantity: number;
  availableQuantity: number | null;
  averagePrice: number | null;
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  observedAt: string;
};

export type BrokerPosition = BrokerHolding & {
  side: 'LONG' | 'SHORT';
  leverage: number | null;
  marginMode: 'CROSSED' | 'ISOLATED' | null;
  liquidationPrice: number | null;
};

export type BrokerFill = {
  provider: BrokerProviderId;
  accountId: string;
  orderId: string;
  fillId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  feeAmount: number | null;
  feeCurrency: string | null;
  filledAt: string;
};

export type BrokerOrderState =
  | 'PENDING'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCEL_PENDING'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'UNKNOWN';

export type BrokerOrder = {
  provider: BrokerProviderId;
  accountId: string;
  providerOrderId: string | null;
  clientOrderId: string | null;
  market: BrokerMarket;
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  state: BrokerOrderState;
  requestedQuantity: number | null;
  requestedAmount: number | null;
  requestedPrice: number | null;
  filledQuantity: number;
  averageFillPrice: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type BrokerOrderRequest = {
  accountId: string;
  market: BrokerMarket;
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  clientOrderId: string;
  quantity?: number | null;
  orderAmount?: number | null;
  price?: number | null;
  reduceOnly?: boolean;
};

export type BrokerAmendRequest = {
  accountId: string;
  providerOrderId: string;
  market: BrokerMarket;
  symbol: string;
  clientOrderId?: string | null;
  quantity?: number | null;
  price?: number | null;
};

export type BrokerOrderQuery = {
  accountId: string;
  market?: BrokerMarket;
  symbol?: string;
  status?: 'OPEN' | 'CLOSED';
  cursor?: string;
  limit?: number;
};

export type BrokerOrderReference = {
  accountId: string;
  providerOrderId?: string | null;
  clientOrderId?: string | null;
  market?: BrokerMarket;
  symbol?: string;
};

/**
 * Common provider boundary. AI/scanner code never receives this interface;
 * only the execution policy and reconciliation layers may own an instance.
 */
export interface BrokerProviderAdapter {
  readonly provider: BrokerProviderId;
  getCapabilities(): BrokerProviderCapabilities;
  getConnectionStatus(): Promise<BrokerConnectionStatus>;
  getAccounts(): Promise<BrokerAccount[]>;
  getBalances(accountId: string): Promise<BrokerBalance[]>;
  getHoldings(accountId: string): Promise<BrokerHolding[]>;
  getPositions(accountId: string): Promise<BrokerPosition[]>;
  getOpenOrders(query: BrokerOrderQuery): Promise<BrokerOrder[]>;
  getOrderHistory(query: BrokerOrderQuery): Promise<BrokerOrder[]>;
  getFills(query: BrokerOrderQuery): Promise<BrokerFill[]>;
  placeOrder(order: BrokerOrderRequest): Promise<BrokerOrder>;
  cancelOrder(order: BrokerOrderReference): Promise<BrokerOrder>;
  amendOrder(order: BrokerAmendRequest): Promise<BrokerOrder>;
  getOrder(order: BrokerOrderReference): Promise<BrokerOrder>;
  reconcileOrder(order: BrokerOrderReference): Promise<BrokerOrder>;
}

const COMMON_CAPABILITIES = [
  'accounts', 'balances', 'holdings', 'positions', 'open_orders', 'order_history',
  'fills', 'place_order', 'cancel_order', 'amend_order', 'reconcile_order',
] as const satisfies readonly BrokerCapability[];

export const BROKER_PROVIDER_CAPABILITIES: Readonly<Record<BrokerProviderId, BrokerProviderCapabilities>> = Object.freeze({
  toss: {
    provider: 'toss',
    markets: ['KR_STOCK', 'US_STOCK'],
    capabilities: COMMON_CAPABILITIES,
    supportsLiveTrading: true,
    supportsOfficialMock: false,
    supportsPrivateWebSocket: false,
    withdrawalSupported: false,
    transferSupported: false,
  },
  kiwoom: {
    provider: 'kiwoom',
    markets: ['KR_STOCK', 'US_STOCK'],
    capabilities: COMMON_CAPABILITIES,
    supportsLiveTrading: true,
    supportsOfficialMock: true,
    supportsPrivateWebSocket: true,
    withdrawalSupported: false,
    transferSupported: false,
  },
  upbit: {
    provider: 'upbit',
    markets: ['CRYPTO_SPOT'],
    capabilities: COMMON_CAPABILITIES,
    supportsLiveTrading: true,
    supportsOfficialMock: false,
    supportsPrivateWebSocket: true,
    withdrawalSupported: false,
    transferSupported: false,
  },
  bitget: {
    provider: 'bitget',
    markets: ['CRYPTO_FUTURES'],
    capabilities: COMMON_CAPABILITIES,
    supportsLiveTrading: true,
    supportsOfficialMock: false,
    supportsPrivateWebSocket: true,
    withdrawalSupported: false,
    transferSupported: false,
  },
});

export const STOCK_PROVIDER_PRIORITY = ['toss', 'kiwoom'] as const satisfies readonly BrokerProviderId[];

export function getBrokerProviderCapabilities(provider: BrokerProviderId): BrokerProviderCapabilities {
  return BROKER_PROVIDER_CAPABILITIES[provider];
}

export function selectStockProvider(connected: Partial<Record<BrokerProviderId, boolean>>): 'toss' | 'kiwoom' | null {
  return connected.toss ? 'toss' : connected.kiwoom ? 'kiwoom' : null;
}
