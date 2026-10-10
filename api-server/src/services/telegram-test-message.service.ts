import {
  createSupabaseUserBrokerTelegramRepository,
  type UserBrokerTelegramRepository,
} from '../features/user-broker-telegram/user-broker-telegram.repository';
import {
  sendTelegramAlert,
  type TelegramAlertInput,
  type TelegramAlertResult,
} from './telegram-notification.service';

type ConnectionRepository = Pick<UserBrokerTelegramRepository, 'getTelegramConnection' | 'revokeTelegramConnection'>;
type Sender = (input: TelegramAlertInput) => Promise<TelegramAlertResult>;

export type TelegramTestMessageResult =
  | {
      ok: true;
      httpStatus: 200;
      status: 'DELIVERED';
      attempts: number;
      testOnly: true;
      investmentSignal: false;
      orderAuthority: 'NONE';
      privateApiRequests: 0;
      ordersSubmitted: 0;
      ordersCancelled: 0;
    }
  | {
      ok: false;
      httpStatus: 409 | 502 | 503;
      error: string;
      attempts: number;
      privateApiRequests: 0;
      ordersSubmitted: 0;
      ordersCancelled: 0;
    };

export type TelegramTestMessageDependencies = {
  connectionRepository?: ConnectionRepository;
  sender?: Sender;
  now?: () => Date;
  activationApproved?: () => boolean;
};

const TEST_MESSAGE = '[TEST] Telegram 연결 확인 메시지입니다. 투자 신호가 아니며 실제 주문/체결이 아닙니다.';

export function isTelegramActivationApproved(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return environment.LIVE_TELEGRAM_ACTIVATION_APPROVED === 'true';
}

export async function sendPersonalTelegramTestMessage(
  userId: string,
  dependencies: TelegramTestMessageDependencies = {},
): Promise<TelegramTestMessageResult> {
  const activationApproved = dependencies.activationApproved?.()
    ?? isTelegramActivationApproved();
  if (!activationApproved) {
    return {
      ok: false,
      httpStatus: 503,
      error: 'TELEGRAM_ACTIVATION_REQUIRED',
      attempts: 0,
      privateApiRequests: 0,
      ordersSubmitted: 0,
      ordersCancelled: 0,
    };
  }

  const connectionRepository = dependencies.connectionRepository
    ?? createSupabaseUserBrokerTelegramRepository();
  const sender = dependencies.sender ?? sendTelegramAlert;
  const now = dependencies.now?.() ?? new Date();
  const connection = await connectionRepository.getTelegramConnection(userId);

  if (!connection || connection.status !== 'ACTIVE' || !connection.telegramChatId.trim()) {
    return {
      ok: false,
      httpStatus: 409,
      error: 'TELEGRAM_NOT_CONNECTED',
      attempts: 0,
      privateApiRequests: 0,
      ordersSubmitted: 0,
      ordersCancelled: 0,
    };
  }

  const result = await sender({
    type: 'intelligence_report',
    details: TEST_MESSAGE,
    timestamp: now.toISOString(),
    destinationChatId: connection.telegramChatId,
    dedupeKey: `telegram-connection-test:${now.getTime()}`,
    duplicateWindowMs: 0,
    cooldownMs: 0,
    linkPreview: false,
  });

  if (!result.ok) {
    if (result.errorCode === 'TELEGRAM_HTTP_403' || result.errorCode?.startsWith('TELEGRAM_FORBIDDEN_')) {
      await connectionRepository.revokeTelegramConnection(userId, now.toISOString());
    }
    return {
      ok: false,
      httpStatus: result.skipped === 'NOT_CONFIGURED' ? 503 : 502,
      error: result.errorCode ?? `TELEGRAM_TEST_${result.skipped}`,
      attempts: result.attempts,
      privateApiRequests: 0,
      ordersSubmitted: 0,
      ordersCancelled: 0,
    };
  }

  return {
    ok: true,
    httpStatus: 200,
    status: 'DELIVERED',
    attempts: result.attempts,
    testOnly: true,
    investmentSignal: false,
    orderAuthority: 'NONE',
    privateApiRequests: 0,
    ordersSubmitted: 0,
    ordersCancelled: 0,
  };
}
