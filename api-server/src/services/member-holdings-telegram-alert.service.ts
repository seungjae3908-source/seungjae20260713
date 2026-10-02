import {
  deliverPersonalTelegramAlert,
  type PersonalTelegramAlertDependencies,
  type PersonalTelegramAlertDispatchResult,
} from './personal-telegram-alert.service';
import {
  normalizeTelegramHttpUrl,
  sendTelegramAlert,
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

export const MEMBER_HOLDING_AI_VERDICTS = [
  'BUY_MORE',
  'HOLD',
  'REDUCE',
  'EXIT',
  'WATCH',
] as const;
export type MemberHoldingAiVerdict = (typeof MEMBER_HOLDING_AI_VERDICTS)[number];

export const MEMBER_HOLDING_RISK_LEVELS = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const;
export type MemberHoldingRiskLevel = (typeof MEMBER_HOLDING_RISK_LEVELS)[number];

export const MEMBER_HOLDING_PERFORMANCE_STATES = [
  'READY',
  'INSUFFICIENT_SAMPLE',
  'NOT_EVIDENCED',
] as const;
export type MemberHoldingPerformanceState = (typeof MEMBER_HOLDING_PERFORMANCE_STATES)[number];

export const MEMBER_HOLDING_NEWS_IMPACTS = [
  'POSITIVE',
  'NEGATIVE',
  'NEUTRAL',
  'MIXED',
] as const;
export type MemberHoldingNewsImpact = (typeof MEMBER_HOLDING_NEWS_IMPACTS)[number];

export type MemberHoldingNewsEvidence = {
  kind: 'NEWS' | 'DISCLOSURE';
  title: string;
  source?: string | null;
  url?: string | null;
  publishedAt?: string | null;
  impact?: MemberHoldingNewsImpact | null;
  impactReason?: string | null;
};

export type MemberHoldingTradePlanEvidence = {
  entryPrices?: readonly number[] | null;
  targetPrices?: readonly number[] | null;
  stopLoss?: number | null;
  entryRationale?: string | null;
  targetRationale?: string | null;
  stopRationale?: string | null;
};

export type MemberHoldingAiEvidence = {
  verdict?: MemberHoldingAiVerdict | null;
  summary?: string | null;
  reasons?: readonly string[] | null;
  confidencePercent?: number | null;
  confidenceSource?: string | null;
  generatedAt?: string | null;
};

export type MemberHoldingRiskEvidence = {
  level?: MemberHoldingRiskLevel | null;
  reasons?: readonly string[] | null;
};

export type MemberHoldingPerformanceEvidence = {
  state: MemberHoldingPerformanceState;
  sampleSize?: number | null;
  winRatePercent?: number | null;
  averageReturnPercent?: number | null;
  maxDrawdownPercent?: number | null;
  source?: string | null;
  observedAt?: string | null;
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
  ai?: MemberHoldingAiEvidence | null;
  risk?: MemberHoldingRiskEvidence | null;
  performance?: MemberHoldingPerformanceEvidence | null;
  tradePlan?: MemberHoldingTradePlanEvidence | null;
  news?: readonly MemberHoldingNewsEvidence[] | null;
  warnings?: readonly string[] | null;
  triggerReasons?: readonly string[] | null;
  analysisProfileLabel?: string | null;
  detailUrl?: string | null;
};

export type MemberHoldingTelegramDispatch = {
  event: TelegramPolicyEvent;
  alert: TelegramAlertInput;
};

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').slice(0, maxLength);
}

function cleanList(values: readonly string[] | null | undefined, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => cleanText(value, maxLength)).filter(Boolean).slice(0, maxItems);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boundedPercent(value: unknown): number | null {
  const number = finite(value);
  return number != null && number >= 0 && number <= 100 ? number : null;
}

function validTimestamp(value: unknown): string | null {
  const text = cleanText(value, 40);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function formatNumber(value: number | null): string {
  if (value == null) return 'N/A';
  return value.toLocaleString('ko-KR', { maximumFractionDigits: 8 });
}

function formatPercent(value: number | null): string {
  if (value == null) return 'N/A';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function positionReturnPercent(currentPrice: number | null, averageEntryPrice: number | null): number | null {
  if (currentPrice == null || averageEntryPrice == null || averageEntryPrice <= 0) return null;
  return ((currentPrice - averageEntryPrice) / averageEntryPrice) * 100;
}

function marketFor(input: MemberHoldingTelegramEvidence): TelegramPolicyMarket {
  if (input.assetClass === 'coin_spot') return 'CRYPTO_SPOT';
  if (input.assetClass === 'coin_futures') return 'CRYPTO_FUTURES';
  return input.market.trim().toUpperCase().includes('US') ? 'US' : 'KR';
}

function normalizedRiskLevel(value: unknown): MemberHoldingRiskLevel | null {
  return typeof value === 'string' && MEMBER_HOLDING_RISK_LEVELS.includes(value as MemberHoldingRiskLevel)
    ? value as MemberHoldingRiskLevel
    : null;
}

function riskLevelLabel(value: MemberHoldingRiskLevel | null): string {
  switch (value) {
    case 'LOW': return '낮음';
    case 'MEDIUM': return '보통';
    case 'HIGH': return '높음';
    case 'CRITICAL': return '매우 높음';
    default: return '확인 필요';
  }
}

function priorityFor(input: MemberHoldingTelegramEvidence): TelegramPolicyPriority {
  const riskLevel = normalizedRiskLevel(input.risk?.level);
  const change = finite(input.changePercent);
  const absoluteChange = change == null ? 0 : Math.abs(change);
  if (riskLevel === 'CRITICAL' || absoluteChange >= 8) return 'CRITICAL';
  if (
    riskLevel === 'HIGH'
    || absoluteChange >= 3
    || (input.news?.length ?? 0) > 0
    || (input.warnings?.length ?? 0) > 0
  ) {
    return 'IMPORTANT';
  }
  return 'INFO';
}

function headerFor(assetClass: MemberHoldingAssetClass, market: string): string {
  if (assetClass === 'coin_spot') return '👤 보유종목 · 코인현물';
  if (assetClass === 'coin_futures') return '👤 보유종목 · 코인선물';
  return market.trim().toUpperCase().includes('US')
    ? '👤 보유종목 · 해외주식'
    : '👤 보유종목 · 국내주식';
}

function priceList(values: readonly number[] | null | undefined): string {
  if (!Array.isArray(values)) return 'N/A';
  const valid = values.filter((value) => Number.isFinite(value)).slice(0, 3);
  if (!valid.length) return 'N/A';
  return valid.map((value, index) => `${index + 1}차 ${formatNumber(value)}`).join(' · ');
}

function normalizedImpact(value: unknown): MemberHoldingNewsImpact | null {
  return typeof value === 'string' && MEMBER_HOLDING_NEWS_IMPACTS.includes(value as MemberHoldingNewsImpact)
    ? value as MemberHoldingNewsImpact
    : null;
}

function impactLabel(value: MemberHoldingNewsImpact | null): string | null {
  switch (value) {
    case 'POSITIVE': return '긍정';
    case 'NEGATIVE': return '부정';
    case 'NEUTRAL': return '중립';
    case 'MIXED': return '혼재';
    default: return null;
  }
}

function sanitizedNews(items: readonly MemberHoldingNewsEvidence[] | null | undefined): MemberHoldingNewsEvidence[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item): MemberHoldingNewsEvidence[] => {
    const title = cleanText(item?.title, 180);
    if (!title) return [];
    const impact = normalizedImpact(item?.impact);
    return [{
      kind: item.kind === 'DISCLOSURE' ? 'DISCLOSURE' : 'NEWS',
      title,
      source: cleanText(item.source, 80) || null,
      url: normalizeTelegramHttpUrl(item.url),
      publishedAt: validTimestamp(item.publishedAt),
      impact,
      impactReason: impact ? cleanText(item.impactReason, 180) || null : null,
    }];
  }).slice(0, 5);
}

function aiVerdict(value: unknown): MemberHoldingAiVerdict | null {
  return typeof value === 'string' && MEMBER_HOLDING_AI_VERDICTS.includes(value as MemberHoldingAiVerdict)
    ? value as MemberHoldingAiVerdict
    : null;
}

function aiVerdictLabel(value: MemberHoldingAiVerdict | null): string {
  switch (value) {
    case 'BUY_MORE': return '추가매수 검토';
    case 'HOLD': return '보유 유지';
    case 'REDUCE': return '비중 축소 검토';
    case 'EXIT': return '청산/매도 검토';
    case 'WATCH': return '관찰';
    default: return 'N/A';
  }
}

function performanceState(value: unknown): MemberHoldingPerformanceState {
  return typeof value === 'string' && MEMBER_HOLDING_PERFORMANCE_STATES.includes(value as MemberHoldingPerformanceState)
    ? value as MemberHoldingPerformanceState
    : 'NOT_EVIDENCED';
}

function performanceStateLabel(value: MemberHoldingPerformanceState): string {
  switch (value) {
    case 'READY': return '검증됨';
    case 'INSUFFICIENT_SAMPLE': return '표본 부족';
    default: return '근거 없음';
  }
}

function validatedPerformance(input: MemberHoldingPerformanceEvidence | null | undefined): {
  state: MemberHoldingPerformanceState;
  sampleSize: number | null;
  winRatePercent: number | null;
  averageReturnPercent: number | null;
  maxDrawdownPercent: number | null;
  source: string | null;
  observedAt: string | null;
} {
  const requestedState = performanceState(input?.state);
  const source = cleanText(input?.source, 120) || null;
  const sampleSizeValue = finite(input?.sampleSize);
  const sampleSize = sampleSizeValue != null && Number.isInteger(sampleSizeValue) && sampleSizeValue >= 1
    ? sampleSizeValue
    : null;
  const ready = requestedState === 'READY' && source != null && sampleSize != null;
  return {
    state: ready ? 'READY' : requestedState === 'INSUFFICIENT_SAMPLE' ? 'INSUFFICIENT_SAMPLE' : 'NOT_EVIDENCED',
    sampleSize: ready ? sampleSize : null,
    winRatePercent: ready ? boundedPercent(input?.winRatePercent) : null,
    averageReturnPercent: ready ? finite(input?.averageReturnPercent) : null,
    maxDrawdownPercent: ready ? boundedPercent(input?.maxDrawdownPercent) : null,
    source: ready ? source : null,
    observedAt: ready ? validTimestamp(input?.observedAt) : null,
  };
}

function confidenceEvidence(ai: MemberHoldingAiEvidence | null | undefined): {
  percent: number;
  source: string;
  generatedAt: string | null;
} | null {
  const percent = boundedPercent(ai?.confidencePercent);
  const source = cleanText(ai?.confidenceSource, 120);
  if (percent == null || !source) return null;
  return { percent, source, generatedAt: validTimestamp(ai?.generatedAt) };
}

function safeWarnings(values: readonly string[] | null | undefined): string[] {
  return cleanList(values, 6, 120);
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
  const positionReturn = positionReturnPercent(currentPrice, averageEntryPrice);
  const aiSummary = cleanText(input.ai?.summary, 900) || cleanText(input.aiAnalysis, 900);
  const aiReasons = cleanList(input.ai?.reasons, 6, 160);
  const verdict = aiReasons.length > 0 ? aiVerdict(input.ai?.verdict) : null;
  const confidence = aiReasons.length > 0 ? confidenceEvidence(input.ai) : null;
  const riskLevel = normalizedRiskLevel(input.risk?.level);
  const riskReasons = cleanList(input.risk?.reasons, 6, 160);
  const performance = validatedPerformance(input.performance);
  const news = sanitizedNews(input.news);
  const warnings = safeWarnings(input.warnings);
  const triggerReasons = cleanList(input.triggerReasons, 6, 160);
  const analysisProfileLabel = cleanText(input.analysisProfileLabel, 80);
  const detailUrl = normalizeTelegramHttpUrl(input.detailUrl);
  const tradePlan = input.tradePlan ?? null;
  const stopLoss = finite(tradePlan?.stopLoss);
  const entryRationale = cleanText(tradePlan?.entryRationale, 240);
  const targetRationale = cleanText(tradePlan?.targetRationale, 240);
  const stopRationale = cleanText(tradePlan?.stopRationale, 240);

  const entryPrices = Array.isArray(tradePlan?.entryPrices)
    ? tradePlan.entryPrices.filter((value) => Number.isFinite(value)).slice(0, 3)
    : [];
  const targetPrices = Array.isArray(tradePlan?.targetPrices)
    ? tradePlan.targetPrices.filter((value) => Number.isFinite(value)).slice(0, 3)
    : [];
  const hasTradePlan = entryPrices.length > 0
    || targetPrices.length > 0
    || stopLoss != null
    || Boolean(entryRationale || targetRationale || stopRationale);

  const lines = [
    headerFor(input.assetClass, input.market),
    `${name ? `${name} · ` : ''}${symbol}`,
    `현재 ${formatNumber(currentPrice)} · 평단 ${formatNumber(averageEntryPrice)} · 손익 ${formatPercent(positionReturn)}`,
  ];
  if (changePercent != null) lines.push(`오늘 등락 ${formatPercent(changePercent)}`);
  if (analysisProfileLabel) lines.push(`분석 기준: ${analysisProfileLabel}`);

  if (triggerReasons.length) {
    lines.push('', '[알림 이유]');
    triggerReasons.forEach((reason) => lines.push(`• ${reason}`));
  }

  if (aiSummary || aiReasons.length) {
    lines.push('', '[AI 보유 판단]');
    lines.push(`판단: ${aiVerdictLabel(verdict)}`);
    if (aiSummary) lines.push(`요약: ${aiSummary}`);
    if (confidence) lines.push(`신뢰도: ${confidence.percent.toFixed(1)}%`);
    if (aiReasons.length) aiReasons.forEach((reason) => lines.push(`• ${reason}`));
  }

  if (hasTradePlan) {
    lines.push('', '[매매 관리]');
    if (entryPrices.length) lines.push(`분할 진입: ${priceList(entryPrices)}`);
    if (entryRationale) lines.push(`진입 근거: ${entryRationale}`);
    if (targetPrices.length) lines.push(`목표가: ${priceList(targetPrices)}`);
    if (targetRationale) lines.push(`목표가 근거: ${targetRationale}`);
    if (stopLoss != null) lines.push(`손절/무효: ${formatNumber(stopLoss)}`);
    if (stopRationale) lines.push(`손절 근거: ${stopRationale}`);
  }

  if (riskLevel || riskReasons.length) {
    lines.push('', `[위험] ${riskLevelLabel(riskLevel)}`);
    riskReasons.forEach((reason) => lines.push(`• ${reason}`));
  }

  if (performance.state !== 'NOT_EVIDENCED') {
    lines.push('', `[유사조건 성과] ${performanceStateLabel(performance.state)}`);
    if (performance.state === 'READY') {
      lines.push(`표본 N=${performance.sampleSize}`);
      if (performance.winRatePercent != null) lines.push(`승률 ${performance.winRatePercent.toFixed(2)}%`);
      if (performance.averageReturnPercent != null) lines.push(`평균수익 ${formatPercent(performance.averageReturnPercent)}`);
      if (performance.maxDrawdownPercent != null) lines.push(`최대낙폭 ${performance.maxDrawdownPercent.toFixed(2)}%`);
    }
  }

  if (news.length) {
    lines.push('', '[보유종목 뉴스·공시]');
    news.forEach((item, index) => {
      const kind = item.kind === 'DISCLOSURE' ? '공시' : '뉴스';
      const impact = impactLabel(item.impact ?? null);
      const impactText = impact ? ` · 영향 ${impact}${item.impactReason ? ` (${item.impactReason})` : ''}` : '';
      lines.push(`${index + 1}. [${kind}] ${item.source || '출처 미상'} · ${item.title}${impactText}`);
    });
  }

  if (warnings.length) lines.push('', `⚠️ ${warnings.join(' · ')}`);
  lines.push('', '※ 확인되지 않은 값은 표시하지 않습니다.');

  const buttons: TelegramUrlButton[][] = [];
  if (detailUrl) buttons.push([{ text: '📲 앱에서 상세 분석', url: detailUrl }]);
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

export function ownerHoldingsChatIdForUser(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const ownerUserId = env.TELEGRAM_OWNER_MEMBER_ID?.trim();
  const chatId = env.TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID?.trim();
  if (!ownerUserId || !chatId || ownerUserId !== userId.trim()) return null;
  return chatId;
}

export async function deliverMemberHoldingTelegramAlert(
  input: MemberHoldingTelegramEvidence,
  dependencies: PersonalTelegramAlertDependencies = {},
): Promise<PersonalTelegramAlertDispatchResult> {
  const dispatch = buildMemberHoldingTelegramDispatch(input);
  const personal = await deliverPersonalTelegramAlert({
    userId: dispatch.event.userId,
    event: dispatch.event,
    alert: dispatch.alert,
  }, dependencies);

  const ownerChatId = ownerHoldingsChatIdForUser(dispatch.event.userId);
  if (ownerChatId && !dependencies.sender) {
    try {
      await sendTelegramAlert({
        ...dispatch.alert,
        destinationChatId: ownerChatId,
        dedupeKey: `owner-holdings:${dispatch.event.eventId}`,
        duplicateWindowMs: 24 * 60 * 60 * 1000,
        cooldownMs: 0,
      });
    } catch {
      // Owner mirror is best-effort and must never affect the member delivery path.
    }
  }

  return personal;
}
