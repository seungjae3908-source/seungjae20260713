import { getUserSupabase } from '../../lib/supabase';
import type {
  AccountSnapshot,
  AutomationPolicy,
  BrokerExchangeConnection,
  CryptoSpotHolding,
  ExecutionPreview,
  FuturesPosition,
  OrderIntent,
  RiskMetrics,
  StockHolding,
} from './member-investment.contract';

export type MemberInvestmentOverview = {
  connections: BrokerExchangeConnection[];
  snapshots: AccountSnapshot[];
  stockHoldings: StockHolding[];
  cryptoSpotHoldings: CryptoSpotHolding[];
  futuresPositions: FuturesPosition[];
  policies: AutomationPolicy[];
  intents: OrderIntent[];
};

export interface MemberInvestmentRepository {
  getOverview(userId: string): Promise<MemberInvestmentOverview>;
  getConnection(userId: string, connectionId: string): Promise<BrokerExchangeConnection | null>;
  getLatestSnapshot(userId: string, connectionId: string): Promise<AccountSnapshot | null>;
  getPolicy(userId: string, policyId: string): Promise<AutomationPolicy | null>;
  savePolicy(policy: AutomationPolicy): Promise<AutomationPolicy>;
  findIntentByIdempotency(userId: string, key: string): Promise<OrderIntent | null>;
  saveIntent(intent: OrderIntent): Promise<OrderIntent>;
  listIntents(userId: string): Promise<OrderIntent[]>;
  savePreview(preview: ExecutionPreview): Promise<void>;
  getRiskMetrics(userId: string, connectionId: string, symbol: string, now: Date): Promise<RiskMetrics>;
  appendAudit(input: { userId: string; eventType: string; entityType: string; entityId: string; payload: Record<string, unknown>; occurredAt: string }): Promise<void>;
}

const clone = <T>(value: T): T => structuredClone(value);
const nullableNumber = (value: unknown) => value === null || value === undefined || value === ''
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const stringOrNull = (value: unknown) => typeof value === 'string' && value ? value : null;

export class InMemoryMemberInvestmentRepository implements MemberInvestmentRepository {
  private connections: BrokerExchangeConnection[] = [];
  private snapshots: AccountSnapshot[] = [];
  private stockHoldings: StockHolding[] = [];
  private cryptoSpotHoldings: CryptoSpotHolding[] = [];
  private futuresPositions: FuturesPosition[] = [];
  private policies: AutomationPolicy[] = [];
  private intents: OrderIntent[] = [];
  readonly previews: ExecutionPreview[] = [];
  readonly audits: Array<{ userId: string; eventType: string; entityType: string; entityId: string; payload: Record<string, unknown>; occurredAt: string }> = [];
  private metrics = new Map<string, RiskMetrics>();

  seed(input: Partial<MemberInvestmentOverview>) {
    if (input.connections) this.connections = clone(input.connections);
    if (input.snapshots) this.snapshots = clone(input.snapshots);
    if (input.stockHoldings) this.stockHoldings = clone(input.stockHoldings);
    if (input.cryptoSpotHoldings) this.cryptoSpotHoldings = clone(input.cryptoSpotHoldings);
    if (input.futuresPositions) this.futuresPositions = clone(input.futuresPositions);
    if (input.policies) this.policies = clone(input.policies);
    if (input.intents) this.intents = clone(input.intents);
  }

  seedRiskMetrics(userId: string, connectionId: string, symbol: string, metrics: RiskMetrics) {
    this.metrics.set(`${userId}:${connectionId}:${symbol}`, clone(metrics));
  }

  async getOverview(userId: string) {
    return clone({
      connections: this.connections.filter((row) => row.userId === userId),
      snapshots: this.snapshots.filter((row) => row.userId === userId),
      stockHoldings: this.stockHoldings.filter((row) => row.userId === userId),
      cryptoSpotHoldings: this.cryptoSpotHoldings.filter((row) => row.userId === userId),
      futuresPositions: this.futuresPositions.filter((row) => row.userId === userId),
      policies: this.policies.filter((row) => row.userId === userId),
      intents: this.intents.filter((row) => row.userId === userId),
    });
  }

  async getConnection(userId: string, connectionId: string) {
    return clone(this.connections.find((row) => row.userId === userId && row.id === connectionId) ?? null);
  }

  async getLatestSnapshot(userId: string, connectionId: string) {
    const rows = this.snapshots.filter((row) => row.userId === userId && row.connectionId === connectionId)
      .sort((left, right) => right.collectedAt.localeCompare(left.collectedAt));
    return clone(rows[0] ?? null);
  }

  async getPolicy(userId: string, policyId: string) {
    return clone(this.policies.find((row) => row.userId === userId && row.id === policyId) ?? null);
  }

  async savePolicy(policy: AutomationPolicy) {
    if (this.policies.some((row) => row.id === policy.id && row.userId !== policy.userId)) {
      throw new Error('AUTOMATION_POLICY_OWNER_MISMATCH');
    }
    const index = this.policies.findIndex((row) => row.userId === policy.userId && row.id === policy.id);
    if (index >= 0) this.policies[index] = clone(policy); else this.policies.push(clone(policy));
    return clone(policy);
  }

  async findIntentByIdempotency(userId: string, key: string) {
    return clone(this.intents.find((row) => row.userId === userId && row.idempotencyKey === key) ?? null);
  }

  async saveIntent(intent: OrderIntent) {
    if (this.intents.some((row) => row.id === intent.id && row.userId !== intent.userId)) {
      throw new Error('ORDER_INTENT_OWNER_MISMATCH');
    }
    const index = this.intents.findIndex((row) => row.userId === intent.userId && row.id === intent.id);
    if (index >= 0) this.intents[index] = clone(intent); else this.intents.push(clone(intent));
    return clone(intent);
  }

  async listIntents(userId: string) {
    return clone(this.intents.filter((row) => row.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  }

  async savePreview(preview: ExecutionPreview) { this.previews.push(clone(preview)); }

  async getRiskMetrics(userId: string, connectionId: string, symbol: string) {
    return clone(this.metrics.get(`${userId}:${connectionId}:${symbol}`) ?? {
      dailyLoss: null, drawdown: null, ordersToday: null, concurrentPositions: null,
      currentPositionValue: null, lastIntentAt: null, duplicateIntent: false,
      liquidationDistancePct: null,
    });
  }

  async appendAudit(input: { userId: string; eventType: string; entityType: string; entityId: string; payload: Record<string, unknown>; occurredAt: string }) {
    this.audits.push(clone(input));
  }
}

function storageError() { return new Error('MEMBER_INVESTMENT_STORAGE_UNAVAILABLE'); }

function connectionFrom(row: Record<string, unknown>): BrokerExchangeConnection {
  return {
    id: String(row.id), userId: String(row.user_id), provider: String(row.provider) as BrokerExchangeConnection['provider'],
    providerType: String(row.provider_type) as BrokerExchangeConnection['providerType'], accountScope: String(row.account_scope),
    connectionStatus: String(row.connection_status) as BrokerExchangeConnection['connectionStatus'],
    permissions: Array.isArray(row.permissions) ? row.permissions.map(String) : [], readOnlyCapable: row.read_only_capable === true,
    tradeCapable: row.trade_capable === true, credentialReference: stringOrNull(row.credential_reference),
    credentialVersion: nullableNumber(row.credential_version), lastVerifiedAt: stringOrNull(row.last_verified_at),
    lastSyncAt: stringOrNull(row.last_sync_at), lastErrorCode: stringOrNull(row.last_error_code),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function snapshotFrom(row: Record<string, unknown>): AccountSnapshot {
  return {
    id: String(row.id), userId: String(row.user_id), connectionId: String(row.connection_id),
    provider: String(row.provider) as AccountSnapshot['provider'], accountType: String(row.account_type), currency: String(row.currency),
    totalEquity: nullableNumber(row.total_equity), cashBalance: nullableNumber(row.cash_balance), availableBalance: nullableNumber(row.available_balance),
    unrealizedPnl: nullableNumber(row.unrealized_pnl), realizedPnl: nullableNumber(row.realized_pnl),
    dailyLoss: nullableNumber(row.daily_loss), drawdown: nullableNumber(row.drawdown),
    dataAsOf: String(row.data_as_of), collectedAt: String(row.collected_at), freshnessStatus: String(row.freshness_status) as AccountSnapshot['freshnessStatus'],
    providerStatus: String(row.provider_status) as AccountSnapshot['providerStatus'], provenance: String(row.provenance), snapshotVersion: Number(row.snapshot_version),
  };
}

function policyFrom(row: Record<string, unknown>): AutomationPolicy {
  return {
    id: String(row.id), userId: String(row.user_id), connectionId: String(row.connection_id), market: String(row.market) as AutomationPolicy['market'],
    strategyId: String(row.strategy_id), strategyVersion: String(row.strategy_version), enabled: row.enabled === true,
    executionMode: String(row.execution_mode) as AutomationPolicy['executionMode'], allowedSymbols: Array.isArray(row.allowed_symbols) ? row.allowed_symbols.map(String) : [],
    maxPositionValue: Number(row.max_position_value), maxPositionPct: Number(row.max_position_pct), maxDailyLoss: Number(row.max_daily_loss),
    maxDrawdown: Number(row.max_drawdown), maxOrdersPerDay: Number(row.max_orders_per_day), maxConcurrentPositions: Number(row.max_concurrent_positions),
    cooldownSeconds: Number(row.cooldown_seconds), leverageMin: Number(row.leverage_min), leverageMax: Number(row.leverage_max),
    minLiquidationBufferPct: Number(row.min_liquidation_buffer_pct), stopLossRequired: row.stop_loss_required === true,
    takeProfitRequired: row.take_profit_required === true, killSwitch: row.kill_switch === true,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function intentFrom(row: Record<string, unknown>): OrderIntent {
  return {
    id: String(row.id), userId: String(row.user_id), connectionId: String(row.connection_id), sourceSignalId: String(row.source_signal_id),
    sourceSignalGeneratedAt: String(row.source_signal_generated_at), strategyId: String(row.strategy_id), market: String(row.market) as OrderIntent['market'],
    symbol: String(row.symbol), side: String(row.side) as OrderIntent['side'], positionSide: stringOrNull(row.position_side) as OrderIntent['positionSide'],
    orderType: String(row.order_type) as OrderIntent['orderType'], requestedQuantity: Number(row.requested_quantity), requestedPrice: Number(row.requested_price),
    stopLoss: nullableNumber(row.stop_loss), takeProfit: nullableNumber(row.take_profit), leverage: nullableNumber(row.leverage),
    status: String(row.status) as OrderIntent['status'], riskDecision: String(row.risk_decision) as OrderIntent['riskDecision'],
    riskReasons: Array.isArray(row.risk_reasons) ? row.risk_reasons.map(String) : [], idempotencyKey: String(row.idempotency_key),
    createdAt: String(row.created_at), expiresAt: String(row.expires_at),
  };
}

function holdingFrom(row: Record<string, unknown>): StockHolding {
  return {
    id: String(row.id), userId: String(row.user_id), connectionId: stringOrNull(row.connection_id), provider: stringOrNull(row.provider) as StockHolding['provider'],
    market: String(row.market) === 'US' ? 'US_STOCK' : 'KR_STOCK', symbol: String(row.symbol ?? row.ticker), quantity: Number(row.quantity),
    averagePrice: Number(row.average_price), currentPrice: nullableNumber(row.current_price), marketValue: nullableNumber(row.market_value),
    unrealizedPnl: nullableNumber(row.unrealized_pnl), unrealizedPnlPct: nullableNumber(row.unrealized_pnl_pct),
    dataAsOf: stringOrNull(row.data_as_of), collectedAt: stringOrNull(row.collected_at),
    freshnessStatus: String(row.freshness_status ?? 'MISSING') as StockHolding['freshnessStatus'], provenance: stringOrNull(row.provenance),
  };
}

function cryptoHoldingFrom(row: Record<string, unknown>): CryptoSpotHolding {
  return {
    id: String(row.id), userId: String(row.user_id), connectionId: String(row.connection_id),
    provider: String(row.provider) as CryptoSpotHolding['provider'], asset: String(row.asset),
    free: nullableNumber(row.free), locked: nullableNumber(row.locked), averagePrice: nullableNumber(row.average_price),
    currentPrice: nullableNumber(row.current_price), marketValue: nullableNumber(row.market_value), unrealizedPnl: nullableNumber(row.unrealized_pnl),
    dataAsOf: String(row.data_as_of), collectedAt: String(row.collected_at),
    freshnessStatus: String(row.freshness_status) as CryptoSpotHolding['freshnessStatus'], provenance: String(row.provenance),
  };
}

function futuresPositionFrom(row: Record<string, unknown>): FuturesPosition {
  return {
    id: String(row.id), userId: String(row.user_id), connectionId: String(row.connection_id),
    exchange: String(row.exchange) as FuturesPosition['exchange'], symbol: String(row.symbol), side: String(row.side) as FuturesPosition['side'],
    marginMode: String(row.margin_mode) as FuturesPosition['marginMode'], leverage: nullableNumber(row.leverage), quantity: nullableNumber(row.quantity),
    entryPrice: nullableNumber(row.entry_price), markPrice: nullableNumber(row.mark_price), liquidationPrice: nullableNumber(row.liquidation_price),
    liquidationDistancePct: nullableNumber(row.liquidation_distance_pct), unrealizedPnl: nullableNumber(row.unrealized_pnl),
    maintenanceMargin: nullableNumber(row.maintenance_margin), dataAsOf: String(row.data_as_of), collectedAt: String(row.collected_at),
    freshnessStatus: String(row.freshness_status) as FuturesPosition['freshnessStatus'], provenance: String(row.provenance),
  };
}

export function createSupabaseMemberInvestmentRepository(accessToken: string, authenticatedUserId: string): MemberInvestmentRepository {
  const owner = authenticatedUserId.trim();
  if (!owner || !accessToken.trim()) throw new Error('LOGIN_REQUIRED');
  const client = getUserSupabase(accessToken);
  const assertOwner = (userId: string) => { if (userId !== owner) throw new Error('MEMBER_INVESTMENT_USER_SCOPE_MISMATCH'); };
  const selectMany = async (table: string, select: string, userId: string) => {
    assertOwner(userId);
    const { data, error } = await client.from(table).select(select).eq('user_id', userId);
    if (error) throw storageError();
    return (Array.isArray(data) ? data : []) as unknown as Record<string, unknown>[];
  };
  return {
    async getOverview(userId) {
      const [connections, snapshots, stock, crypto, futures, policies, intents] = await Promise.all([
        selectMany('broker_exchange_connections', '*', userId), selectMany('account_snapshots', '*', userId),
        selectMany('portfolio_holdings', '*', userId), selectMany('crypto_spot_holdings', '*', userId),
        selectMany('futures_positions', '*', userId), selectMany('automation_policies', '*', userId), selectMany('order_intents', '*', userId),
      ]);
      return {
        connections: connections.map(connectionFrom), snapshots: snapshots.map(snapshotFrom), stockHoldings: stock.map(holdingFrom),
        cryptoSpotHoldings: crypto.map(cryptoHoldingFrom), futuresPositions: futures.map(futuresPositionFrom),
        policies: policies.map(policyFrom), intents: intents.map(intentFrom),
      };
    },
    async getConnection(userId, connectionId) {
      assertOwner(userId); const { data, error } = await client.from('broker_exchange_connections').select('*').eq('user_id', userId).eq('id', connectionId).maybeSingle();
      if (error) throw storageError(); return data ? connectionFrom(data as Record<string, unknown>) : null;
    },
    async getLatestSnapshot(userId, connectionId) {
      assertOwner(userId); const { data, error } = await client.from('account_snapshots').select('*').eq('user_id', userId).eq('connection_id', connectionId).order('collected_at', { ascending: false }).limit(1).maybeSingle();
      if (error) throw storageError(); return data ? snapshotFrom(data as Record<string, unknown>) : null;
    },
    async getPolicy(userId, policyId) {
      assertOwner(userId); const { data, error } = await client.from('automation_policies').select('*').eq('user_id', userId).eq('id', policyId).maybeSingle();
      if (error) throw storageError(); return data ? policyFrom(data as Record<string, unknown>) : null;
    },
    async savePolicy(policy) {
      assertOwner(policy.userId); const row = {
        id: policy.id, user_id: policy.userId, connection_id: policy.connectionId, market: policy.market,
        strategy_id: policy.strategyId, strategy_version: policy.strategyVersion, enabled: policy.enabled, execution_mode: policy.executionMode,
        allowed_symbols: policy.allowedSymbols, max_position_value: policy.maxPositionValue, max_position_pct: policy.maxPositionPct,
        max_daily_loss: policy.maxDailyLoss, max_drawdown: policy.maxDrawdown, max_orders_per_day: policy.maxOrdersPerDay,
        max_concurrent_positions: policy.maxConcurrentPositions, cooldown_seconds: policy.cooldownSeconds, leverage_min: policy.leverageMin,
        leverage_max: policy.leverageMax, min_liquidation_buffer_pct: policy.minLiquidationBufferPct,
        stop_loss_required: policy.stopLossRequired, take_profit_required: policy.takeProfitRequired, kill_switch: policy.killSwitch,
        created_at: policy.createdAt, updated_at: policy.updatedAt,
      };
      const { data, error } = await client.from('automation_policies').upsert(row).select('*').single();
      if (error || !data) throw storageError(); return policyFrom(data as Record<string, unknown>);
    },
    async findIntentByIdempotency(userId, key) {
      assertOwner(userId); const { data, error } = await client.from('order_intents').select('*').eq('user_id', userId).eq('idempotency_key', key).maybeSingle();
      if (error) throw storageError(); return data ? intentFrom(data as Record<string, unknown>) : null;
    },
    async saveIntent(intent) {
      assertOwner(intent.userId); const row = {
        id: intent.id, user_id: intent.userId, connection_id: intent.connectionId, source_signal_id: intent.sourceSignalId,
        source_signal_generated_at: intent.sourceSignalGeneratedAt, strategy_id: intent.strategyId, market: intent.market, symbol: intent.symbol,
        side: intent.side, position_side: intent.positionSide, order_type: intent.orderType, requested_quantity: intent.requestedQuantity,
        requested_price: intent.requestedPrice, stop_loss: intent.stopLoss, take_profit: intent.takeProfit, leverage: intent.leverage,
        status: intent.status, risk_decision: intent.riskDecision, risk_reasons: intent.riskReasons, idempotency_key: intent.idempotencyKey,
        created_at: intent.createdAt, expires_at: intent.expiresAt,
      };
      const { data, error } = await client.from('order_intents').upsert(row).select('*').single();
      if (error || !data) throw storageError(); return intentFrom(data as Record<string, unknown>);
    },
    async listIntents(userId) { const rows = await selectMany('order_intents', '*', userId); return rows.map(intentFrom).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
    async savePreview(preview) {
      assertOwner(preview.userId); const { error } = await client.from('execution_previews').insert({
        id: preview.id, user_id: preview.userId, order_intent_id: preview.orderIntentId, provider: preview.provider,
        estimated_notional: preview.estimatedNotional, reference_price: preview.referencePrice, requested_quantity: preview.requestedQuantity,
        status: preview.status, warnings: preview.warnings, created_at: preview.createdAt, expires_at: preview.expiresAt,
      }); if (error) throw storageError();
    },
    async getRiskMetrics(userId, connectionId, symbol, now) {
      assertOwner(userId);
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
      const [snapshotResult, intentsResult, futuresResult, stockResult] = await Promise.all([
        client.from('account_snapshots').select('daily_loss,drawdown').eq('user_id', userId).eq('connection_id', connectionId).order('collected_at', { ascending: false }).limit(1).maybeSingle(),
        client.from('order_intents').select('created_at').eq('user_id', userId).eq('connection_id', connectionId).gte('created_at', start).order('created_at', { ascending: false }),
        client.from('futures_positions').select('market_value,liquidation_distance_pct').eq('user_id', userId).eq('connection_id', connectionId).eq('symbol', symbol),
        client.from('portfolio_holdings').select('market_value').eq('user_id', userId).eq('connection_id', connectionId).eq('symbol', symbol),
      ]);
      if (snapshotResult.error || intentsResult.error || futuresResult.error || stockResult.error) throw storageError();
      const intentRows = Array.isArray(intentsResult.data) ? intentsResult.data : [];
      const positionRows = [...(Array.isArray(futuresResult.data) ? futuresResult.data : []), ...(Array.isArray(stockResult.data) ? stockResult.data : [])] as Record<string, unknown>[];
      const values = positionRows.map((row) => nullableNumber(row.market_value)).filter((value): value is number => value != null);
      const liquidation = (Array.isArray(futuresResult.data) ? futuresResult.data : []).map((row) => nullableNumber((row as Record<string, unknown>).liquidation_distance_pct)).find((value) => value != null) ?? null;
      return {
        dailyLoss: nullableNumber(snapshotResult.data?.daily_loss), drawdown: nullableNumber(snapshotResult.data?.drawdown),
        ordersToday: intentRows.length, concurrentPositions: positionRows.length,
        currentPositionValue: values.length === positionRows.length ? values.reduce((sum, value) => sum + value, 0) : null,
        lastIntentAt: intentRows[0]?.created_at ? String(intentRows[0].created_at) : null,
        duplicateIntent: false, liquidationDistancePct: liquidation,
      };
    },
    async appendAudit(input) {
      assertOwner(input.userId); const { error } = await client.from('member_investment_audit_events').insert({
        user_id: input.userId, event_type: input.eventType, entity_type: input.entityType,
        entity_id: input.entityId, payload: input.payload, occurred_at: input.occurredAt,
      }); if (error) throw storageError();
    },
  };
}
