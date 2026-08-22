import {
  createSupabaseTelegramAlertPolicyRepository,
  type TelegramAlertPolicyRepository,
} from '../features/user-broker-telegram/telegram-alert-policy.repository';
import {
  createSupabaseUserBrokerTelegramRepository,
  type UserBrokerTelegramRepository,
} from '../features/user-broker-telegram/user-broker-telegram.repository';
import {
  deliverTelegramAlertWithPolicy,
  type TelegramPolicyDeliveryResult,
  type TelegramPolicyEvent,
} from './telegram-alert-policy.service';
import type { TelegramAlertInput, TelegramAlertResult } from './telegram-notification.service';

type ConnectionReader = Pick<UserBrokerTelegramRepository, 'getTelegramConnection'>;
type PolicyReader = Pick<TelegramAlertPolicyRepository, 'getPolicy'>;
type Sender = (input: TelegramAlertInput) => Promise<TelegramAlertResult>;

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
    };

export type PersonalTelegramAlertDependencies = {
  connectionRepository?: ConnectionReader;
  policyRepository?: PolicyReader;
  sender?: Sender;
};

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

  const connectionRepository = dependencies.connectionRepository
    ?? createSupabaseUserBrokerTelegramRepository();
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
    return { status: 'POLICY', reason: null, policy };
  } catch {
    return { status: 'SKIPPED', reason: 'STORAGE_UNAVAILABLE', policy: null };
  }
}
