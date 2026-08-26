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
  TELEGRAM_POLICY_SAFETY,
  deliverTelegramAlertWithPolicy,
  evaluateTelegramAlertPolicy,
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
    };

export type PersonalTelegramAlertDependencies = {
  connectionRepository?: ConnectionReader;
  policyRepository?: PolicyReader;
  outboxRepository?: OutboxRepository;
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

function digestWindowDueAt(now: Date, windowMs: number): string {
  const bucket = Math.floor(now.getTime() / windowMs) + 1;
  return new Date(bucket * windowMs).toISOString();
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
    const since = new Date(now.getTime() - POLICY_HISTORY_WINDOW_MS).toISOString();
    const history = await outboxRepository.listPersonalAlertHistory(userId, since, 256);
    const decision = evaluateTelegramAlertPolicy(policyState.policy, input.event, history, now);
    const policy: TelegramPolicyDeliveryResult = {
      decision,
      transport: null,
      safety: TELEGRAM_POLICY_SAFETY,
    };
    if (decision.action === 'SUPPRESSED') {
      return { status: 'POLICY', reason: null, policy, deliveryQueued: false, deliveryId: null };
    }

    const batched = decision.action === 'BATCHED';
    if (batched && (!decision.digestKey || !decision.digestWindowMs || decision.digestWindowMs <= 0)) {
      return { status: 'SKIPPED', reason: 'STORAGE_UNAVAILABLE', policy: null };
    }
    const timestamp = now.toISOString();
    const digestDueAt = batched
      ? digestWindowDueAt(now, decision.digestWindowMs!)
      : null;
    const deliveryId = randomUUID();
    const deliveryQueued = await outboxRepository.enqueueDelivery({
      id: deliveryId,
      userId,
      eventId: null,
      dedupeKey: `personal-alert:${input.event.eventId}`,
      state: 'PENDING',
      attempts: 0,
      nextRetryAt: digestDueAt,
      lastErrorCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      kind: 'PERSONAL_ALERT',
      payload: {
        event: structuredClone(input.event),
        alert: storedAlert(input.alert),
        deliveryMode: batched ? 'BATCHED' : 'IMMEDIATE',
        digestKey: batched ? decision.digestKey : null,
        digestWindowMs: batched ? decision.digestWindowMs : null,
        digestDueAt,
      },
    });
    return {
      status: 'POLICY',
      reason: null,
      policy,
      deliveryQueued,
      deliveryId: deliveryQueued ? deliveryId : null,
    };
  } catch {
    return { status: 'SKIPPED', reason: 'STORAGE_UNAVAILABLE', policy: null };
  }
}
