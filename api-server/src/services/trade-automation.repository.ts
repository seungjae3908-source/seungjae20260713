import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase, getUserSupabase, hasSupabaseServerKey } from '../lib/supabase';
import {
  DEFAULT_TRADING_POLICY,
  type ExchangeConnection,
  type BrokerConnectionProvider,
  type TradingOrder,
  type TradingOrderEvent,
  type TradingOrderState,
  type TradingPlan,
  type TradingPolicy,
} from './trade-automation.types';
import { normalizeTradingPolicy } from './trade-automation-risk.service';

export type AtomicOrderResult = {
  order: TradingOrder;
  inserted: boolean;
};

export type AtomicTransitionResult = {
  order: TradingOrder;
  applied: boolean;
};

export interface TradingRepository {
  getGlobalEmergencyStop(): Promise<boolean>;
  setGlobalEmergencyStop(stopped: boolean, changedBy: string): Promise<void>;
  getPolicy(userId: string): Promise<TradingPolicy>;
  savePolicy(userId: string, policy: TradingPolicy): Promise<TradingPolicy>;
  getConnections(userId: string): Promise<ExchangeConnection[]>;
  getConnection(userId: string, exchange: BrokerConnectionProvider): Promise<ExchangeConnection | null>;
  saveConnection(connection: ExchangeConnection): Promise<void>;
  findPlanByIdempotency(userId: string, key: string): Promise<TradingPlan | null>;
  getPlan(userId: string, id: string): Promise<TradingPlan | null>;
  listPlans(userId: string): Promise<TradingPlan[]>;
  insertPlan(plan: TradingPlan): Promise<{ plan: TradingPlan; inserted: boolean }>;
  compareAndSetPlan(plan: TradingPlan, expectedState: TradingOrderState, expectedVersion: number): Promise<TradingPlan | null>;
  savePlan(plan: TradingPlan): Promise<void>;
  getOrder(userId: string, id: string): Promise<TradingOrder | null>;
  findOrderByPlan(userId: string, planId: string): Promise<TradingOrder | null>;
  createOrderAtomic(order: TradingOrder, event: TradingOrderEvent, expectedPlanState: TradingOrderState): Promise<AtomicOrderResult | null>;
  transitionOrderAtomic(
    order: TradingOrder,
    expectedState: TradingOrderState,
    expectedVersion: number,
    event: TradingOrderEvent,
  ): Promise<AtomicTransitionResult>;
  claimOrderExecution(order: TradingOrder, expectedVersion: number, claimId: string): Promise<TradingOrder | null>;
  saveOrder(order: TradingOrder): Promise<void>;
  listOrders(userId: string): Promise<TradingOrder[]>;
  appendEvent(event: TradingOrderEvent): Promise<void>;
  listEvents(userId: string): Promise<TradingOrderEvent[]>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function planVersion(plan: TradingPlan) {
  return Number.isInteger(plan.version) && Number(plan.version) >= 0 ? Number(plan.version) : 0;
}

function orderVersion(order: TradingOrder) {
  return Number.isInteger(order.version) && Number(order.version) >= 0 ? Number(order.version) : 0;
}

function normalizedOrder(order: TradingOrder): TradingOrder {
  return {
    ...copy(order),
    version: orderVersion(order),
    remainingQuantity: order.remainingQuantity ?? (order.requestedQuantity == null
      ? null
      : Math.max(0, order.requestedQuantity - order.filledQuantity)),
    fills: copy(order.fills ?? []),
    feeAmount: order.feeAmount ?? null,
    feeCurrency: order.feeCurrency ?? null,
    exchangeCreatedAt: order.exchangeCreatedAt ?? null,
    exchangeUpdatedAt: order.exchangeUpdatedAt ?? null,
    cancelable: order.cancelable ?? null,
    providerStatusCode: order.providerStatusCode ?? null,
    nextRetryAt: order.nextRetryAt ?? null,
    lastReconciledAt: order.lastReconciledAt ?? null,
    manualReviewRequired: order.manualReviewRequired === true,
    executionClaimId: order.executionClaimId ?? null,
    recoveryLeaseOwner: order.recoveryLeaseOwner ?? null,
    recoveryLeaseUntil: order.recoveryLeaseUntil ?? null,
    protectionStatus: order.protectionStatus ?? 'NOT_REQUIRED',
    protectionErrorCode: order.protectionErrorCode ?? null,
  };
}

export class InMemoryTradingRepository implements TradingRepository {
  private globalEmergencyStopped = false;
  private policies = new Map<string, TradingPolicy>();
  private connections = new Map<string, ExchangeConnection>();
  private plans = new Map<string, TradingPlan>();
  private orders = new Map<string, TradingOrder>();
  private events: TradingOrderEvent[] = [];
  private executionClaims = new Map<string, { id: string; claimedAt: number }>();

  async getGlobalEmergencyStop() { return this.globalEmergencyStopped; }
  async setGlobalEmergencyStop(stopped: boolean, _changedBy: string) { this.globalEmergencyStopped = stopped; }
  async getPolicy(userId: string) { return copy(this.policies.get(userId) ?? normalizeTradingPolicy(DEFAULT_TRADING_POLICY)); }
  async savePolicy(userId: string, policy: TradingPolicy) { this.policies.set(userId, copy(policy)); return copy(policy); }
  async getConnections(userId: string) { return [...this.connections.values()].filter((item) => item.userId === userId).map(copy); }
  async getConnection(userId: string, exchange: BrokerConnectionProvider) {
    const value = this.connections.get(`${userId}:${exchange}`);
    return value ? copy(value) : null;
  }
  async saveConnection(connection: ExchangeConnection) { this.connections.set(`${connection.userId}:${connection.exchange}`, copy(connection)); }
  async findPlanByIdempotency(userId: string, key: string) {
    const value = [...this.plans.values()].find((item) => item.userId === userId && item.idempotencyKey === key);
    return value ? copy(value) : null;
  }
  async getPlan(userId: string, id: string) {
    const value = this.plans.get(id);
    return value?.userId === userId ? copy(value) : null;
  }
  async listPlans(userId: string) {
    return [...this.plans.values()].filter((item) => item.userId === userId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map(copy);
  }
  async insertPlan(plan: TradingPlan) {
    const existing = [...this.plans.values()].find((item) => item.userId === plan.userId
      && item.idempotencyKey === plan.idempotencyKey);
    if (existing) return { plan: existing, inserted: false };
    Object.assign(plan, { ...copy(plan), version: planVersion(plan) });
    this.plans.set(plan.id, plan);
    return { plan, inserted: true };
  }
  async compareAndSetPlan(plan: TradingPlan, expectedState: TradingOrderState, expectedVersion: number) {
    const current = this.plans.get(plan.id);
    if (!current || current.userId !== plan.userId || current.state !== expectedState
      || planVersion(current) !== expectedVersion) return null;
    Object.assign(current, { ...copy(plan), version: expectedVersion + 1 });
    return current;
  }
  async savePlan(plan: TradingPlan) {
    const current = this.plans.get(plan.id);
    const normalized = { ...copy(plan), version: planVersion(plan) };
    if (current) {
      Object.assign(current, normalized);
      return;
    }
    Object.assign(plan, normalized);
    this.plans.set(plan.id, plan);
  }
  async getOrder(userId: string, id: string) {
    const value = this.orders.get(id);
    return value?.userId === userId ? normalizedOrder(value) : null;
  }
  async findOrderByPlan(userId: string, planId: string) {
    const value = [...this.orders.values()].find((item) => item.userId === userId && item.planId === planId);
    return value ? normalizedOrder(value) : null;
  }
  async createOrderAtomic(order: TradingOrder, event: TradingOrderEvent, expectedPlanState: TradingOrderState) {
    const plan = this.plans.get(order.planId);
    if (!plan || plan.userId !== order.userId || plan.state !== expectedPlanState) return null;
    const existing = [...this.orders.values()].find((item) => item.userId === order.userId
      && (item.planId === order.planId
        || (item.exchange === order.exchange && item.clientOrderId === order.clientOrderId)));
    if (existing) return { order: existing, inserted: false };
    Object.assign(order, normalizedOrder(order));
    this.orders.set(order.id, order);
    this.events.push(copy(event));
    return { order, inserted: true };
  }
  async transitionOrderAtomic(
    order: TradingOrder,
    expectedState: TradingOrderState,
    expectedVersion: number,
    event: TradingOrderEvent,
  ) {
    const current = this.orders.get(order.id);
    if (!current || current.userId !== order.userId || current.state !== expectedState
      || orderVersion(current) !== expectedVersion) {
      return { order: current ? normalizedOrder(current) : normalizedOrder(order), applied: false };
    }
    Object.assign(current, normalizedOrder({ ...copy(order), version: expectedVersion + 1 }));
    this.events.push(copy(event));
    this.executionClaims.delete(current.id);
    return { order: current, applied: true };
  }
  async claimOrderExecution(order: TradingOrder, expectedVersion: number, claimId: string) {
    const current = this.orders.get(order.id);
    if (!current || current.userId !== order.userId || current.state !== 'SUBMITTED'
      || orderVersion(current) !== expectedVersion) return null;
    const previous = this.executionClaims.get(order.id);
    if (previous && Date.now() - previous.claimedAt < 30_000) return null;
    this.executionClaims.set(order.id, { id: claimId, claimedAt: Date.now() });
    Object.assign(current, normalizedOrder({ ...current, version: expectedVersion + 1, executionClaimId: claimId,
      updatedAt: new Date().toISOString() }));
    return current;
  }
  async saveOrder(order: TradingOrder) {
    const current = this.orders.get(order.id);
    const normalized = normalizedOrder(order);
    if (current) {
      Object.assign(current, normalized);
      return;
    }
    Object.assign(order, normalized);
    this.orders.set(order.id, order);
  }
  async listOrders(userId: string) {
    return [...this.orders.values()].filter((item) => item.userId === userId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map(normalizedOrder);
  }
  async appendEvent(event: TradingOrderEvent) { this.events.push(copy(event)); }
  async listEvents(userId: string) { return this.events.filter((item) => item.userId === userId).map(copy); }
}

function databaseError() {
  return new Error('TRADE_AUTOMATION_STORAGE_UNAVAILABLE');
}

function assertOwner(actual: string, expected: string) {
  if (actual !== expected) throw new Error('USER_SCOPE_MISMATCH');
}

function isUniqueViolation(error: unknown) {
  return error !== null && typeof error === 'object' && 'code' in error
    && String((error as { code?: unknown }).code) === '23505';
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown> : null;
}

function planRow(plan: TradingPlan) {
  return {
    user_id: plan.userId,
    id: plan.id,
    idempotency_key: plan.idempotencyKey,
    state: plan.state,
    version: planVersion(plan),
    payload: { ...plan, version: planVersion(plan) },
    approval_expires_at: plan.approvalExpiresAt,
    updated_at: plan.updatedAt,
  };
}

function orderRow(order: TradingOrder) {
  const normalized = normalizedOrder(order);
  return {
    user_id: normalized.userId,
    id: normalized.id,
    plan_id: normalized.planId,
    client_order_id: normalized.clientOrderId,
    exchange_order_id: normalized.exchangeOrderId,
    exchange: normalized.exchange,
    state: normalized.state,
    version: orderVersion(normalized),
    remaining_quantity: normalized.remainingQuantity,
    fills: normalized.fills,
    fee_amount: normalized.feeAmount,
    fee_currency: normalized.feeCurrency,
    exchange_created_at: normalized.exchangeCreatedAt,
    exchange_updated_at: normalized.exchangeUpdatedAt,
    cancelable: normalized.cancelable,
    provider_status_code: normalized.providerStatusCode,
    next_retry_at: normalized.nextRetryAt,
    last_reconciled_at: normalized.lastReconciledAt,
    manual_review_required: normalized.manualReviewRequired,
    protection_status: normalized.protectionStatus,
    protection_error_code: normalized.protectionErrorCode,
    payload: normalized,
    updated_at: normalized.updatedAt,
  };
}

export function createSupabaseTradingRepository(accessToken: string, authenticatedUserId: string): TradingRepository {
  if (!accessToken || !authenticatedUserId) throw new Error('LOGIN_REQUIRED');
  const client = getUserSupabase(accessToken);
  const secureClient = () => {
    if (!hasSupabaseServerKey()) throw new Error('TRADE_CREDENTIAL_STORAGE_UNAVAILABLE');
    return getSupabase();
  };
  const owned = (userId: string) => assertOwner(userId, authenticatedUserId);

  const selectPlanByIdempotency = async (userId: string, key: string) => {
    owned(userId);
    const { data, error } = await client.from('trade_order_plans').select('payload')
      .eq('user_id', userId).eq('idempotency_key', key).maybeSingle();
    if (error) throw databaseError();
    return data?.payload as TradingPlan | null;
  };
  const selectOrderByPlan = async (userId: string, planId: string) => {
    owned(userId);
    const { data, error } = await client.from('trade_orders').select('payload')
      .eq('user_id', userId).eq('plan_id', planId).maybeSingle();
    if (error) throw databaseError();
    return data?.payload ? normalizedOrder(data.payload as TradingOrder) : null;
  };

  return {
    async getGlobalEmergencyStop() {
      if (!hasSupabaseServerKey()) return true;
      try {
        const { data, error } = await getSupabase().from('trade_system_controls')
          .select('emergency_stopped').eq('control_key', 'global').maybeSingle();
        if (error || !data) return true;
        return data.emergency_stopped === true;
      } catch {
        return true;
      }
    },
    async setGlobalEmergencyStop(stopped, changedBy) {
      owned(changedBy);
      const { error } = await secureClient().from('trade_system_controls').upsert({
        control_key: 'global', emergency_stopped: stopped, changed_by: changedBy,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'control_key' });
      if (error) throw databaseError();
    },
    async getPolicy(userId) {
      owned(userId);
      const { data, error } = await client.from('trade_automation_profiles').select('payload')
        .eq('user_id', userId).maybeSingle();
      if (error) throw databaseError();
      return normalizeTradingPolicy((data?.payload ?? DEFAULT_TRADING_POLICY) as Partial<TradingPolicy>);
    },
    async savePolicy(userId, policy) {
      owned(userId);
      const { error } = await client.from('trade_automation_profiles').upsert({
        user_id: userId, payload: policy, updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
      if (error) throw databaseError();
      return policy;
    },
    async getConnections(userId) {
      owned(userId);
      const { data, error } = await client.from('trade_exchange_connections')
        .select('user_id,exchange,account_mode,configured,last_verified_at,last_error_code,updated_at')
        .eq('user_id', userId);
      if (error) throw databaseError();
      return (data ?? []).map(toConnection);
    },
    async getConnection(userId, exchange) {
      owned(userId);
      const { data, error } = await secureClient().from('trade_exchange_connections').select('*')
        .eq('user_id', userId).eq('exchange', exchange).maybeSingle();
      if (error) throw databaseError();
      return data ? toConnection(data) : null;
    },
    async saveConnection(connection) {
      owned(connection.userId);
      const { error } = await secureClient().from('trade_exchange_connections').upsert({
        user_id: connection.userId, exchange: connection.exchange, account_mode: connection.accountMode,
        encrypted_credentials: connection.encryptedCredentials, configured: connection.configured,
        last_verified_at: connection.lastVerifiedAt, last_error_code: connection.lastErrorCode,
        updated_at: connection.updatedAt,
      }, { onConflict: 'user_id,exchange' });
      if (error) throw databaseError();
    },
    async findPlanByIdempotency(userId, key) { return selectPlanByIdempotency(userId, key); },
    async getPlan(userId, id) {
      owned(userId);
      const { data, error } = await client.from('trade_order_plans').select('payload')
        .eq('user_id', userId).eq('id', id).maybeSingle();
      if (error) throw databaseError();
      return data?.payload as TradingPlan | null;
    },
    async listPlans(userId) {
      owned(userId);
      const { data, error } = await client.from('trade_order_plans').select('payload')
        .eq('user_id', userId).order('updated_at', { ascending: false }).limit(200);
      if (error) throw databaseError();
      return (data ?? []).map((row) => row.payload as TradingPlan);
    },
    async insertPlan(plan) {
      owned(plan.userId);
      const { error } = await client.from('trade_order_plans').insert(planRow(plan));
      if (!error) return { plan: { ...plan, version: planVersion(plan) }, inserted: true };
      if (!isUniqueViolation(error)) throw databaseError();
      const existing = await selectPlanByIdempotency(plan.userId, plan.idempotencyKey);
      if (!existing) throw databaseError();
      return { plan: existing, inserted: false };
    },
    async compareAndSetPlan(plan, expectedState, expectedVersion) {
      owned(plan.userId);
      const payload = { ...plan, version: expectedVersion, updatedAt: plan.updatedAt };
      const { data, error } = await client.rpc('transition_trade_plan_atomic', {
        p_user_id: plan.userId,
        p_plan_id: plan.id,
        p_expected_state: expectedState,
        p_expected_version: expectedVersion,
        p_next_state: plan.state,
        p_payload: payload,
      });
      if (error) throw databaseError();
      return data ? data as TradingPlan : null;
    },
    async savePlan(plan) {
      owned(plan.userId);
      const { error } = await client.from('trade_order_plans').upsert(planRow(plan), { onConflict: 'user_id,id' });
      if (error) throw databaseError();
    },
    async getOrder(userId, id) {
      owned(userId);
      const { data, error } = await client.from('trade_orders').select('payload')
        .eq('user_id', userId).eq('id', id).maybeSingle();
      if (error) throw databaseError();
      return data?.payload ? normalizedOrder(data.payload as TradingOrder) : null;
    },
    async findOrderByPlan(userId, planId) { return selectOrderByPlan(userId, planId); },
    async createOrderAtomic(order, event, expectedPlanState) {
      owned(order.userId);
      const { data, error } = await client.rpc('create_trade_order_atomic', {
        p_user_id: order.userId,
        p_plan_id: order.planId,
        p_expected_plan_state: expectedPlanState,
        p_order_payload: normalizedOrder(order),
        p_event_payload: event,
      });
      if (error) {
        if (!isUniqueViolation(error)) throw databaseError();
        const existing = await selectOrderByPlan(order.userId, order.planId);
        return existing ? { order: existing, inserted: false } : null;
      }
      const row = firstRecord(data);
      if (!row?.order_payload) return null;
      return { order: normalizedOrder(row.order_payload as TradingOrder), inserted: row.inserted === true };
    },
    async transitionOrderAtomic(order, expectedState, expectedVersion, event) {
      owned(order.userId);
      const { data, error } = await client.rpc('transition_trade_order_atomic', {
        p_user_id: order.userId,
        p_order_id: order.id,
        p_expected_state: expectedState,
        p_expected_version: expectedVersion,
        p_next_state: order.state,
        p_order_payload: normalizedOrder(order),
        p_event_payload: event,
      });
      if (error) throw databaseError();
      if (data) return { order: normalizedOrder(data as TradingOrder), applied: true };
      const current = await this.getOrder(order.userId, order.id);
      return { order: current ?? normalizedOrder(order), applied: false };
    },
    async claimOrderExecution(order, expectedVersion, claimId) {
      owned(order.userId);
      const { data, error } = await client.rpc('claim_trade_order_execution', {
        p_user_id: order.userId,
        p_order_id: order.id,
        p_expected_version: expectedVersion,
        p_claim_id: claimId,
        p_lease_seconds: 30,
      });
      if (error) throw databaseError();
      return data ? normalizedOrder(data as TradingOrder) : null;
    },
    async saveOrder(order) {
      owned(order.userId);
      const { error } = await client.from('trade_orders').upsert(orderRow(order), { onConflict: 'user_id,id' });
      if (error) throw databaseError();
    },
    async listOrders(userId) {
      owned(userId);
      const { data, error } = await client.from('trade_orders').select('payload')
        .eq('user_id', userId).order('updated_at', { ascending: false }).limit(500);
      if (error) throw databaseError();
      return (data ?? []).map((row) => normalizedOrder(row.payload as TradingOrder));
    },
    async appendEvent(event) {
      owned(event.userId);
      const { error } = await client.from('trade_order_events').insert({
        user_id: event.userId, id: event.id, order_id: event.orderId, to_state: event.toState,
        payload: event, created_at: event.createdAt,
      });
      if (error) throw databaseError();
    },
    async listEvents(userId) {
      owned(userId);
      const { data, error } = await client.from('trade_order_events').select('payload')
        .eq('user_id', userId).order('created_at', { ascending: false }).limit(1_000);
      if (error) throw databaseError();
      return (data ?? []).map((row) => row.payload as TradingOrderEvent);
    },
  };
}

function toConnection(row: Record<string, unknown>): ExchangeConnection {
  return {
    userId: String(row.user_id), exchange: String(row.exchange) as BrokerConnectionProvider,
    accountMode: String(row.account_mode) as ExchangeConnection['accountMode'],
    configured: row.configured === true,
    encryptedCredentials: row.encrypted_credentials ? String(row.encrypted_credentials) : null,
    lastVerifiedAt: row.last_verified_at ? String(row.last_verified_at) : null,
    lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
    updatedAt: String(row.updated_at),
  };
}

export function safeConnections(connections: ExchangeConnection[]) {
  return connections.map(({ encryptedCredentials: _secret, ...connection }) => ({ ...connection, credentialsExposed: false }));
}

export function databaseClientForTests(client: SupabaseClient) {
  return client;
}
