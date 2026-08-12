import { getSupabase, hasSupabaseServerKey } from '../../lib/supabase';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationDelivery,
  type NotificationDeliveryState,
  type NotificationPreferences,
  type TelegramLinkTokenRecord,
  type UserExecutionEvent,
  type UserTelegramConnection,
} from './user-broker-telegram.types';

export interface UserBrokerTelegramRepository {
  createLinkToken(record: TelegramLinkTokenRecord): Promise<void>;
  consumeLinkToken(tokenHash: string, consumedAt: string): Promise<string | null>;
  getTelegramConnection(userId: string): Promise<UserTelegramConnection | null>;
  bindTelegramConnection(connection: UserTelegramConnection): Promise<void>;
  revokeTelegramConnection(userId: string, revokedAt: string): Promise<void>;
  getPreferences(userId: string): Promise<NotificationPreferences>;
  savePreferences(userId: string, preferences: NotificationPreferences, updatedAt: string): Promise<void>;
  insertExecutionEvent(event: UserExecutionEvent): Promise<boolean>;
  getExecutionEvent(userId: string, eventId: string): Promise<UserExecutionEvent | null>;
  enqueueDelivery(delivery: NotificationDelivery): Promise<boolean>;
  getDelivery(userId: string, deliveryId: string): Promise<NotificationDelivery | null>;
  listDeliveries(userId: string): Promise<NotificationDelivery[]>;
  claimDelivery(userId: string, deliveryId: string, updatedAt: string): Promise<NotificationDelivery | null>;
  finishDelivery(
    userId: string,
    deliveryId: string,
    state: Extract<NotificationDeliveryState, 'SENT' | 'FAILED' | 'RETRY_SCHEDULED' | 'DEAD_LETTER'>,
    attempts: number,
    nextRetryAt: string | null,
    lastErrorCode: string | null,
    updatedAt: string,
  ): Promise<NotificationDelivery | null>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function normalizedPreferences(value?: Partial<NotificationPreferences> | null): NotificationPreferences {
  return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...(value ?? {}) };
}

export class InMemoryUserBrokerTelegramRepository implements UserBrokerTelegramRepository {
  private linkTokens = new Map<string, TelegramLinkTokenRecord>();
  private connections = new Map<string, UserTelegramConnection>();
  private preferences = new Map<string, NotificationPreferences>();
  private events = new Map<string, UserExecutionEvent>();
  private deliveries = new Map<string, NotificationDelivery>();
  private deliveryDedupe = new Map<string, string>();

  async createLinkToken(record: TelegramLinkTokenRecord) {
    this.linkTokens.set(record.tokenHash, copy(record));
  }

  async consumeLinkToken(tokenHash: string, consumedAt: string) {
    const record = this.linkTokens.get(tokenHash);
    if (!record || record.consumedAt || record.expiresAt <= consumedAt) return null;
    record.consumedAt = consumedAt;
    return record.userId;
  }

  async getTelegramConnection(userId: string) {
    const value = this.connections.get(userId);
    return value ? copy(value) : null;
  }

  async bindTelegramConnection(connection: UserTelegramConnection) {
    const conflict = [...this.connections.values()].find((item) =>
      item.status === 'ACTIVE'
      && item.userId !== connection.userId
      && item.telegramChatId === connection.telegramChatId,
    );
    if (conflict) throw new Error('TELEGRAM_CHAT_ALREADY_LINKED');
    this.connections.set(connection.userId, copy(connection));
  }

  async revokeTelegramConnection(userId: string, revokedAt: string) {
    const current = this.connections.get(userId);
    if (!current) return;
    current.status = 'REVOKED';
    current.revokedAt = revokedAt;
    current.updatedAt = revokedAt;
  }

  async getPreferences(userId: string) {
    return normalizedPreferences(copy(this.preferences.get(userId)));
  }

  async savePreferences(userId: string, preferences: NotificationPreferences, _updatedAt: string) {
    this.preferences.set(userId, normalizedPreferences(copy(preferences)));
  }

  async insertExecutionEvent(event: UserExecutionEvent) {
    const key = `${event.userId}:${event.sourceEventId}`;
    if ([...this.events.values()].some((item) => `${item.userId}:${item.sourceEventId}` === key)) return false;
    this.events.set(`${event.userId}:${event.id}`, copy(event));
    return true;
  }

  async getExecutionEvent(userId: string, eventId: string) {
    const value = this.events.get(`${userId}:${eventId}`);
    return value ? copy(value) : null;
  }

  async enqueueDelivery(delivery: NotificationDelivery) {
    const dedupe = `${delivery.userId}:${delivery.dedupeKey}`;
    if (this.deliveryDedupe.has(dedupe)) return false;
    this.deliveryDedupe.set(dedupe, delivery.id);
    this.deliveries.set(`${delivery.userId}:${delivery.id}`, copy(delivery));
    return true;
  }

  async getDelivery(userId: string, deliveryId: string) {
    const value = this.deliveries.get(`${userId}:${deliveryId}`);
    return value ? copy(value) : null;
  }

  async listDeliveries(userId: string) {
    return [...this.deliveries.values()]
      .filter((item) => item.userId === userId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(copy);
  }

  async claimDelivery(userId: string, deliveryId: string, updatedAt: string) {
    const key = `${userId}:${deliveryId}`;
    const current = this.deliveries.get(key);
    if (!current || !['PENDING', 'RETRY_SCHEDULED', 'FAILED'].includes(current.state)) return null;
    if (current.nextRetryAt && current.nextRetryAt > updatedAt) return null;
    current.state = 'SENDING';
    current.updatedAt = updatedAt;
    return copy(current);
  }

  async finishDelivery(
    userId: string,
    deliveryId: string,
    state: Extract<NotificationDeliveryState, 'SENT' | 'FAILED' | 'RETRY_SCHEDULED' | 'DEAD_LETTER'>,
    attempts: number,
    nextRetryAt: string | null,
    lastErrorCode: string | null,
    updatedAt: string,
  ) {
    const current = this.deliveries.get(`${userId}:${deliveryId}`);
    if (!current || current.state !== 'SENDING') return null;
    Object.assign(current, { state, attempts, nextRetryAt, lastErrorCode, updatedAt });
    return copy(current);
  }
}

function databaseError(): Error {
  return new Error('USER_BROKER_TELEGRAM_STORAGE_UNAVAILABLE');
}

function secureClient() {
  if (!hasSupabaseServerKey()) throw databaseError();
  return getSupabase();
}

function toConnection(row: Record<string, unknown>): UserTelegramConnection {
  return {
    userId: String(row.user_id),
    telegramChatId: String(row.telegram_chat_id),
    telegramUserId: String(row.telegram_user_id),
    status: row.status === 'REVOKED' ? 'REVOKED' : 'ACTIVE',
    connectedAt: String(row.connected_at),
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    updatedAt: String(row.updated_at),
  };
}

function toDelivery(row: Record<string, unknown>): NotificationDelivery {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    eventId: String(row.event_id),
    dedupeKey: String(row.dedupe_key),
    state: String(row.state) as NotificationDeliveryState,
    attempts: Number(row.attempts ?? 0),
    nextRetryAt: row.next_retry_at ? String(row.next_retry_at) : null,
    lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createSupabaseUserBrokerTelegramRepository(): UserBrokerTelegramRepository {
  return {
    async createLinkToken(record) {
      const { error } = await secureClient().from('telegram_link_tokens').insert({
        token_hash: record.tokenHash,
        user_id: record.userId,
        expires_at: record.expiresAt,
        consumed_at: record.consumedAt,
        created_at: record.createdAt,
      });
      if (error) throw databaseError();
    },

    async consumeLinkToken(tokenHash, consumedAt) {
      const { data, error } = await secureClient().from('telegram_link_tokens')
        .update({ consumed_at: consumedAt })
        .eq('token_hash', tokenHash)
        .is('consumed_at', null)
        .gt('expires_at', consumedAt)
        .select('user_id')
        .maybeSingle();
      if (error) throw databaseError();
      return data?.user_id ? String(data.user_id) : null;
    },

    async getTelegramConnection(userId) {
      const { data, error } = await secureClient().from('telegram_connections').select('*')
        .eq('user_id', userId).maybeSingle();
      if (error) throw databaseError();
      return data ? toConnection(data as Record<string, unknown>) : null;
    },

    async bindTelegramConnection(connection) {
      const { error } = await secureClient().from('telegram_connections').upsert({
        user_id: connection.userId,
        telegram_chat_id: connection.telegramChatId,
        telegram_user_id: connection.telegramUserId,
        status: connection.status,
        connected_at: connection.connectedAt,
        revoked_at: connection.revokedAt,
        updated_at: connection.updatedAt,
      }, { onConflict: 'user_id' });
      if (error) {
        if (String(error.code ?? '') === '23505') throw new Error('TELEGRAM_CHAT_ALREADY_LINKED');
        throw databaseError();
      }
    },

    async revokeTelegramConnection(userId, revokedAt) {
      const { error } = await secureClient().from('telegram_connections').update({
        status: 'REVOKED', revoked_at: revokedAt, updated_at: revokedAt,
      }).eq('user_id', userId);
      if (error) throw databaseError();
    },

    async getPreferences(userId) {
      const { data, error } = await secureClient().from('notification_preferences')
        .select('payload').eq('user_id', userId).maybeSingle();
      if (error) throw databaseError();
      return normalizedPreferences((data?.payload ?? null) as Partial<NotificationPreferences> | null);
    },

    async savePreferences(userId, preferences, updatedAt) {
      const { error } = await secureClient().from('notification_preferences').upsert({
        user_id: userId, payload: preferences, updated_at: updatedAt,
      }, { onConflict: 'user_id' });
      if (error) throw databaseError();
    },

    async insertExecutionEvent(event) {
      const { error } = await secureClient().from('user_execution_events').insert({
        user_id: event.userId,
        id: event.id,
        source_event_id: event.sourceEventId,
        event_type: event.type,
        source: event.source,
        payload: event,
        occurred_at: event.occurredAt,
      });
      if (!error) return true;
      if (String(error.code ?? '') === '23505') return false;
      throw databaseError();
    },

    async getExecutionEvent(userId, eventId) {
      const { data, error } = await secureClient().from('user_execution_events').select('payload')
        .eq('user_id', userId).eq('id', eventId).maybeSingle();
      if (error) throw databaseError();
      return data?.payload ? data.payload as UserExecutionEvent : null;
    },

    async enqueueDelivery(delivery) {
      const { error } = await secureClient().from('notification_deliveries').insert({
        user_id: delivery.userId,
        id: delivery.id,
        event_id: delivery.eventId,
        dedupe_key: delivery.dedupeKey,
        state: delivery.state,
        attempts: delivery.attempts,
        next_retry_at: delivery.nextRetryAt,
        last_error_code: delivery.lastErrorCode,
        created_at: delivery.createdAt,
        updated_at: delivery.updatedAt,
      });
      if (!error) return true;
      if (String(error.code ?? '') === '23505') return false;
      throw databaseError();
    },

    async getDelivery(userId, deliveryId) {
      const { data, error } = await secureClient().from('notification_deliveries').select('*')
        .eq('user_id', userId).eq('id', deliveryId).maybeSingle();
      if (error) throw databaseError();
      return data ? toDelivery(data as Record<string, unknown>) : null;
    },

    async listDeliveries(userId) {
      const { data, error } = await secureClient().from('notification_deliveries').select('*')
        .eq('user_id', userId).order('created_at', { ascending: false }).limit(100);
      if (error) throw databaseError();
      return (data ?? []).map((row) => toDelivery(row as Record<string, unknown>));
    },

    async claimDelivery(userId, deliveryId, updatedAt) {
      const { data, error } = await secureClient().from('notification_deliveries')
        .update({ state: 'SENDING', updated_at: updatedAt })
        .eq('user_id', userId)
        .eq('id', deliveryId)
        .in('state', ['PENDING', 'RETRY_SCHEDULED', 'FAILED'])
        .or(`next_retry_at.is.null,next_retry_at.lte.${updatedAt}`)
        .select('*')
        .maybeSingle();
      if (error) throw databaseError();
      return data ? toDelivery(data as Record<string, unknown>) : null;
    },

    async finishDelivery(userId, deliveryId, state, attempts, nextRetryAt, lastErrorCode, updatedAt) {
      const { data, error } = await secureClient().from('notification_deliveries').update({
        state,
        attempts,
        next_retry_at: nextRetryAt,
        last_error_code: lastErrorCode,
        updated_at: updatedAt,
      }).eq('user_id', userId).eq('id', deliveryId).eq('state', 'SENDING').select('*').maybeSingle();
      if (error) throw databaseError();
      return data ? toDelivery(data as Record<string, unknown>) : null;
    },
  };
}
