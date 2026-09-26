import {
  MEMBER_INVESTMENT_SAFETY,
  type AccountSnapshot,
  type AutomationPolicy,
  type BrokerExchangeConnection,
  type OrderIntent,
  type RiskGateResult,
  type RiskMetrics,
} from './member-investment.contract';

const MAX_ACCOUNT_DATA_AGE_MS = 60_000;
const MAX_SIGNAL_AGE_MS = 60_000;

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function validMarketDirection(intent: OrderIntent) {
  if (intent.market === 'KR_STOCK' || intent.market === 'US_STOCK' || intent.market === 'CRYPTO_SPOT') {
    return intent.positionSide === null && ['BUY', 'REDUCE', 'EXIT'].includes(intent.side);
  }
  if (intent.market === 'CRYPTO_FUTURES') {
    if (intent.side === 'LONG' || intent.side === 'SHORT') return intent.positionSide === intent.side;
    return ['REDUCE', 'EXIT'].includes(intent.side) && (intent.positionSide === 'LONG' || intent.positionSide === 'SHORT');
  }
  return false;
}

function timestamp(value: string, now: Date, maximumAgeMs: number) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'INVALID';
  if (parsed > now.getTime() + 5_000) return 'FUTURE';
  if (now.getTime() - parsed > maximumAgeMs) return 'STALE';
  return 'FRESH';
}

export function evaluateMemberInvestmentRisk(input: {
  authenticatedUserId: string;
  intent: OrderIntent;
  connection: BrokerExchangeConnection | null;
  snapshot: AccountSnapshot | null;
  policy: AutomationPolicy | null;
  metrics: RiskMetrics;
  now?: Date;
}): RiskGateResult {
  const now = input.now ?? new Date();
  const reasons: string[] = [];
  const { intent, connection, snapshot, policy, metrics } = input;

  if (!input.authenticatedUserId.trim() || intent.userId !== input.authenticatedUserId) reasons.push('MEMBER_SCOPE_MISMATCH');
  if (!connection) reasons.push('ACCOUNT_CONNECTION_MISSING');
  else {
    if (connection.userId !== input.authenticatedUserId || connection.id !== intent.connectionId) reasons.push('ACCOUNT_CONNECTION_OWNER_MISMATCH');
    if (connection.connectionStatus !== 'CONNECTED') reasons.push('ACCOUNT_CONNECTION_UNHEALTHY');
    if (!connection.readOnlyCapable) reasons.push('ACCOUNT_READ_CAPABILITY_MISSING');
    if (!connection.credentialReference || !connection.credentialVersion) reasons.push('CREDENTIAL_REFERENCE_MISSING');
  }

  if (!snapshot) reasons.push('ACCOUNT_SNAPSHOT_MISSING');
  else {
    if (snapshot.userId !== input.authenticatedUserId || snapshot.connectionId !== intent.connectionId) reasons.push('ACCOUNT_SNAPSHOT_OWNER_MISMATCH');
    if (snapshot.freshnessStatus !== 'FRESH') reasons.push(`ACCOUNT_DATA_${snapshot.freshnessStatus}`);
    if (snapshot.providerStatus !== 'HEALTHY') reasons.push('PROVIDER_DEGRADED');
    const dataTimestamp = timestamp(snapshot.dataAsOf, now, MAX_ACCOUNT_DATA_AGE_MS);
    if (dataTimestamp !== 'FRESH') reasons.push(`ACCOUNT_DATA_${dataTimestamp}`);
    if (!finitePositive(snapshot.totalEquity)) reasons.push('ACCOUNT_EQUITY_UNAVAILABLE');
  }

  if (!policy) reasons.push('AUTOMATION_POLICY_MISSING');
  else {
    if (policy.userId !== input.authenticatedUserId || policy.connectionId !== intent.connectionId) reasons.push('AUTOMATION_POLICY_OWNER_MISMATCH');
    if (!policy.enabled) reasons.push('STRATEGY_DISABLED');
    if (policy.executionMode === 'LIVE') reasons.push('LIVE_ACTIVATION_NOT_APPROVED');
    if (policy.killSwitch) reasons.push('KILL_SWITCH_ACTIVE');
    if (policy.market !== intent.market) reasons.push('MARKET_NOT_ALLOWED');
    if (policy.strategyId !== intent.strategyId) reasons.push('STRATEGY_MISMATCH');
    if (!policy.allowedSymbols.includes(intent.symbol)) reasons.push('SYMBOL_NOT_ALLOWED');
  }

  if (!validMarketDirection(intent)) reasons.push('MARKET_DIRECTION_NOT_ALLOWED');
  if (!finitePositive(intent.requestedQuantity)) reasons.push('QUANTITY_INVALID');
  if (!finitePositive(intent.requestedPrice)) reasons.push('PRICE_INVALID');
  if (timestamp(intent.sourceSignalGeneratedAt, now, MAX_SIGNAL_AGE_MS) !== 'FRESH') reasons.push('SIGNAL_STALE_OR_INVALID');
  const expiry = Date.parse(intent.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) reasons.push('SIGNAL_EXPIRED');
  if (metrics.duplicateIntent) reasons.push('DUPLICATE_ORDER_INTENT');

  if (policy) {
    const requestedValue = intent.requestedQuantity * intent.requestedPrice;
    if (!Number.isFinite(requestedValue) || requestedValue > policy.maxPositionValue) reasons.push('POSITION_VALUE_LIMIT_EXCEEDED');
    if (snapshot?.totalEquity && requestedValue / snapshot.totalEquity * 100 > policy.maxPositionPct) reasons.push('POSITION_PERCENT_LIMIT_EXCEEDED');
    if (metrics.currentPositionValue == null) reasons.push('POSITION_EVIDENCE_MISSING');
    else if (metrics.currentPositionValue + requestedValue > policy.maxPositionValue) reasons.push('POSITION_LIMIT_EXCEEDED');
    if (metrics.dailyLoss == null) reasons.push('DAILY_LOSS_EVIDENCE_MISSING');
    else if (metrics.dailyLoss >= policy.maxDailyLoss) reasons.push('DAILY_LOSS_LIMIT_EXCEEDED');
    if (metrics.drawdown == null) reasons.push('DRAWDOWN_EVIDENCE_MISSING');
    else if (metrics.drawdown >= policy.maxDrawdown) reasons.push('DRAWDOWN_LIMIT_EXCEEDED');
    if (metrics.ordersToday == null) reasons.push('ORDER_COUNT_EVIDENCE_MISSING');
    else if (metrics.ordersToday >= policy.maxOrdersPerDay) reasons.push('ORDER_COUNT_LIMIT_EXCEEDED');
    if (metrics.concurrentPositions == null) reasons.push('POSITION_COUNT_EVIDENCE_MISSING');
    else if (metrics.concurrentPositions >= policy.maxConcurrentPositions) reasons.push('CONCURRENT_POSITION_LIMIT_EXCEEDED');
    if (metrics.lastIntentAt) {
      const lastIntentAt = Date.parse(metrics.lastIntentAt);
      if (!Number.isFinite(lastIntentAt) || now.getTime() - lastIntentAt < policy.cooldownSeconds * 1_000) reasons.push('COOLDOWN_ACTIVE');
    }
    if (intent.market === 'CRYPTO_FUTURES') {
      if (!finitePositive(intent.leverage) || intent.leverage < policy.leverageMin || intent.leverage > policy.leverageMax) reasons.push('LEVERAGE_LIMIT_VIOLATION');
      if (metrics.liquidationDistancePct == null) reasons.push('LIQUIDATION_BUFFER_EVIDENCE_MISSING');
      else if (metrics.liquidationDistancePct < policy.minLiquidationBufferPct) reasons.push('LIQUIDATION_BUFFER_INSUFFICIENT');
    } else if (intent.leverage != null) reasons.push('LEVERAGE_NOT_ALLOWED');
    if (policy.stopLossRequired && !finitePositive(intent.stopLoss)) reasons.push('STOP_LOSS_REQUIRED');
    if (policy.takeProfitRequired && !finitePositive(intent.takeProfit)) reasons.push('TAKE_PROFIT_REQUIRED');
  }

  const normalized = unique(reasons);
  return {
    allowed: normalized.length === 0,
    decision: normalized.length === 0 ? 'PREVIEW_ONLY' : 'BLOCKED',
    status: normalized.length === 0 ? 'PREVIEW_READY' : 'RISK_BLOCKED',
    reasons: normalized,
    checkedAt: now.toISOString(),
    safety: MEMBER_INVESTMENT_SAFETY,
  };
}
