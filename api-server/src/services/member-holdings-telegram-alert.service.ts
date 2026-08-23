import {
  deliverPersonalTelegramAlert,
  type PersonalTelegramAlertDependencies,
  type PersonalTelegramAlertDispatchResult,
} from './personal-telegram-alert.service';
import {
  normalizeTelegramHttpUrl,
  type TelegramAlertInput,
  type TelegramUrlButton,
} from './telegram-notification.service';
import type {
  TelegramPolicyEvent,
  TelegramPolicyMarket,
  TelegramPolicyPriority,
} from './telegram-alert-policy.service';

export const MEMBER_HOLDING_ASSET_CLASSES = [
  'stock',
  'coin_spot',
  'coin_futures',
] as const;

export type MemberHoldingAssetClass = (typeof MEMBER_HOLDING_ASSET_CLASSES)[number];

export type MemberHoldingNewsEvidence = {
  kind: 'NEWS' | 'DISCLOSURE';
  title: string;
  source?: string | null;
  url?: string | null;
  publishedAt?: string | null;
};

export type MemberHoldingTradePlanEvidence = {
  entryPrices?: readonly number[] | null;
  targetPrices?: readonly number[] | null;
  stopLoss?: number | null;
};

export type MemberHoldingTelegramEvidence = {
  userId: string;
  eventId: string;
  assetClass: MemberHoldingAssetClass;
  market: string;
  symbol: string;
  name?: string | null;
  occurredAt: string;
  currentPrice?: number | null;
  averageEntryPrice?: number | null;
  changePercent?: number | null;
  aiAnalysis?: string | null;
  tradePlan?: MemberHoldingTradePlanEvidence | null;
  news?: readonly MemberHoldingNewsEvidence[] | null;
  warnings?: readonly string[] | null;
};

export type MemberHoldingTelegramDispatch = {
  event: TelegramPolicyEvent;
  alert: TelegramAlertInput;
};

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').slice(0, maxLength);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatNumber(value: number | null): string {
  if (value == null) return 'N/A';
  return value.toLocaleString('ko-KR', { maximumFractionDigits: 8 });
}

function formatPercent(value: number | null): string {
  if (value == null) return 'N/A';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function marketFor(input: MemberHoldingTelegramEvidence): TelegramPolicyMarket {
  if (input.assetClass === 'coin_spot') return 'CRYPTO_SPOT';
  if (input.assetClass === 'coin_futures') return 'CRYPTO_FUTURES';
  return input.market.trim().toUpperCase().includes('US') ? 'US' : 'KR';
}

function priorityFor(input: MemberHoldingTelegramEvidence): TelegramPolicyPriority {
  const change = finite(input.changePercent);
  const absoluteChange = change == null ? 0 : Math.abs(change);
  if (absoluteChange >= 8) return 'CRITICAL';
  if (absoluteChange >= 3 || (input.news?.length ?? 0) > 0 || (input.warnings?.length ?? 0) > 0) {
    return 'IMPORTANT';
  }
  return 'INFO';
}

function headerFor(assetClass: MemberHoldingAssetClass): string {
  return assetClass === 'stock' ? '📈 보유종목(주식)' : '₿ 보유종목(코인)';
}

function priceList(values: readonly number[] | null | undefined): string {
  if (!Array.isArray(values)) return 'N/A';
  const valid = values.filter((value) => Number.isFinite(value)).slice(0, 3);
  if (!valid.length) return 'N/A';
  return valid.map((value, index) => `${index + 1}차 ${formatNumber(value)}`).join(' · ');
}

function sanitizedNews(items: readonly MemberHoldingNewsEvidence[] | null | undefined): MemberHoldingNewsEvidence[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item): MemberHoldingNewsEvidence[] => {
    const title = cleanText(item?.title, 180);
    if (!title) return [];
    return [{
      kind: item.kind === 'DISCLOSURE' ? 'DISCLOSURE' : 'NEWS',
      title,
      source: cleanText(item.source, 80) || null,
      url: normalizeTelegramHttpUrl(item.url),
      publishedAt: cleanText(item.publishedAt, 40) || null,
    }];
  }).slice(0, 5);
}

function safeWarnings(values: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => cleanText(value, 120)).filter(Boolean).slice(0, 6);
}

function validate(input: MemberHoldingTelegramEvidence): void {
  if (!cleanText(input.userId, 128)) throw new Error('MEMBER_HOLDING_TELEGRAM_USER_REQUIRED');
  if (!cleanText(input.eventId, 160)) throw new Error('MEMBER_HOLDING_TELEGRAM_EVENT_REQUIRED');
  if (!cleanText(input.symbol, 64)) throw new Error('MEMBER_HOLDING_TELEGRAM_SYMBOL_REQUIRED');
  if (!MEMBER_HOLDING_ASSET_CLASSES.includes(input.assetClass)) {
    throw new Error('MEMBER_HOLDING_TELEGRAM_ASSET_CLASS_INVALID');
  }
  if (!Number.isFinite(Date.parse(input.occurredAt))) {
    throw new Error('MEMBER_HOLDING_TELEGRAM_TIMESTAMP_INVALID');
  }
}

export function buildMemberHoldingTelegramDispatch(
  input: MemberHoldingTelegramEvidence,
): MemberHoldingTelegramDispatch {
  validate(input);
  const userId = cleanText(input.userId, 128);
  const eventId = cleanText(input.eventId, 160);
  const symbol = cleanText(input.symbol, 64).toUpperCase();
  const name = cleanText(input.name, 100);
  const currentPrice = finite(input.currentPrice);
  const averageEntryPrice = finite(input.averageEntryPrice);
  const changePercent = finite(input.changePercent);
  const aiAnalysis = cleanText(input.aiAnalysis, 900);
  const news = sanitizedNews(input.news);
  const warnings = safeWarnings(input.warnings);
  const tradePlan = input.tradePlan ?? null;
  const stopLoss = finite(tradePlan?.stopLoss);

  const lines = [
    headerFor(input.assetClass),
    `${name ? `${name} · ` : ''}${symbol}`,
    `현재가: ${formatNumber(currentPrice)}`,
    `평단가: ${formatNumber(averageEntryPrice)}`,
    `등락률: ${formatPercent(changePercent)}`,
    '',
    `분할 매수/진입: ${priceList(tradePlan?.entryPrices)}`,
    `분할 매도/목표: ${priceList(tradePlan?.targetPrices)}`,
    `손절가: ${formatNumber(stopLoss)}`,
    `AI 분석: ${aiAnalysis || 'N/A'}`,
  ];

  if (news.length) {
    lines.push('', '[뉴스·공시]');
    news.forEach((item, index) => {
      const kind = item.kind === 'DISCLOSURE' ? '공시' : '뉴스';
      lines.push(`${index + 1}. [${kind}] ${item.source || '출처 미상'} · ${item.title}`);
    });
  } else {
    lines.push('', '[뉴스·공시] 검증된 최신 정보 N/A');
  }

  if (warnings.length) lines.push('', `위험/데이터 경고: ${warnings.join(' · ')}`);
  lines.push('', '표시되지 않은 값은 N/A이며, 없는 목표가·손절가·AI 판단을 새로 만들지 않습니다.');

  const buttons: TelegramUrlButton[][] = [];
  news.forEach((item, index) => {
    if (item.url) buttons.push([{ text: `${item.kind === 'DISCLOSURE' ? '📄 공시' : '📰 뉴스'} ${index + 1}`, url: item.url }]);
  });

  const market = marketFor(input);
  return {
    event: {
      userId,
      eventId,
      market,
      signalType: 'PRICE_TARGET',
      priority: priorityFor(input),
      symbol,
      occurredAt: input.occurredAt,
    },
    alert: {
      type: 'intelligence_report',
      symbol,
      market,
      currentPrice: currentPrice ?? undefined,
      details: lines.join('\n').slice(0, 3_500),
      timestamp: input.occurredAt,
      dedupeKey: `member-holding:${eventId}`,
      duplicateWindowMs: 24 * 60 * 60 * 1000,
      cooldownMs: 0,
      linkPreview: false,
      buttons,
    },
  };
}

export async function deliverMemberHoldingTelegramAlert(
  input: MemberHoldingTelegramEvidence,
  dependencies: PersonalTelegramAlertDependencies = {},
): Promise<PersonalTelegramAlertDispatchResult> {
  const dispatch = buildMemberHoldingTelegramDispatch(input);
  return deliverPersonalTelegramAlert({
    userId: dispatch.event.userId,
    event: dispatch.event,
    alert: dispatch.alert,
  }, dependencies);
}
