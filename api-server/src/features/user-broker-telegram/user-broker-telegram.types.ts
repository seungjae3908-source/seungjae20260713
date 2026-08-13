import type { TradingExchange, TradingSide } from '../../services/trade-automation.types';

export const USER_EXECUTION_EVENT_TYPES = [
  'SIGNAL_DETECTED',
  'ORDER_SUBMITTED',
  'ORDER_PARTIALLY_FILLED',
  'ORDER_FILLED',
  'ORDER_CANCELLED',
  'ORDER_REJECTED',
  'POSITION_OPENED',
  'POSITION_INCREASED',
  'POSITION_REDUCED',
  'POSITION_CLOSED',
  'TAKE_PROFIT_FILLED',
  'STOP_FILLED',
  'TRAILING_EXIT',
  'KILL_SWITCH',
  'STALE_DATA',
  'RECONCILIATION_ERROR',
  'MANUAL_PORTFOLIO_ENTRY',
] as const;

export type UserExecutionEventType = (typeof USER_EXECUTION_EVENT_TYPES)[number];
export type UserExecutionSource = 'BROKER_EXECUTION' | 'PAPER_EXECUTION' | 'MANUAL_PORTFOLIO_ENTRY';
export type UserExecutionMethod = 'USER_APPROVED' | 'AUTO_POLICY';

export type UserExecutionEvent = {
  id: string;
  sourceEventId: string;
  userId: string;
  brokerConnectionRef: TradingExchange | null;
  orderPlanId: string | null;
  executionId: string | null;
  type: UserExecutionEventType;
  source: UserExecutionSource;
  executionMethod: UserExecutionMethod | null;
  symbol: string;
  market: string;
  side: TradingSide | null;
  quantity: number | null;
  price: number | null;
  maskedAccount: string | null;
  strategy: string | null;
  remainingQuantity: number | null;
  realizedPnl: number | null;
  averageEntryPrice: number | null;
  averageExitPrice: number | null;
  occurredAt: string;
  metadata: Record<string, unknown>;
};

export type TelegramConnectionStatus = 'ACTIVE' | 'REVOKED';
export type UserTelegramConnection = {
  userId: string; telegramChatId: string; telegramUserId: string; status: TelegramConnectionStatus;
  connectedAt: string; revokedAt: string | null; updatedAt: string;
};
export type TelegramLinkTokenRecord = {
  tokenHash: string; userId: string; expiresAt: string; consumedAt: string | null; createdAt: string;
};

export const NOTIFICATION_PREFERENCE_KEYS = [
  'SIGNAL_DETECTED', 'ORDER_SUBMITTED', 'ORDER_PARTIALLY_FILLED', 'ORDER_FILLED', 'ORDER_CANCELLED', 'ORDER_REJECTED',
  'POSITION_OPENED', 'POSITION_INCREASED', 'POSITION_REDUCED', 'POSITION_CLOSED',
  'TAKE_PROFIT_FILLED', 'STOP_FILLED', 'TRAILING_EXIT', 'KILL_SWITCH', 'STALE_DATA', 'RECONCILIATION_ERROR',
  'MANUAL_PORTFOLIO_ENTRY',
] as const;
export type NotificationPreferenceKey = (typeof NOTIFICATION_PREFERENCE_KEYS)[number];
export type NotificationPreferences = Record<NotificationPreferenceKey, boolean>;
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = Object.freeze({
  SIGNAL_DETECTED: true,
  ORDER_SUBMITTED: true, ORDER_PARTIALLY_FILLED: true, ORDER_FILLED: true, ORDER_CANCELLED: true, ORDER_REJECTED: true,
  POSITION_OPENED: true, POSITION_INCREASED: true, POSITION_REDUCED: true, POSITION_CLOSED: true,
  TAKE_PROFIT_FILLED: true, STOP_FILLED: true, TRAILING_EXIT: true,
  KILL_SWITCH: true, STALE_DATA: true, RECONCILIATION_ERROR: true,
  MANUAL_PORTFOLIO_ENTRY: true,
});

export type NotificationDeliveryState = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'RETRY_SCHEDULED' | 'DEAD_LETTER';
export type NotificationDelivery = {
  id: string; userId: string; eventId: string; dedupeKey: string; state: NotificationDeliveryState;
  attempts: number; nextRetryAt: string | null; lastErrorCode: string | null; createdAt: string; updatedAt: string;
};
export interface PortfolioSyncSink { accept(event: UserExecutionEvent): Promise<void>; }
export type TelegramTransportResult = { ok: boolean; errorCode?: string | null };
export interface TelegramTransport { send(chatId: string, text: string): Promise<TelegramTransportResult>; }
