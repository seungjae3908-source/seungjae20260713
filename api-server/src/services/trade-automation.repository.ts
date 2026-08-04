import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase, getUserSupabase, hasSupabaseServerKey } from '../lib/supabase';
import {
  DEFAULT_TRADING_POLICY,
  type ExchangeConnection,
  type TradingExchange,
  type TradingOrder,
  type TradingOrderEvent,
  type TradingOrderState,
  type TradingPlan,
  type TradingPolicy,
} from './trade-automation.types';
import { normalizeTradingPolicy } from './trade-automation-risk.service';

export type AtomicPlanOrderResult = {
  plan: TradingPlan;
  order: TradingOrder;
  transitioned: boolean;
  orderInserted: boolean;
  executionClaimed: boolean;
};

export interface TradingRepository {
  getGlobalEmergencyStop(): Promise<boolean>;
  setGlobalEmergencyStop(stopped: boolean, changedBy: string): Promise<void>;
  getPolicy(userId: string): Promise<TradingPolicy>;
  savePolicy(userId: string, policy: TradingPolicy): Promise<TradingPolicy>;
  getConnections(userId: string): Promise<ExchangeConnection[]>;
  getConnection(userId: string, exchange: TradingExchange): Promise<ExchangeConnection | null>;
  saveConnection(connection: ExchangeConnection): Promise<void>;
  findPlanByIdempotency(userId: string, key: string): Promise<TradingPlan | null>;
  getPlan(userId: string, id: string): Promise<TradingPlan | null>;
  listPlans(userId: string): Promise<TradingPlan[]>;
  insertPlan(plan: TradingPlan): Promise<{ plan: TradingPlan; inserted: boolean }>;
  compareAndSetPlan(plan: TradingPlan, expectedState: TradingOrderState): Promise<TradingPlan | null>;
  submitPlanAndCreateOrder(
    plan: TradingPlan,
    expectedState: TradingOrderState,
    order: TradingOrder,
    event: TradingOrderEvent,
    executionClaimId: string,
  ): Promise<AtomicPlanOrderResult | null>;
  savePlan(plan: TradingPlan): Promise<void>;
  getOrder(userId: string, id: string): Promise<TradingOrder | null>;
  findOrderByPlan(userId: string, planId: string): Promise<TradingOrder | null>;
  insertOrder(order: TradingOrder): Promise<{ order: TradingOrder; inserted: boolean }>;
  saveOrder(order: TradingOrder): Promise<void>;
  listOrders(userId: string): Promise<TradingOrder[]>;
  appendEvent(event: TradingOrderEvent): Promise<void>;
  listEvents(userId: string): Promise<TradingOrderEvent[]>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryTradingRepository implements TradingRepository {
  private globalEmergencyStopped = false;
  private policies = new Map<string, TradingPolicy>();
  private connections = new Map<string, ExchangeConnection>();
  private plans = new Map<string, TradingPlan>();
  private orders = new Map<string, TradingOrder>();
  private events: TradingOrderEvent[] = [];
  private executionClaims = new Map<string, string>();

  async getGlobalEmergencyStop() { return this.globalEmergencyStopped; }
  async setGlobalEmergencyStop(stopped: boolean, _changedBy: string) { this.globalEmergencyStopped = stopped; }
  async getPolicy(userId: string) {
    return copy(this.policies.get(userId) ?? normalizeTradingPolicy(DEFAULT_TRADING_POLICY));
  }
  async savePolicy(userId: string, policy: TradingPolicy) {
    const stored = copy(policy);
    this.policies.set(userId, stored);
    return copy(stored);
  }
  async getConnections(userId: string) {
    return [...this.connections.values()].filter((item) => item.userId === userId).map(copy);
  }
  async getConnection(userId: string, exchange: TradingExchange) {
    const value = this.connections.get(`${userId}:${exchange}`);
    return value ? copy(value) : null;
  }
  async saveConnection(connection: ExchangeConnection) {
    this.connections.set(`${connection.userId}:${connection.exchange}`, copy(connection));
  }
  async findPlanByIdempotency(userId: string, key: string) {
    const value = [...this.plans.values()]
      .find((item) => item.userId === userId && item.idempotencyKey === key);
    return value ? copy(value) : null;
  }
  async getPlan(userId: string, id: string) {
    const value = this.plans.get(id);
    return value?.userId === userId ? copy(value) : null;
  }
  async listPlans(userId: string) {
    return [...this.plans.values()]
      .filter((item) => item.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(copy);
  }
  async insertPlan(plan: TradingPlan) {
    const existing = [...this.plans.values()]
      .find((item) => item.userId === plan.userId && item.idempotencyKey === plan.idempotencyKey);
    if (existing) return { plan: copy(existing), inserted: false };
    const stored = copy(plan);
    this.plans.set(stored.id, stored);
    return { plan: copy(stored), inserted: true };
  }
  async compareAndSetPlan(plan: TradingPlan, expectedState: TradingOrderState) {
    const current = this.plans.get(plan.id);
    if (!current || current.userId !== plan.userId || current.state !== expectedState) return null;
    const stored = copy(plan);
    this.plans.set(stored.id, stored);
    return copy(stored);
  }
  async submitPlanAndCreateOrder(
    plan: TradingPlan,
    expectedState: TradingOrderState,
    order: TradingOrder,
    event: TradingOrderEvent,
    executionClaimId: string,
  ) {
    const currentPlan = this.plans.get(plan.id);
    if (!currentPlan || currentPlan.userId !== plan.userId) return null;
    if (currentPlan.state !== expectedState && currentPlan.state !== 'SUBMITTED') return null;
    if (plan.state !== 'SUBMITTED'
      || order.userId !== plan.userId
      || order.planId !== plan.id
      || event.userId !== order.userId
      || event.orderId !== order.id
      || event.reason !== 'ORDER_CREATED'
      || event.toState !== 'SUBMITTED') {
      throw new Error('TRADE_ATOMIC_INPUT_INVALID');
    }

    let persistedOrder = [...this.orders.values()].find((item) => item.userId === order.userId
      && (item.planId === order.planId
        || (item.exchange === order.exchange && item.clientOrderId === order.clientOrderId))) ?? null;
    if (persistedOrder && (persistedOrder.planId !== order.planId
      || persistedOrder.exchange !== order.exchange
      || persistedOrder.clientOrderId !== order.clientOrderId)) {
      throw new Error('TRADE_ATOMIC_ORDER_CONFLICT');
    }

    const transitioned = currentPlan.state === expectedState;
    if (transitioned) this.plans.set(plan.id, copy(plan));
    const persistedPlan = this.plans.get(plan.id);
    if (!persistedPlan || persistedPlan.state !== 'SUBMITTED') return null;

    let orderInserted = false;
    if (!persistedOrder) {
      persistedOrder = copy(order);
      this.orders.set(persistedOrder.id, persistedOrder);
      this.events.push(copy(event));
      orderInserted = true;
    }

    let executionClaimed = false;
    if (persistedOrder.state === 'SUBMITTED' && !this.executionClaims.has(persistedOrder.id)) {
      this.executionClaims.set(persistedOrder.id, executionClaimId);
      executionClaimed = true;
    }

    return {
      plan: copy(persistedPlan),
      order: copy(persistedOrder),
      transitioned,
      orderInserted,
      executionClaimed,
    };
  }
  async savePlan(plan: TradingPlan) { this.plans.set(plan.id, copy(plan)); }
  async getOrder(userId: string, id: string) {
    const value = this.orders.get(id);
    return value?.userId === userId ? copy(value) : null;
  }
  async findOrderByPlan(userId: string, planId: string) {
    const value = [...this.orders.values()].find((item) => item.userId === userId && item.planId === planId);
    return value ? copy(value) : null;
  }
  async insertOrder(order: TradingOrder) {
    const existing = [...this.orders.values()].find((item) => item.userId === order.userId
      && (item.planId === order.planId
        || (item.exchange === order.exchange && item.clientOrderId === order.clientOrderId))) ?? null;
    if (existing) return { order: copy(existing), inserted: false };
    const stored = copy(order);
    this.orders.set(stored.id, stored);
    return { order: copy(stored), inserted: true };
  }
  async saveOrder(order: TradingOrder) { this.orders.set(order.id, copy(order)); }
  async listOrders(userId: string) {
    return [...this.orders.values()].filter((item) => item.userId === userId).map(copy);
  }
  async appendEvent(event: TradingOrderEvent) { this.events.push(copy(event)); }
  async listEvents(userId: string) {
    return this.events.filter((item) => item.userId === userId).map(copy);
  }
}

function databaseError() {
  return new Error('TRADE_AUTOMATION_STORAGE_UNAVAILABLE');
}

function assertOwner(actual: string, expected: string) {
  if (actual !== expected) throw new Error('USER_SCOPE_MISMATCH');
}

function isUniqueViolation(error: unknown) {
  return error !== null && typeof error === 'object'
    && 'code' in error && String((error as { code?: unknown }).code) === '23505';
}

function planRow(plan: TradingPlan) {
  return {
    user_id: plan.userId,
    id: plan.id,
    idempotency_key: plan.idempotencyKey,
    state: plan.state,
    payload: plan,
    approval_expires_at: plan.approvalExpiresAt,
    updated_at: plan.updatedAt,
  };
}

function orderRow(order: TradingOrder) {
  return {
    user_id: order.userId,
    id: order.id,
    plan_id: order.planId,
    client_order_id: order.clientOrderId,
    exchange: order.exchange,
    state: order.state,
    payload: order,
    updated_at: order.updatedAt,
  };
}

function atomicResult(data: unknown): AtomicPlanOrderResult | null {
  const candidate = Array.isArray(data) ? data[0] : data;
  if (!candidate || typeof candidate !== 'object') return null;
  const row = candidate as Record<string, unknown>;
  if (!row.plan_payload || !row.order_payload) return null;
  return {
    plan: row.plan_payload as TradingPlan,
    order: row.order_payload as TradingOrder,
    transitioned: row.transitioned === true,
    orderInserted: row.order_inserted === true,
    executionClaimed: row.execution_claimed === true,
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
    return data?.payload as TradingOrder | null;
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
    async findPlanByIdempotency(userId, key) {
      return selectPlanByIdempotency(userId, key);
    },
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
        .eq('user_id', userId).order('updated_at', { ascending: false }).limit(100);
      if (error) throw databaseError();
      return (data ?? []).map((row) => row.payload as TradingPlan);
    },
    async insertPlan(plan) {
      owned(plan.userId);
      const { error } = await client.from('trade_order_plans').insert(planRow(plan));
      if (!error) return { plan, inserted: true };
      if (!isUniqueViolation(error)) throw databaseError();
      const existing = await selectPlanByIdempotency(plan.userId, plan.idempotencyKey);
      if (!existing) throw databaseError();
      return { plan: existing, inserted: false };
    },
    async compareAndSetPlan(plan, expectedState) {
      owned(plan.userId);
      const { data, error } = await client.from('trade_order_plans').update(planRow(plan))
        .eq('user_id', plan.userId).eq('id', plan.id).eq('state', expectedState)
        .select('payload').maybeSingle();
      if (error) throw databaseError();
      return data?.payload as TradingPlan | null;
    },
    async submitPlanAndCreateOrder(plan, expectedState, order, event, executionClaimId) {
      owned(plan.userId);
      assertOwner(order.userId, authenticatedUserId);
      assertOwner(event.userId, authenticatedUserId);
      const { data, error } = await client.rpc('submit_trade_plan_order', {
        p_expected_state: expectedState,
        p_plan_payload: plan,
        p_order_payload: order,
        p_event_payload: event,
        p_execution_claim_id: executionClaimId,
      });
      if (error) throw databaseError();
      return atomicResult(data);
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
      return data?.payload as TradingOrder | null;
    },
    async findOrderByPlan(userId, planId) {
      return selectOrderByPlan(userId, planId);
    },
    async insertOrder(order) {
      owned(order.userId);
      const { error } = await client.from('trade_orders').insert(orderRow(order));
      if (!error) return { order, inserted: true };
      if (!isUniqueViolation(error)) throw databaseError();
      const existing = await selectOrderByPlan(order.userId, order.planId);
      if (!existing) throw databaseError();
      return { order: existing, inserted: false };
    },
    async saveOrder(order) {
      owned(order.userId);
      const { error } = await client.from('trade_orders').upsert(orderRow(order), { onConflict: 'user_id,id' });
      if (error) throw databaseError();
    },
    async listOrders(userId) {
      owned(userId);
      const { data, error } = await client.from('trade_orders').select('payload')
        .eq('user_id', userId).order('updated_at', { ascending: false }).limit(200);
      if (error) throw databaseError();
      return (data ?? []).map((row) => row.payload as TradingOrder);
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
        .eq('user_id', userId).order('created_at', { ascending: false }).limit(500);
      if (error) throw databaseError();
      return (data ?? []).map((row) => row.payload as TradingOrderEvent);
    },
  };
}

function toConnection(row: Record<string, unknown>): ExchangeConnection {
  return {
    userId: String(row.user_id), exchange: String(row.exchange) as TradingExchange,
    accountMode: String(row.account_mode) as ExchangeConnection['accountMode'],
    configured: row.configured === true, encryptedCredentials: row.encrypted_credentials ? String(row.encrypted_credentials) : null,
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
