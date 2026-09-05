import { randomUUID } from 'node:crypto';
import {
  createSupabaseTelegramAlertPolicyRepository,
  type TelegramAlertPolicyRepository,
} from '../features/user-broker-telegram/telegram-alert-policy.repository';
import {
  createSupabaseUserBrokerTelegramRepository,
  type UserBrokerTelegramRepository,
} from '../features/user-broker-telegram/user-broker-telegram.repository';
import type { StoredPersonalTelegramAlert } from '../features/user-broker-telegram/user-broker-telegram.types';
import {
  createSupabasePersonalTelegramDigestRepository,
  type PersonalTelegramDigestRepository,
} from './personal-telegram-digest.repository';
import {
  TELEGRAM_POLICY_SAFETY,
  deliverTelegramAlertWithPolicy,
  evaluateTelegramAlertPolicy,
  type TelegramPolicyDeliveryHistory,
  type TelegramPolicyDeliveryResult,
  type TelegramPolicyEvent,
} from './telegram-alert-policy.service';
import type { TelegramAlertInput, TelegramAlertResult } from './telegram-notification.service';

type ConnectionReader = Pick<UserBrokerTelegramRepository, 'getTelegramConnection'>;
type OutboxRepository = Pick<
  UserBrokerTelegramRepository,
  'enqueueDelivery' | 'listPersonalAlertHistory'
>;
type PolicyReader = Pick<TelegramAlertPolicyRepository, 'getPolicy'>;
type Sender = (input: TelegramAlertInput) => Promise<TelegramAlertResult>;

const POLICY_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type PersonalTelegramAlertDispatchResult =
  | {
      status: 'SKIPPED';
      reason: 'INVALID_USER' | 'TELEGRAM_DISCONNECTED' | 'STORAGE_UNAVAILABLE';
      policy: null;
    }
  | {
      status: 'POLICY';
      reason: null;
      policy: TelegramPolicyDeliveryResult;
      deliveryQueued?: boolean;
      deliveryId?: string | null;
      digestDueAt?: string | null;
      digestItemCount?: number | null;
    };

export type PersonalTelegramAlertDependencies = {
  connectionRepository?: ConnectionReader;
  policyRepository?: PolicyReader;
  outboxRepository?: OutboxRepository;
  digestRepository?: PersonalTelegramDigestRepository;
  /** Test seam: an injected sender keeps the historical direct-delivery contract. */
  sender?: Sender;
};

function storedAlert(input: TelegramAlertInput): StoredPersonalTelegramAlert {
  const {
    destinationChatId: _destinationChatId,
    photo,
    ...safe
  } = input;
  return {
    ...safe,
    photo: typeof photo?.url === 'string' && photo.url.trim()
      ? { url: photo.url.trim() }
      : undefined,
  };
}

function mergedHistory(
  primary: readonly TelegramPolicyDeliveryHistory[],
  digest: readonly TelegramPolicyDeliveryHistory[],
): TelegramPolicyDeliveryHistory[] {
  const result: TelegramPolicyDeliveryHistory[] = [];
  const seen = new Set<string>();
  for (const item of [...primary, ...digest].sort((left, right) => right.deliveredAt.localeCompare(left.deliveredAt))) {
    const key = `${item.userId}:${item.eventId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result.slice(0, 512);
}

export async function deliverPersonalTelegramAlert(
  input: {
    userId: string;
    event: TelegramPolicyEvent;
    alert: TelegramAlertInput;
    now?: Date;
  },
  dependencies: PersonalTelegramAlertDependencies = {},
): Promise<PersonalTelegramAlertDispatchResult> {
  const userId = input.userId.trim();
  if (!userId || input.event.userId !== userId) {
    return { status: 'SKIPPED', reason: 'INVALID_USER', policy: null };
  }

  const runtimeRepository = createSupabaseUserBrokerTelegramRepository();
  const connectionRepository = dependencies.connectionRepository ?? runtimeRepository;
  const policyRepository = dependencies.policyRepository
    ?? createSupabaseTelegramAlertPolicyRepository();

  try {
    const [connection, policyState] = await Promise.all([
      connectionRepository.getTelegramConnection(userId),
      policyRepository.getPolicy(userId),
    ]);
    if (!connection || connection.status !== 'ACTIVE' || !connection.telegramChatId.trim()) {
      return { status: 'SKIPPED', reason: 'TELEGRAM_DISCONNECTED', policy: null };
    }

    // Preserve deterministic unit/contract tests and explicit injected transports.
    // Runtime callers do not inject a sender and therefore use the durable outbox below.
    if (dependencies.sender) {
      const policy = await deliverTelegramAlertWithPolicy({
        policy: policyState.policy,
        event: input.event,
        alert: {
          ...input.alert,
          destinationChatId: connection.telegramChatId,
        },
        now: input.now,
        sender: dependencies.sender,
      });
      return { status: 'POLICY', reason: null, policy, deliveryQueued: false, deliveryId: null };
    }

    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) {
      return { status: 'SKIPPED', reason: 'STORAGE_UNAVAILABLE', policy: null };
    }
    const outboxRepository = dependencies.outboxRepository ?? runtimeRepository;
    const digestRepository = dependencies.digestRepository ?? createSupabasePersonalTelegramDigestRepository();
    const since = new Date(now.getTime() - POLICY_HISTORY_WINDOW_MS).toISOString();
    const [directHistory, digestHistory] = await Promise.all([
      outboxRepository.listPersonalAlertHistory(userId, since, 256),
      digestRepository.listSentHistory(userId, since, 256),
    ]);
    const history = mergedHistory(directHistory, digestHistory);
    const decision = evaluateTelegramAlertPolicy(policyState.policy, input.event, history, now);
    const policy: TelegramPolicyDeliveryResult = {
      decision,
      transport: null,
      safety: TELEGRAM_POLICY_SAFETY,
    };

    if (decision.action === 'BATCHED') {
      const windowMs = decision.digestWindowMs;
      if (windowMs == null || !Number.isFinite(windowMs) || windowMs <= 0) {
        return { status: 'SKIPPED', reason: 'STORAGE_UNAVAILABLE', policy: null };
      }
      const digest = await digestRepository.append({
        userId,
        event: structuredClone(input.event),
        alert: storedAlert(input.alert),
        now,
        windowMs,
      });
      return {
        status: 'POLICY',
        reason: null,
        policy,
        deliveryQueued: digest.accepted,
        deliveryId: digest.deliveryId,
        digestDueAt: digest.dueAt,
        digestItemCount: digest.itemCount,
      };
    }

    if (decision.action !== 'IMMEDIATE') {
      return { status: 'POLICY', reason: null, policy, deliveryQueued: false, deliveryId: null };
    }

    const timestamp = now.toISOString();
    const deliveryId = randomUUID();
    const deliveryQueued = await outboxRepository.enqueueDelivery({
      id: deliveryId,
      userId,
      eventId: null,
      dedupeKey: `personal-alert:${input.event.eventId}`,
      state: 'PENDING',
      attempts: 0,
      nextRetryAt: null,
      lastErrorCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      kind: 'PERSONAL_ALERT',
      payload: {
        event: structuredClone(input.event),
        alert: storedAlert(input.alert),
      },
    });
    return {
      status: 'POLICY',
      reason: null,
      policy,
      deliveryQueued,
      deliveryId: deliveryQueued ? deliveryId : null,
      digestDueAt: null,
      digestItemCount: null,
    };
  } catch {
    return { status: 'SKIPPED', reason: 'STORAGE_UNAVAILABLE', policy: null };
  }
}
