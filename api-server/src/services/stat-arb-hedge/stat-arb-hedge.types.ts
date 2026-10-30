/**
 * stat-arb two-leg hedge adapter — shared types.
 *
 * Scope (owner directive 2026-10-20): a DEDICATED adapter for the crypto
 * stat-arb strategies (crypto-stat-arb/, PR #2004). It is NOT wired into the
 * existing single-leg Bitget handoff and never submits real orders in this
 * stage: the only exchange port implemented is the scripted mock, and the
 * adapter refuses to run a LIVE authority against it.
 */

export const STAT_ARB_HEDGE_SIGNAL_SCHEMA = 'stat-arb-hedge-signal-v1' as const;

export type HedgeVenue = 'upbit' | 'bitget' | 'binance' | 'hyperliquid';
export type HedgeProduct = 'spot' | 'usdt_perp';
export type HedgeLegRole = 'SPOT' | 'PERP';
export type HedgeLegSide = 'buy' | 'sell' | 'long' | 'short';
export type HedgeAction = 'ENTER' | 'EXIT';
export type HedgeQuoteCurrency = 'KRW' | 'USDT';
export type HedgePriceType = 'market' | 'limit';

export type HedgeLegSpec = Readonly<{
  legId: string;
  role: HedgeLegRole;
  venue: HedgeVenue;
  product: HedgeProduct;
  /** Venue-native symbol, e.g. `KRW-BTC` (Upbit) / `BTCUSDT` (Bitget). */
  symbol: string;
  side: HedgeLegSide;
  /** Base-asset quantity (BTC). Both legs are sized in the same base asset. */
  quantity: number;
  priceType: HedgePriceType;
  limitPrice?: number | null;
  /** Price the strategy used when it sized the leg; slippage is measured against it. */
  referencePrice: number;
  quoteCurrency: HedgeQuoteCurrency;
}>;

export type HedgeFxQuote = Readonly<{
  krwPerUsdt: number;
  asOfMs: number;
  source: string;
}>;

/** Explicit signal schema (directive §2: strategy ID, signal ID, signal time,
 * data time, exchange, product, symbol, side, quantity, price). */
export type HedgeSignal = Readonly<{
  schema: typeof STAT_ARB_HEDGE_SIGNAL_SCHEMA;
  strategyId: string;
  strategyVersion: string;
  parameterHash: string;
  /** 40-hex commit of crypto-stat-arb/ that produced the strategy + evidence. */
  researchCodeSha: string;
  signalId: string;
  signalAtMs: number;
  dataAsOfMs: number;
  maxDataAgeMs: number;
  expiresAtMs: number;
  action: HedgeAction;
  /** EXIT only: the pair opened by the matching ENTER. */
  pairId?: string | null;
  legs: readonly [HedgeLegSpec, HedgeLegSpec];
  fx: HedgeFxQuote;
  leverage: number;
  marginMode: 'isolated';
}>;

/** One summary row of crypto-stat-arb `summary.csv` (PR #2004 columns). */
export type PerformanceEvidenceRow = Readonly<{
  window: string;
  strategy: string;
  cost_profile: string;
  leverage: number;
  status: string;
  data_verdict: string;
  window_start: string;
  window_end_exclusive: string;
  net_return: number;
  trades: number;
  liquidations: number;
  pf_net: number | null;
  mdd: number | null;
}>;

export type PerformanceEvidence = Readonly<{
  researchCodeSha: string;
  generatedAtMs: number;
  rows: readonly PerformanceEvidenceRow[];
}>;

export type PerformanceGateThresholds = Readonly<{
  costProfile: string;
  minWindowDays: number;
  minTrades: number;
  minNetReturn: number;
  minProfitFactor: number;
  maxLiquidations: number;
}>;

export type PerformanceGateDecision = Readonly<{
  authority: 'NONE' | 'LIVE_ELIGIBLE';
  reasons: readonly string[];
  matchedRows: readonly PerformanceEvidenceRow[];
}>;

/** What the adapter is allowed to do. `NONE` is the default and places nothing.
 * `MOCK` drives the scripted mock exchange only. `LIVE` has no port in this PR. */
export type HedgeExecutionAuthority = 'NONE' | 'MOCK' | 'LIVE';

export type HedgeLegStatus =
  | 'PENDING' | 'SUBMITTED' | 'PARTIALLY_FILLED' | 'FILLED'
  | 'REJECTED' | 'CANCELLED' | 'TIMEOUT' | 'UNKNOWN';

export type HedgeLegState = {
  legId: string;
  role: HedgeLegRole;
  venue: HedgeVenue;
  product: HedgeProduct;
  symbol: string;
  side: HedgeLegSide;
  quoteCurrency: HedgeQuoteCurrency;
  clientOrderId: string;
  exchangeOrderId: string | null;
  status: HedgeLegStatus;
  /** What the strategy asked for (after step rounding). */
  targetQuantity: number;
  /** What the venue confirmed. Never assumed. */
  filledQuantity: number;
  averagePrice: number | null;
  referencePrice: number;
  slippageBps: number | null;
  feePaid: number;
  feeCurrency: HedgeQuoteCurrency;
  submittedAtMs: number | null;
  firstFillAtMs: number | null;
  lastUpdateAtMs: number | null;
  rejectReason: string | null;
};

export type HedgePairPhase =
  | 'PLANNED' | 'LEG1_SUBMITTED' | 'LEG1_FILLED' | 'LEG2_SUBMITTED'
  | 'HEDGED' | 'UNBALANCED' | 'UNWINDING' | 'UNWOUND'
  | 'EXITING' | 'CLOSED' | 'UNKNOWN' | 'REJECTED';

export type HedgePairEvent = Readonly<{
  atMs: number;
  code: string;
  detail?: string;
}>;

export type HedgeExposure = Readonly<{
  spotQuantity: number;
  perpQuantity: number;
  spotNotionalKrw: number;
  perpNotionalKrw: number;
  /** spot − perp, base units. Positive = net long. */
  imbalanceQuantity: number;
  imbalanceBps: number;
  balanced: boolean;
}>;

export type HedgePairState = {
  pairId: string;
  userId: string;
  strategyId: string;
  strategyVersion: string;
  researchCodeSha: string;
  entrySignalId: string;
  exitSignalId: string | null;
  simulated: boolean;
  phase: HedgePairPhase;
  legs: { SPOT: HedgeLegState; PERP: HedgeLegState };
  exitLegs: { SPOT: HedgeLegState; PERP: HedgeLegState } | null;
  leverage: number;
  fxKrwPerUsdt: number;
  maxImbalanceBps: number;
  exposure: HedgeExposure;
  /** USDT funding actually paid/received; null until a venue reports it. */
  fundingPaidUsdt: number | null;
  fundingStatus: 'NOT_AVAILABLE_LIVE' | 'REPORTED';
  realizedPnlKrw: number | null;
  unrealizedPnlKrw: number | null;
  blockCodes: string[];
  haltReason: string | null;
  events: HedgePairEvent[];
  createdAtMs: number;
  updatedAtMs: number;
};

/* ----------------------------- ports ------------------------------------ */

export type HedgeOrderRequest = Readonly<{
  clientOrderId: string;
  venue: HedgeVenue;
  product: HedgeProduct;
  symbol: string;
  side: HedgeLegSide;
  quantity: number;
  priceType: HedgePriceType;
  limitPrice?: number | null;
  reduceOnly?: boolean;
  leverage?: number | null;
  marginMode?: 'isolated' | null;
}>;

export type HedgeOrderSnapshot = Readonly<{
  status: 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'REJECTED' | 'CANCELLED' | 'UNKNOWN';
  exchangeOrderId: string | null;
  filledQuantity: number;
  averagePrice: number | null;
  fee: number;
  feeCurrency: HedgeQuoteCurrency;
  reason: string | null;
  updatedAtMs: number;
}>;

export type HedgeInstrumentRules = Readonly<{
  minQuantity: number;
  quantityStep: number;
  priceStep: number;
  /** In the leg's quote currency. */
  minNotional: number;
  tradable: boolean;
}>;

export type HedgePositionSnapshot = Readonly<{
  quantity: number;
  side: 'long' | 'short' | null;
  averagePrice: number | null;
  unrealizedPnl: number | null;
}>;

export interface HedgeExchangePort {
  readonly venue: HedgeVenue;
  readonly kind: 'mock' | 'live';
  instrumentRules(symbol: string, product: HedgeProduct): Promise<HedgeInstrumentRules>;
  readAvailable(quote: HedgeQuoteCurrency): Promise<number>;
  readPosition(symbol: string, product: HedgeProduct): Promise<HedgePositionSnapshot>;
  placeOrder(request: HedgeOrderRequest): Promise<HedgeOrderSnapshot>;
  queryOrder(clientOrderId: string, symbol: string): Promise<HedgeOrderSnapshot | null>;
  cancelOrder(clientOrderId: string, symbol: string): Promise<HedgeOrderSnapshot>;
  /** Optional: venues that expose funding history. Absent = NOT_AVAILABLE_LIVE. */
  readFundingPaidUsdt?(symbol: string, sinceMs: number): Promise<number | null>;
}

export interface HedgePairStore {
  load(pairId: string): Promise<HedgePairState | null>;
  save(state: HedgePairState): Promise<void>;
  listOpen(userId: string): Promise<HedgePairState[]>;
  findBySignal(userId: string, signalId: string, action: HedgeAction): Promise<HedgePairState | null>;
}

export type HedgeControlSnapshot = Readonly<{
  emergencyStopped: boolean;
  newEntriesStopped: boolean;
  /** Per-venue API permission flags read from the member's credential scope. */
  canPlaceOrders: Readonly<Record<HedgeVenue, boolean>>;
  canCancelOrders: Readonly<Record<HedgeVenue, boolean>>;
  /** Member policy leverage for Bitget (existing policy row, 2–7 live). */
  policyBitgetLeverage: number;
  roleCapKrw: number;
  policyMaxOrderKrw: number;
}>;

export interface HedgeControlPort {
  read(userId: string): Promise<HedgeControlSnapshot>;
}

export type HedgeLedgerMarketInput = Readonly<{
  allocatedKrw: number;
  openOrderReservedKrw: number;
  positionMarginKrw: number;
  realizedPnlKrw: number | null;
  costsKrw: number | null;
  exchangeAvailableKrw: number | null;
}>;

export interface HedgeLedgerPort {
  read(userId: string): Promise<Readonly<{ crypto_spot: HedgeLedgerMarketInput; crypto_futures: HedgeLedgerMarketInput }>>;
}

export type HedgeConflictSnapshot = Readonly<{
  /** Existing automatic/manual positions on this venue+symbol from OTHER strategies. */
  foreignPositionSide: 'long' | 'short' | null;
  foreignOpenOrders: number;
  foreignStrategyIds: readonly string[];
}>;

export interface HedgeConflictPort {
  read(userId: string, venue: HedgeVenue, symbol: string): Promise<HedgeConflictSnapshot>;
}

export type HedgeAlert = Readonly<{
  type: 'risk_block' | 'system_critical';
  title: string;
  details: string;
  dedupeKey: string;
}>;

export interface HedgeAlertPort {
  send(alert: HedgeAlert): Promise<void>;
}

export interface HedgeClock {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

export type HedgeAdapterConfig = Readonly<{
  userId: string;
  executionAuthority: HedgeExecutionAuthority;
  /** 100 bps = 1%. Larger hedge mismatch → UNBALANCED, new entries blocked. */
  maxImbalanceBps: number;
  legFillTimeoutMs: number;
  pollIntervalMs: number;
  maxFxAgeMs: number;
  performanceThresholds: PerformanceGateThresholds;
}>;

export type HedgeAdapterPorts = Readonly<{
  exchanges: Readonly<Partial<Record<HedgeVenue, HedgeExchangePort>>>;
  store: HedgePairStore;
  control: HedgeControlPort;
  ledger: HedgeLedgerPort;
  conflicts: HedgeConflictPort;
  alerts: HedgeAlertPort;
  clock: HedgeClock;
}>;

export type HedgeEnterResult = Readonly<{
  accepted: boolean;
  pair: HedgePairState | null;
  blockCodes: readonly string[];
  simulated: boolean;
}>;

export class HedgeOrderTimeoutError extends Error {
  readonly code = 'HEDGE_ORDER_TIMEOUT';
  constructor(message = 'order request timed out') { super(message); this.name = 'HedgeOrderTimeoutError'; }
}

export class HedgeOrderDisconnectError extends Error {
  readonly code = 'HEDGE_ORDER_DISCONNECT';
  constructor(message = 'connection lost after submit') { super(message); this.name = 'HedgeOrderDisconnectError'; }
}
