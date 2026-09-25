import { createHash } from 'node:crypto';
import type { KiwoomReadonlyCredentials, KiwoomJournalFillBatch } from './providers/kiwoom-readonly.provider';

type JournalFillReader = {
  journalFillRows(
    credentials: KiwoomReadonlyCredentials,
    orderDates: readonly string[],
    signal?: AbortSignal,
    requestCounter?: { value: number },
  ): Promise<KiwoomJournalFillBatch>;
};

export type KiwoomJournalHistoryRead = {
  payloads: Record<string, unknown>[];
  privateProviderRequests: number;
  effectiveDays: number;
  rangeCapped: boolean;
  truncated: boolean;
  normalizationFailures: number;
};

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: unknown): number | null {
  const parsed = numeric(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function domesticSymbol(value: unknown): string | null {
  const raw = String(value ?? '').trim().toUpperCase();
  const normalized = /^A\d{6}$/.test(raw) ? raw.slice(1) : raw;
  return /^\d{6}$/.test(normalized) ? normalized : null;
}

function usSymbol(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(normalized) ? normalized : null;
}

function tradeSide(code: unknown, label?: unknown): 'BUY' | 'SELL' | null {
  const normalized = String(code ?? '').trim().toUpperCase();
  if (normalized === '1' || normalized === 'SELL') return 'SELL';
  if (normalized === '2' || normalized === 'BUY') return 'BUY';
  const name = String(label ?? '').trim().toUpperCase();
  if (name.includes('매도') || name.includes('SELL')) return 'SELL';
  if (name.includes('매수') || name.includes('BUY')) return 'BUY';
  return null;
}

function kstDate(endMs: number, dayOffset: number) {
  const date = new Date(endMs + KST_OFFSET_MS - dayOffset * DAY_MS);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function recentOrderDates(endMs: number, days: number) {
  return Array.from({ length: days }, (_, index) => kstDate(endMs, days - 1 - index));
}

function timeOnKstDate(orderDate: string, value: unknown): string | null {
  const compact = String(value ?? '').trim().replace(/:/g, '');
  if (!/^\d{6}$/.test(compact) || !/^\d{8}$/.test(orderDate)) return null;
  const hour = Number(compact.slice(0, 2));
  const minute = Number(compact.slice(2, 4));
  const second = Number(compact.slice(4, 6));
  if (hour > 23 || minute > 59 || second > 59) return null;
  const iso = `${orderDate.slice(0, 4)}-${orderDate.slice(4, 6)}-${orderDate.slice(6, 8)}T${compact.slice(0, 2)}:${compact.slice(2, 4)}:${compact.slice(4, 6)}+09:00`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

function maskedReference(userId: string) {
  const digest = createHash('sha256').update(`kiwoom:${userId}`).digest('hex').slice(0, 10);
  return `KIWOOM-****-${digest}`;
}

function domesticPayload(
  orderDate: string,
  row: Record<string, unknown>,
  userId: string,
): Record<string, unknown> | null {
  const orderId = text(row.ord_no);
  const fillId = text(row.cntr_no);
  const symbol = domesticSymbol(row.stk_cd);
  const side = tradeSide(row.trde_tp, row.io_tp_nm);
  const quantity = positive(row.cntr_qty);
  const price = positive(row.cntr_uv);
  const filledAt = timeOnKstDate(orderDate, row.cntr_tm);
  if (!orderId || !fillId || !symbol || !side || quantity == null || price == null || !filledAt) return null;

  return {
    schemaVersion: 1,
    recordType: 'unified_trade_order',
    source: 'KIWOOM_API',
    broker: 'KIWOOM',
    accountIdMasked: maskedReference(userId),
    market: 'KR_STOCK',
    symbol,
    side,
    positionSide: 'LONG',
    positionEffect: side === 'BUY' ? 'OPEN' : 'CLOSE',
    clientOrderId: null,
    brokerOrderId: `${orderId}:${fillId}`,
    fillId,
    orderedAt: filledAt,
    filledAt,
    observedAt: filledAt,
    quantity,
    filledQuantity: quantity,
    remainingQuantity: 0,
    averageFillPrice: price,
    fees: null,
    tax: null,
    currency: 'KRW',
    status: 'FILLED',
    strategy: null,
    timeframe: null,
    stopLossPrice: null,
    targetPrice: null,
    ruleViolation: false,
    warnings: [
      'KIWOOM_KR_FILL_ID_FROM_KT00009',
      'KIWOOM_ORDER_TIME_NOT_AVAILABLE_FILLED_AT_USED',
      'KIWOOM_PROVIDER_TIMEZONE_ASSUMED_KST_NOT_OFFICIALLY_DOCUMENTED',
      'KIWOOM_TRANSACTION_COST_EVIDENCE_NOT_AVAILABLE',
      'REAL_ACCOUNT_HISTORY_NOT_PERSISTED',
    ],
  };
}

function usPayload(
  orderDate: string,
  row: Record<string, unknown>,
  userId: string,
): Record<string, unknown> | null {
  const orderId = text(row.ord_no);
  const symbol = usSymbol(row.stk_cd);
  const side = tradeSide(row.frgn_trde_tp, row.slby_tp_nm);
  const quantity = positive(row.cntr_qty);
  const price = positive(row.cntr_uv);
  const filledAt = timeOnKstDate(orderDate, row.cntr_time);
  const orderedAt = timeOnKstDate(orderDate, row.ord_time) ?? filledAt;
  const currency = String(row.crnc_code ?? '').trim().toUpperCase();
  if (!orderId || !symbol || !side || quantity == null || price == null || !filledAt || currency !== 'USD') return null;

  const syntheticFill = createHash('sha256')
    .update([orderDate, orderId, String(row.cntr_time ?? ''), symbol, String(quantity), String(price)].join('|'))
    .digest('hex')
    .slice(0, 16);

  return {
    schemaVersion: 1,
    recordType: 'unified_trade_order',
    source: 'KIWOOM_API',
    broker: 'KIWOOM',
    accountIdMasked: maskedReference(userId),
    market: 'US_STOCK',
    symbol,
    side,
    positionSide: 'LONG',
    positionEffect: side === 'BUY' ? 'OPEN' : 'CLOSE',
    clientOrderId: null,
    brokerOrderId: `${orderId}:${syntheticFill}`,
    fillId: null,
    orderedAt,
    filledAt,
    observedAt: filledAt,
    quantity,
    filledQuantity: quantity,
    remainingQuantity: 0,
    averageFillPrice: price,
    fees: null,
    tax: null,
    currency: 'USD',
    status: 'FILLED',
    strategy: null,
    timeframe: null,
    stopLossPrice: null,
    targetPrice: null,
    ruleViolation: false,
    warnings: [
      'KIWOOM_US_FILL_ID_NOT_PROVIDED_SYNTHETIC_ID',
      ...(orderedAt === filledAt ? ['KIWOOM_US_ORDER_TIME_NOT_AVAILABLE_FILLED_AT_USED'] : []),
      'KIWOOM_PROVIDER_TIMEZONE_ASSUMED_KST_NOT_OFFICIALLY_DOCUMENTED',
      'KIWOOM_TRANSACTION_COST_EVIDENCE_NOT_AVAILABLE',
      'REAL_ACCOUNT_HISTORY_NOT_PERSISTED',
    ],
  };
}

export async function readKiwoomJournalHistory(input: {
  provider: JournalFillReader;
  credentials: KiwoomReadonlyCredentials;
  userId: string;
  requestedDays: number;
  endMs: number;
  signal?: AbortSignal;
  maxDays?: number;
  requestCounter?: { value: number };
}): Promise<KiwoomJournalHistoryRead> {
  const maxDays = Math.max(1, Math.min(7, Math.trunc(input.maxDays ?? 7)));
  const effectiveDays = Math.max(1, Math.min(input.requestedDays, maxDays));
  const rangeCapped = input.requestedDays > effectiveDays;
  const batch = await input.provider.journalFillRows(
    input.credentials,
    recentOrderDates(input.endMs, effectiveDays),
    input.signal,
    input.requestCounter,
  );

  const payloads: Record<string, unknown>[] = [];
  const identities = new Set<string>();
  let normalizationFailures = 0;

  for (const item of batch.domestic) {
    const payload = domesticPayload(item.orderDate, item.row, input.userId);
    const identity = payload ? String(payload.brokerOrderId ?? '') : '';
    if (!payload || !identity || identities.has(identity)) {
      normalizationFailures += 1;
      continue;
    }
    identities.add(identity);
    payloads.push(payload);
  }

  for (const item of batch.us) {
    const payload = usPayload(item.orderDate, item.row, input.userId);
    const identity = payload ? String(payload.brokerOrderId ?? '') : '';
    if (!payload || !identity || identities.has(identity)) {
      normalizationFailures += 1;
      continue;
    }
    identities.add(identity);
    payloads.push(payload);
  }

  return {
    payloads,
    privateProviderRequests: batch.privateProviderRequests,
    effectiveDays,
    rangeCapped,
    truncated: rangeCapped || normalizationFailures > 0,
    normalizationFailures,
  };
}
