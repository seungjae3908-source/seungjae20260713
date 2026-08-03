import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase, getUserSupabase, hasSupabaseServerKey } from '../lib/supabase';
import {
  DEFAULT_TRADING_POLICY,
  type ExchangeConnection,
  type TradingExchange,
  type TradingOrder,
  type TradingOrderEvent,
  type TradingPlan,
  type TradingPolicy,
} from './trade-automation.types';
import { normalizeTradingPolicy } from './trade-automation-risk.service';

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
  savePlan(plan: TradingPlan): Promise<void>;
  getOrder(userId: string, id: string): Promise<TradingOrder | null>;
  findOrderByPlan(userId: string, planId: string): Promise<TradingOrder | null>;
  saveOrder(order: TradingOrder): Promise<void>;
  listOrders(userId: string): Promise<TradingOrder[]>;
  appendEvent(event: TradingOrderEvent): Promise<void>;
  listEvents(userId: string): Promise<TradingOrderEvent[]>;
}

export class InMemoryTradingRepository implements TradingRepository {
  private globalEmergencyStopped = false;
  private policies = new Map<string, TradingPolicy>();
  private connections = new Map<string, ExchangeConnection>();
  private plans = new Map<string, TradingPlan>();
  private orders = new Map<string, TradingOrder>();
  private events: TradingOrderEvent[] = [];

  async getGlobalEmergencyStop() { return this.globalEmergencyStopped; }
  async setGlobalEmergencyStop(stopped: boolean, _changedBy: string) { this.globalEmergencyStopped = stopped; }
  async getPolicy(userId: string) { return this.policies.get(userId) ?? normalizeTradingPolicy(DEFAULT_TRADING_POLICY); }
  async savePolicy(userId: string, policy: TradingPolicy) { this.policies.set(userId, policy); return policy; }
  async getConnections(userId: string) { return [...this.connections.values()].filter((item) => item.userId === userId); }
  async getConnection(userId: string, exchange: TradingExchange) { return this.connections.get(`${userId}:${exchange}`) ?? null; }
  async saveConnection(connection: ExchangeConnection) { this.connections.set(`${connection.userId}:${connection.exchange}`, connection); }
  async findPlanByIdempotency(userId: string, key: string) {
    return [...this.plans.values()].find((item) => item.userId === userId && item.idempotencyKey === key) ?? null;
  }
  async getPlan(userId: string, id: string) { const value = this.plans.get(id); return value?.userId === userId ? value : null; }
  async savePlan(plan: TradingPlan) { this.plans.set(plan.id, plan); }
  async getOrder(userId: string, id: string) { const value = this.orders.get(id); return value?.userId === userId ? value : null; }
  async findOrderByPlan(userId: string, planId: string) {
    return [...this.orders.values()].find((item) => item.userId === userId && item.planId === planId) ?? null;
  }
  async saveOrder(order: TradingOrder) { this.orders.set(order.id, order); }
  async listOrders(userId: string) { return [...this.orders.values()].filter((item) => item.userId === userId); }
  async appendEvent(event: TradingOrderEvent) { this.events.push(event); }
  async listEvents(userId: string) { return this.events.filter((item) => item.userId === userId); }
}

function databaseError() {
  return new Error('TRADE_AUTOMATION_STORAGE_UNAVAILABLE');
}

function assertOwner(actual: string, expected: string) {
  if (actual !== expected) throw new Error('USER_SCOPE_MISMATCH');
}

export function createSupabaseTradingRepository(accessToken: string, authenticatedUserId: string): TradingRepository {
  if (!accessToken || !authenticatedUserId) throw new Error('LOGIN_REQUIRED');
  const client = getUserSupabase(accessToken);
  const secureClient = () => {
    if (!hasSupabaseServerKey()) throw new Error('TRADE_CREDENTIAL_STORAGE_UNAVAILABLE');
    return getSupabase();
  };
  const owned = (userId: string) => assertOwner(userId, authenticatedUserId);
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
      owned(userId);
      const { data, error } = await client.from('trade_order_plans').select('payload')
        .eq('user_id', userId).eq('idempotency_key', key).maybeSingle();
      if (error) throw databaseError();
      return data?.payload as TradingPlan | null;
    },
    async getPlan(userId, id) {
      owned(userId);
      const { data, error } = await client.from('trade_order_plans').select('payload')
        .eq('user_id', userId).eq('id', id).maybeSingle();
      if (error) throw databaseError();
      return data?.payload as TradingPlan | null;
    },
    async savePlan(plan) {
      owned(plan.userId);
      const { error } = await client.from('trade_order_plans').upsert({
        user_id: plan.userId, id: plan.id, idempotency_key: plan.idempotencyKey,
        state: plan.state, payload: plan, approval_expires_at: plan.approvalExpiresAt,
        updated_at: plan.updatedAt,
      }, { onConflict: 'user_id,id' });
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
      owned(userId);
      const { data, error } = await client.from('trade_orders').select('payload')
        .eq('user_id', userId).eq('plan_id', planId).maybeSingle();
      if (error) throw databaseError();
      return data?.payload as TradingOrder | null;
    },
    async saveOrder(order) {
      owned(order.userId);
      const { error } = await client.from('trade_orders').upsert({
        user_id: order.userId, id: order.id, plan_id: order.planId, client_order_id: order.clientOrderId,
        exchange: order.exchange, state: order.state, payload: order, updated_at: order.updatedAt,
      }, { onConflict: 'user_id,id' });
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
