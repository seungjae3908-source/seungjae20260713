export type TelegramIntelligenceReportKind =
  | 'MORNING'
  | 'KR_CLOSING'
  | 'US_PREMARKET'
  | 'WEEKLY';

export type TelegramMembership = 'pending' | 'associate' | 'regular' | 'admin';
export type TelegramReportDestination = 'STOCK_ROOM' | 'CRYPTO_ROOM' | 'PERSONAL';
export type TelegramReportPriority = 'NORMAL' | 'HIGH';

export interface TelegramIntelligenceReportPlan {
  kind: TelegramIntelligenceReportKind;
  scheduledTimezone: 'Asia/Seoul' | 'America/New_York';
  localDate: string;
  localMinuteOfDay: number;
  dedupeKey: string;
  destinations: TelegramReportDestination[];
  priority: TelegramReportPriority;
  liveTradingAuthority: false;
  orderSubmitted: false;
  privateTradingApiCount: 0;
}

export interface TelegramReportAudienceInput {
  membership: TelegramMembership;
  portfolioRelevant?: boolean;
  watchlistRelevant?: boolean;
  includeStocks?: boolean;
  includeCrypto?: boolean;
}

type LocalClock = {
  date: string;
  weekday: string;
  hour: number;
  minute: number;
};

const KST = 'Asia/Seoul' as const;
const NEW_YORK = 'America/New_York' as const;

function localClock(now: Date, timeZone: string): LocalClock {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('TELEGRAM_INTELLIGENCE_INVALID_DATE');
  }
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error('TELEGRAM_INTELLIGENCE_TIMEZONE_FORMAT_FAILED');
  }
  return { date, weekday: String(parts.weekday ?? ''), hour, minute };
}

function minuteOfDay(clock: LocalClock): number {
  return clock.hour * 60 + clock.minute;
}

function within(clock: LocalClock, startHour: number, startMinute: number, endHour: number, endMinute: number): boolean {
  const current = minuteOfDay(clock);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return current >= start && current <= end;
}

export function telegramReportDestinations(input: TelegramReportAudienceInput): TelegramReportDestination[] {
  if (input.membership === 'pending') return [];

  const destinations: TelegramReportDestination[] = [];
  if (input.includeStocks !== false && ['associate', 'regular', 'admin'].includes(input.membership)) {
    destinations.push('STOCK_ROOM');
  }
  if (input.includeCrypto !== false && ['regular', 'admin'].includes(input.membership)) {
    destinations.push('CRYPTO_ROOM');
  }
  if (input.portfolioRelevant || input.watchlistRelevant) destinations.push('PERSONAL');
  return destinations;
}

export function telegramPersonalRelevancePriority(input: Pick<TelegramReportAudienceInput, 'portfolioRelevant' | 'watchlistRelevant'>): TelegramReportPriority {
  return input.portfolioRelevant ? 'HIGH' : 'NORMAL';
}

function reportPlan(
  kind: TelegramIntelligenceReportKind,
  scheduledTimezone: 'Asia/Seoul' | 'America/New_York',
  clock: LocalClock,
  audience: TelegramReportAudienceInput,
): TelegramIntelligenceReportPlan {
  const destinations = telegramReportDestinations(audience);
  return {
    kind,
    scheduledTimezone,
    localDate: clock.date,
    localMinuteOfDay: minuteOfDay(clock),
    dedupeKey: `telegram-intelligence:${kind}:${clock.date}`,
    destinations,
    priority: telegramPersonalRelevancePriority(audience),
    liveTradingAuthority: false,
    orderSubmitted: false,
    privateTradingApiCount: 0,
  };
}

export function dueTelegramIntelligenceReports(
  now: Date,
  audience: TelegramReportAudienceInput,
): TelegramIntelligenceReportPlan[] {
  const kst = localClock(now, KST);
  const newYork = localClock(now, NEW_YORK);
  const due: TelegramIntelligenceReportPlan[] = [];

  // Morning report: around 08:00 KST, bounded to a 20-minute window.
  if (within(kst, 7, 50, 8, 10)) {
    due.push(reportPlan('MORNING', KST, kst, audience));
  }

  // KR close report: user contract explicitly allows 15:50-16:10 KST.
  if (within(kst, 15, 50, 16, 10)) {
    due.push(reportPlan('KR_CLOSING', KST, kst, audience));
  }

  // US premarket report: 08:00 New York local time. Intl timezone conversion
  // keeps the same wall-clock target across EST/EDT without hard-coded UTC offsets.
  if (within(newYork, 7, 50, 8, 10)) {
    due.push(reportPlan('US_PREMARKET', NEW_YORK, newYork, audience));
  }

  // Weekly report: Monday around 08:00 KST.
  if (kst.weekday === 'Mon' && within(kst, 7, 50, 8, 10)) {
    due.push(reportPlan('WEEKLY', KST, kst, audience));
  }

  return due.filter((plan) => plan.destinations.length > 0);
}

export function dedupeTelegramIntelligencePlans(
  plans: readonly TelegramIntelligenceReportPlan[],
  alreadyDeliveredKeys: ReadonlySet<string>,
): TelegramIntelligenceReportPlan[] {
  const seen = new Set<string>();
  return plans.filter((plan) => {
    if (alreadyDeliveredKeys.has(plan.dedupeKey) || seen.has(plan.dedupeKey)) return false;
    seen.add(plan.dedupeKey);
    return true;
  });
}
