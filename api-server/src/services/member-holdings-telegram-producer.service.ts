import { hasCapability } from '../../../packages/member-access/src/index.js';
import { getSupabase, hasSupabaseServerKey } from '../lib/supabase';
import { MarketDataService } from './market-data.service';
import {
  deliverMemberHoldingTelegramAlert,
  type MemberHoldingTelegramEvidence,
} from './member-holdings-telegram-alert.service';
import type { PersonalTelegramAlertDispatchResult } from './personal-telegram-alert.service';
import type { ScannerAlertCandidate } from './scanner-signal.types';

export const MEMBER_HOLDINGS_TELEGRAM_PRODUCER_ENV = 'MEMBER_HOLDINGS_TELEGRAM_PRODUCER_ENABLED';

const MAX_PROFILE_LOOKUP_BATCH = 200;
const MAX_MEMBER_DELIVERY_CONCURRENCY = 8;

export type CanonicalStockMarket = 'KR' | 'US';

export type MemberHoldingStockHolder = {
  userId: string;
  ticker: string;
  name: string;
  market: CanonicalStockMarket;
  averageEntryPrice: number;
};

export interface MemberHoldingProducerRepository {
  listApprovedStockHolders(symbol: string, market: CanonicalStockMarket): Promise<MemberHoldingStockHolder[]>;
}

export type MemberHoldingQuote = {
  price: number;
  changePercent: number | null;
};

export type MemberHoldingQuoteReader = (symbol: string) => Promise<MemberHoldingQuote>;
export type MemberHoldingAlertDeliverer = (
  evidence: MemberHoldingTelegramEvidence,
) => Promise<PersonalTelegramAlertDispatchResult>;

export type MemberHoldingProducerStatus =
  | 'DISABLED'
  | 'UNSUPPORTED_ASSET'
  | 'UNSUPPORTED_MARKET'
  | 'NO_MATCH'
  | 'STORAGE_UNAVAILABLE'
  | 'QUOTE_UNAVAILABLE'
  | 'PROCESSED'
  | 'PARTIAL'
  | 'DELIVERY_FAILED';

export type MemberHoldingProducerSummary = {
  status: MemberHoldingProducerStatus;
  matchedCount: number;
  policyCount: number;
  skippedCount: number;
  errorCount: number;
};

export type MemberHoldingProducerDependencies = {
  enabled?: boolean;
  repository?: MemberHoldingProducerRepository;
  quoteReader?: MemberHoldingQuoteReader;
  deliver?: MemberHoldingAlertDeliverer;
  now?: () => Date;
};

type PortfolioHoldingRow = {
  user_id?: unknown;
  ticker?: unknown;
  name?: unknown;
  market?: unknown;
  quantity?: unknown;
  average_price?: unknown;
};

type ProfileRow = {
  id?: unknown;
  status?: string | null;
  membership_level?: string | null;
  is_active?: boolean | null;
  role?: string | null;
};

function emptySummary(status: MemberHoldingProducerStatus): MemberHoldingProducerSummary {
  return { status, matchedCount: 0, policyCount: 0, skippedCount: 0, errorCount: 0 };
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').slice(0, maxLength);
}

function finitePositive(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function canonicalStockMarket(value: unknown): CanonicalStockMarket | null {
  const market = cleanText(value, 16).toUpperCase();
  return market === 'KR' || market === 'US' ? market : null;
}

/**
 * Canonical #804 member-access capability is the only authorization source for
 * personal Telegram delivery. The database query may narrow candidates, but it
 * must not re-implement or widen membership truth here.
 */
export function memberHoldingProfileEligibleForPersonalTelegram(profile: ProfileRow): boolean {
  return hasCapability(profile, 'canConnectPersonalTelegram');
}

export function memberHoldingsTelegramProducerEnabled(
  value: unknown = process.env[MEMBER_HOLDINGS_TELEGRAM_PRODUCER_ENV],
): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

class SupabaseMemberHoldingProducerRepository implements MemberHoldingProducerRepository {
  async listApprovedStockHolders(symbol: string, market: CanonicalStockMarket): Promise<MemberHoldingStockHolder[]> {
    if (!hasSupabaseServerKey()) throw new Error('MEMBER_HOLDINGS_PRODUCER_STORAGE_UNAVAILABLE');
    const client = getSupabase();
    const { data, error } = await client
      .from('portfolio_holdings')
      .select('user_id,ticker,name,market,quantity,average_price')
      .eq('ticker', symbol)
      .eq('market', market);
    if (error) throw new Error('MEMBER_HOLDINGS_PRODUCER_STORAGE_UNAVAILABLE');

    const candidates = (Array.isArray(data) ? data : []).flatMap((raw): MemberHoldingStockHolder[] => {
      const row = raw as PortfolioHoldingRow;
      const userId = cleanText(row.user_id, 128);
      const ticker = cleanText(row.ticker, 64).toUpperCase();
      const name = cleanText(row.name, 100) || ticker;
      const rowMarket = canonicalStockMarket(row.market);
      const quantity = finitePositive(row.quantity);
      const averageEntryPrice = finitePositive(row.average_price);
      if (!userId || ticker !== symbol || rowMarket !== market || quantity == null || averageEntryPrice == null) return [];
      return [{ userId, ticker, name, market, averageEntryPrice }];
    });
    if (!candidates.length) return [];

    const userIds = [...new Set(candidates.map((row) => row.userId))];
    const eligible = new Set<string>();
    for (let index = 0; index < userIds.length; index += MAX_PROFILE_LOOKUP_BATCH) {
      const batch = userIds.slice(index, index + MAX_PROFILE_LOOKUP_BATCH);
      const { data: profiles, error: profileError } = await client
        .from('profiles')
        .select('id,status,membership_level,is_active,role')
        .in('id', batch)
        .eq('status', 'approved');
      if (profileError) throw new Error('MEMBER_HOLDINGS_PRODUCER_STORAGE_UNAVAILABLE');
      for (const raw of Array.isArray(profiles) ? profiles : []) {
        const row = raw as ProfileRow;
        const id = cleanText(row.id, 128);
        if (id && memberHoldingProfileEligibleForPersonalTelegram(row)) eligible.add(id);
      }
    }
    return candidates.filter((row) => eligible.has(row.userId));
  }
}

const runtimeRepository = new SupabaseMemberHoldingProducerRepository();

async function runtimeQuoteReader(symbol: string): Promise<MemberHoldingQuote> {
  const quote = await MarketDataService.getQuote(symbol);
  const price = finitePositive(quote.price);
  if (price == null) throw new Error('MEMBER_HOLDINGS_PRODUCER_QUOTE_UNAVAILABLE');
  return {
    price,
    changePercent: finiteNumber(quote.changePercent),
  };
}

function scannerEvidenceForHolder(
  alert: ScannerAlertCandidate,
  holder: MemberHoldingStockHolder,
  quote: MemberHoldingQuote,
  occurredAt: string,
): MemberHoldingTelegramEvidence {
  return {
    userId: holder.userId,
    eventId: `scanner-holding:${alert.idempotencyKey}`,
    assetClass: 'stock',
    market: holder.market,
    symbol: holder.ticker,
    name: holder.name,
    occurredAt,
    currentPrice: quote.price,
    averageEntryPrice: holder.averageEntryPrice,
    changePercent: quote.changePercent,
    triggerReasons: alert.evidence,
    tradePlan: {
      targetPrices: alert.targets,
      stopLoss: alert.stopLoss,
    },
    warnings: [
      `Scanner ${alert.state} 신호와 실제 앱 보유종목이 일치했습니다.`,
      '실제 주문/체결이 아니며 AI 판단·신뢰도·성과 근거가 없으면 N/A로 유지됩니다.',
    ],
  };
}

async function deliverInBoundedBatches(
  holders: readonly MemberHoldingStockHolder[],
  deliver: MemberHoldingAlertDeliverer,
  evidenceFor: (holder: MemberHoldingStockHolder) => MemberHoldingTelegramEvidence,
): Promise<PromiseSettledResult<PersonalTelegramAlertDispatchResult>[]> {
  const settled: PromiseSettledResult<PersonalTelegramAlertDispatchResult>[] = [];
  for (let index = 0; index < holders.length; index += MAX_MEMBER_DELIVERY_CONCURRENCY) {
    const batch = holders.slice(index, index + MAX_MEMBER_DELIVERY_CONCURRENCY);
    settled.push(...await Promise.allSettled(batch.map((holder) => deliver(evidenceFor(holder)))));
  }
  return settled;
}

export async function fanoutMemberHoldingScannerAlert(
  alert: ScannerAlertCandidate,
  dependencies: MemberHoldingProducerDependencies = {},
): Promise<MemberHoldingProducerSummary> {
  const enabled = dependencies.enabled ?? memberHoldingsTelegramProducerEnabled();
  if (!enabled) return emptySummary('DISABLED');
  if (alert.assetClass !== 'stock') return emptySummary('UNSUPPORTED_ASSET');

  const market = canonicalStockMarket(alert.market);
  if (!market) return emptySummary('UNSUPPORTED_MARKET');
  const symbol = cleanText(alert.symbol, 64).toUpperCase();
  if (!symbol) return emptySummary('UNSUPPORTED_MARKET');

  const repository = dependencies.repository ?? runtimeRepository;
  let holders: MemberHoldingStockHolder[];
  try {
    holders = await repository.listApprovedStockHolders(symbol, market);
  } catch {
    return emptySummary('STORAGE_UNAVAILABLE');
  }
  if (!holders.length) return emptySummary('NO_MATCH');

  const quoteReader = dependencies.quoteReader ?? runtimeQuoteReader;
  let quote: MemberHoldingQuote;
  try {
    quote = await quoteReader(symbol);
    if (finitePositive(quote.price) == null) throw new Error('MEMBER_HOLDINGS_PRODUCER_QUOTE_UNAVAILABLE');
  } catch {
    return { ...emptySummary('QUOTE_UNAVAILABLE'), matchedCount: holders.length };
  }

  const occurredAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const deliver = dependencies.deliver ?? deliverMemberHoldingTelegramAlert;
  const settled = await deliverInBoundedBatches(
    holders,
    deliver,
    (holder) => scannerEvidenceForHolder(alert, holder, quote, occurredAt),
  );

  let policyCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  settled.forEach((result) => {
    if (result.status === 'rejected') {
      errorCount += 1;
      return;
    }
    if (result.value.status === 'POLICY') policyCount += 1;
    else skippedCount += 1;
  });

  const status: MemberHoldingProducerStatus = errorCount === holders.length
    ? 'DELIVERY_FAILED'
    : errorCount > 0
      ? 'PARTIAL'
      : 'PROCESSED';
  return {
    status,
    matchedCount: holders.length,
    policyCount,
    skippedCount,
    errorCount,
  };
}
