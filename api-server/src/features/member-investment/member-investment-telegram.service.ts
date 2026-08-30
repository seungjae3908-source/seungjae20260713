import {
  deliverPersonalTelegramAlert,
  type PersonalTelegramAlertDependencies,
  type PersonalTelegramAlertDispatchResult,
} from '../../services/personal-telegram-alert.service';
import type { TelegramAlertInput } from '../../services/telegram-notification.service';
import type { TelegramPolicyEvent } from '../../services/telegram-alert-policy.service';
import type {
  BrokerExchangeConnection,
  OrderIntent,
  RiskGateResult,
} from './member-investment.contract';

export type MemberInvestmentTelegramDispatch = (input: {
  userId: string;
  event: TelegramPolicyEvent;
  alert: TelegramAlertInput;
  now?: Date;
}) => Promise<PersonalTelegramAlertDispatchResult>;

function marketFor(intent: OrderIntent): TelegramPolicyEvent['market'] {
  if (intent.market === 'KR_STOCK') return 'KR';
  if (intent.market === 'US_STOCK') return 'US';
  return intent.market;
}

function alertType(intent: OrderIntent, blocked: boolean): TelegramAlertInput['type'] {
  if (blocked) return 'system_critical';
  if (intent.market === 'CRYPTO_FUTURES' && intent.positionSide === 'LONG') return 'crypto_futures_long';
  if (intent.market === 'CRYPTO_FUTURES' && intent.positionSide === 'SHORT') return 'crypto_futures_short';
  if (intent.market === 'CRYPTO_SPOT') return 'crypto_spot_buy';
  return intent.side === 'BUY' ? 'strong_buy' : 'price_alert';
}

function signalType(intent: OrderIntent, blocked: boolean): TelegramPolicyEvent['signalType'] {
  if (blocked) return 'NO_TRADE';
  if (intent.market === 'CRYPTO_FUTURES' && intent.positionSide === 'LONG') return 'LONG';
  if (intent.market === 'CRYPTO_FUTURES' && intent.positionSide === 'SHORT') return 'SHORT';
  return 'BUY';
}

export class MemberInvestmentTelegramService {
  constructor(
    private readonly dispatch: MemberInvestmentTelegramDispatch = (input) => deliverPersonalTelegramAlert(input),
    private readonly appBaseUrl = (process.env.APP_BASE_URL ?? 'https://localhost.invalid').replace(/\/$/, ''),
  ) {}

  async notifyIntent(input: {
    userId: string;
    intent: OrderIntent;
    connection: BrokerExchangeConnection | null;
    risk: RiskGateResult;
    now?: Date;
  }) {
    const blocked = !input.risk.allowed;
    const details = blocked
      ? `Risk Gate 차단: ${input.risk.reasons.join(', ') || 'UNKNOWN'}`
      : '실주문 권한 없이 PREVIEW_ONLY 실행 미리보기가 생성되었습니다.';
    const event: TelegramPolicyEvent = {
      userId: input.userId,
      eventId: `member-investment:${input.intent.id}:${input.risk.status}`,
      market: marketFor(input.intent),
      signalType: signalType(input.intent, blocked),
      priority: blocked ? 'CRITICAL' : 'INFO',
      symbol: input.intent.symbol,
      occurredAt: input.risk.checkedAt,
    };
    const alert: TelegramAlertInput = {
      type: alertType(input.intent, blocked),
      symbol: input.intent.symbol,
      market: input.intent.market,
      provider: input.connection?.provider,
      currentPrice: input.intent.requestedPrice,
      details,
      timestamp: input.risk.checkedAt,
      dedupeKey: event.eventId,
      buttons: [[
        { text: '상세보기', url: `${this.appBaseUrl}/account-connections/platform/intents/${encodeURIComponent(input.intent.id)}` },
        { text: '리스크 근거 보기', url: `${this.appBaseUrl}/account-connections/platform/risk/${encodeURIComponent(input.intent.id)}` },
      ], [
        { text: '자동매매 설정 보기', url: `${this.appBaseUrl}/settings/automation` },
        { text: '계좌 상태 보기', url: `${this.appBaseUrl}/account-connections` },
      ]],
    };
    return this.dispatch({ userId: input.userId, event, alert, now: input.now });
  }
}

export function createMemberInvestmentTelegramServiceForTests(
  dependencies: PersonalTelegramAlertDependencies,
  appBaseUrl = 'https://example.test',
) {
  return new MemberInvestmentTelegramService(
    (input) => deliverPersonalTelegramAlert(input, dependencies),
    appBaseUrl,
  );
}
