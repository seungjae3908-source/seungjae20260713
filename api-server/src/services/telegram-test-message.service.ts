import {
  createSupabaseUserBrokerTelegramRepository,
  type UserBrokerTelegramRepository,
} from '../features/user-broker-telegram/user-broker-telegram.repository';
import {
  sendTelegramAlert,
  type TelegramAlertInput,
  type TelegramAlertResult,
} from './telegram-notification.service';

type ConnectionReader = Pick<UserBrokerTelegramRepository, 'getTelegramConnection'>;
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
  connectionRepository?: ConnectionReader;
  sender?: Sender;
  now?: () => Date;
};

const TEST_MESSAGE = '[TEST] Telegram 연결 확인 메시지입니다. 투자 신호가 아니며 실제 주문/체결이 아닙니다.';

export async function sendPersonalTelegramTestMessage(
  userId: string,
  dependencies: TelegramTestMessageDependencies = {},
): Promise<TelegramTestMessageResult> {
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
    return {
      ok: false,
      httpStatus: result.skipped === 'NOT_CONFIGURED' ? 503 : 502,
      error: `TELEGRAM_TEST_${result.skipped}`,
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
