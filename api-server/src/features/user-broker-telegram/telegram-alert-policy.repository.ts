import { getSupabase, hasSupabaseServerKey } from '../../lib/supabase';
import {
  applyTelegramAlertPolicyPatch,
  defaultTelegramAlertPolicy,
  isValidTelegramAlertPolicy,
  type TelegramAlertPolicy,
} from '../../services/telegram-alert-policy.service';
import { mutateNotificationEnabledTypes } from './user-broker-telegram.repository';

export const TELEGRAM_ALERT_POLICY_MARKER = 'telegram_alert_policy_v1:';

export type TelegramAlertPolicySource = 'STORED' | 'DEFAULT_MISSING' | 'DEFAULT_INVALID';
export type TelegramAlertPolicyRead = {
  policy: TelegramAlertPolicy;
  source: TelegramAlertPolicySource;
};

export interface TelegramAlertPolicyRepository {
  getPolicy(userId: string): Promise<TelegramAlertPolicyRead>;
  savePolicy(userId: string, patch: unknown, updatedAt: string): Promise<TelegramAlertPolicyRead>;
}

const STORED_POLICY_KEYS = [
  'enabled',
  'markets',
  'signalTypes',
  'priorities',
  'quietHours',
  'cooldownMs',
  'sameEventDedupeMs',
  'sameSymbolWindowMs',
  'sameSymbolRepeatLimit',
  'deliveryMode',
  'digest',
] as const;
const MAX_STORED_POLICY_BYTES = 8 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactStoredKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...STORED_POLICY_KEYS].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function storedPayload(policy: TelegramAlertPolicy): Record<string, unknown> {
  return {
    enabled: policy.enabled,
    markets: [...policy.markets],
    signalTypes: [...policy.signalTypes],
    priorities: [...policy.priorities],
    quietHours: { ...policy.quietHours },
    cooldownMs: policy.cooldownMs,
    sameEventDedupeMs: policy.sameEventDedupeMs,
    sameSymbolWindowMs: policy.sameSymbolWindowMs,
    sameSymbolRepeatLimit: policy.sameSymbolRepeatLimit,
    deliveryMode: policy.deliveryMode,
    digest: { ...policy.digest },
  };
}

function encodePolicy(policy: TelegramAlertPolicy): string {
  if (!isValidTelegramAlertPolicy(policy)) throw new Error('TELEGRAM_ALERT_POLICY_INVALID');
  const encoded = Buffer.from(JSON.stringify(storedPayload(policy)), 'utf8').toString('base64url');
  if (encoded.length > MAX_STORED_POLICY_BYTES) throw new Error('TELEGRAM_ALERT_POLICY_INVALID');
  return `${TELEGRAM_ALERT_POLICY_MARKER}${encoded}`;
}

function decodePolicy(userId: string, markerValue: string): TelegramAlertPolicy | null {
  const encoded = markerValue.slice(TELEGRAM_ALERT_POLICY_MARKER.length);
  if (!encoded || encoded.length > MAX_STORED_POLICY_BYTES) return null;
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    if (Buffer.byteLength(decoded, 'utf8') > MAX_STORED_POLICY_BYTES) return null;
    const payload = record(JSON.parse(decoded));
    if (!payload || !exactStoredKeys(payload)) return null;
    return applyTelegramAlertPolicyPatch(defaultTelegramAlertPolicy(userId), payload);
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function telegramAlertPolicyFromEnabledTypes(
  userId: string,
  value: unknown,
): TelegramAlertPolicyRead {
  const markers = stringArray(value).filter((item) => item.startsWith(TELEGRAM_ALERT_POLICY_MARKER));
  if (markers.length === 0) {
    return { policy: defaultTelegramAlertPolicy(userId), source: 'DEFAULT_MISSING' };
  }
  if (markers.length !== 1) {
    return { policy: defaultTelegramAlertPolicy(userId), source: 'DEFAULT_INVALID' };
  }
  const policy = decodePolicy(userId, markers[0]);
  if (!policy) return { policy: defaultTelegramAlertPolicy(userId), source: 'DEFAULT_INVALID' };
  return { policy, source: 'STORED' };
}

export function enabledTypesWithTelegramAlertPolicy(
  value: unknown,
  policy: TelegramAlertPolicy,
): string[] {
  const preserved = stringArray(value).filter((item) => !item.startsWith(TELEGRAM_ALERT_POLICY_MARKER));
  return [...new Set(preserved), encodePolicy(policy)];
}

function databaseError(): Error {
  return new Error('USER_BROKER_TELEGRAM_STORAGE_UNAVAILABLE');
}

function secureClient() {
  if (!hasSupabaseServerKey()) throw databaseError();
  return getSupabase();
}

export function createSupabaseTelegramAlertPolicyRepository(): TelegramAlertPolicyRepository {
  return {
    async getPolicy(userId) {
      const { data, error } = await secureClient().from('notification_preferences')
        .select('enabled_types').eq('member_id', userId).maybeSingle();
      if (error) throw databaseError();
      return telegramAlertPolicyFromEnabledTypes(userId, data?.enabled_types);
    },

    async savePolicy(userId, patch, updatedAt) {
      let savedPolicy: TelegramAlertPolicy | null = null;
      await mutateNotificationEnabledTypes(userId, updatedAt, (enabledTypes) => {
        const current = telegramAlertPolicyFromEnabledTypes(userId, enabledTypes).policy;
        const next = applyTelegramAlertPolicyPatch(current, patch);
        savedPolicy = next;
        return enabledTypesWithTelegramAlertPolicy(enabledTypes, next);
      });
      if (!savedPolicy) throw databaseError();
      return { policy: savedPolicy, source: 'STORED' };
    },
  };
}