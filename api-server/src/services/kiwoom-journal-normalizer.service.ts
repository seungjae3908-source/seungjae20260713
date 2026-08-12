import { maskBrokerAccountReference, type UnifiedTradeOrder } from './unified-trade-journal.service';
import type { BrokerJournalNormalizationIssue, BrokerJournalNormalizationResult } from './broker-journal-normalizer.service';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function rows(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(record(item))) : [];
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function number(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegative(value: unknown) {
  const parsed = number(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function success(payload: JsonRecord) {
  const raw = payload.return_code;
  if (raw == null || raw === '') return true;
  return Number(raw) === 0;
}

function side(value: unknown): 'BUY' | 'SELL' | null {
  const parsed = String(value ?? '').trim().toLowerCase();
  if (!parsed) return null;
  if (parsed.includes('매수') || parsed === '2' || parsed === 'buy') return 'BUY';
  if (parsed.includes('매도') || parsed === '1' || parsed === 'sell') return 'SELL';
  return null;
}

function kstParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function fillTime(date: Date, value: unknown) {
  const raw = String(value ?? '').replace(/[^0-9]/g, '');
  if (raw.length < 6) return date.toISOString();
  const hh = Number(raw.slice(0, 2));
  const mm = Number(raw.slice(2, 4));
  const ss = Number(raw.slice(4, 6));
  if (hh > 23 || mm > 59 || ss > 59) return date.toISOString();
  const parts = kstParts(date);
  const utc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hh - 9, mm, ss);
  return new Date(utc).toISOString();
}

function snapshot(executionKey: string): UnifiedTradeOrder['technicalSnapshot'] {
  return Object.freeze({
    snapshotId: `no-context:KIWOOM:${executionKey}`,
    contextSource: 'NO_PRE_TRADE_CONTEXT' as const,
    capturedAt: null,
    timeframe: null,
    price: null,
    rsi: null,
    macd: null,
    macdSignal: null,
    movingAverageFast: null,
    movingAverageSlow: null,
    support: null,
    resistance: null,
    volumeRatio: null,
    volatilityPercent: null,
    signalScore: null,
    marketRegime: null,
    marketStructure: null,
    signalReasons: Object.freeze([] as string[]),
  });
}

function issue(code: string, reference: string | null): BrokerJournalNormalizationIssue {
  return { provider: 'KIWOOM', code, reference };
}

export function normalizeKiwoomDomesticFills(
  payload: unknown,
  accountReference: string,
  queryDate = new Date(),
  observedAt = new Date().toISOString(),
): BrokerJournalNormalizationResult {
  const body = record(payload);
  if (!body || !success(body)) return { records: [], issues: [issue('KIWOOM_DOMESTIC_FILL_RESPONSE_INVALID', null)] };
  const records: UnifiedTradeOrder[] = [];
  const issues: BrokerJournalNormalizationIssue[] = [];
  for (const row of rows(body.cntr)) {
    const orderId = text(row.ord_no);
    const symbol = text(row.stk_cd)?.replace(/^A(?=\d{6}$)/, '').toUpperCase() ?? null;
    const direction = side(row.io_tp_nm);
    const filledQuantity = nonNegative(row.cntr_qty);
    const price = nonNegative(row.cntr_pric);
    if (!orderId || !symbol || !direction || filledQuantity == null || filledQuantity <= 0 || price == null || price <= 0) {
      issues.push(issue('KIWOOM_DOMESTIC_FILL_CONTRACT_INVALID', orderId));
      continue;
    }
    const remaining = nonNegative(row.oso_qty) ?? 0;
    const quantity = nonNegative(row.ord_qty) ?? filledQuantity + remaining;
    const filledAt = fillTime(queryDate, row.tm ?? row.ord_tm);
    const providerFillId = text(row.cntr_no);
    const executionKey = providerFillId
      ? `KIWOOM:${orderId}:${providerFillId}`
      : `KIWOOM:${orderId}:${filledAt}:${filledQuantity}:${price}`;
    records.push({
      schemaVersion: 1,
      recordType: 'unified_trade_order',
      source: 'KIWOOM_API',
      broker: 'KIWOOM',
      accountIdMasked: maskBrokerAccountReference('KIWOOM', accountReference),
      market: 'KR_STOCK',
      symbol,
      side: direction,
      positionSide: 'LONG',
      positionEffect: direction === 'BUY' ? 'OPEN' : 'CLOSE',
      clientOrderId: null,
      brokerOrderId: orderId,
      fillId: providerFillId,
      executionKey,
      idempotencyBasis: providerFillId ? 'broker-fill-id' : 'aggregate-cumulative',
      orderedAt: fillTime(queryDate, row.ord_tm ?? row.tm),
      filledAt,
      observedAt,
      quantity,
      filledQuantity,
      remainingQuantity: remaining,
      averageFillPrice: price,
      fees: Math.abs(number(row.tdy_trde_cmsn) ?? 0),
      tax: Math.abs(number(row.tdy_trde_tax) ?? 0),
      currency: 'KRW',
      status: remaining > 0 ? 'PARTIALLY_FILLED' : 'FILLED',
      strategy: null,
      timeframe: null,
      stopLossPrice: null,
      targetPrice: null,
      ruleViolation: false,
      warnings: providerFillId ? [] : ['KIWOOM_FILL_ID_SYNTHESIZED_FROM_PROVIDER_FIELDS'],
      technicalSnapshot: snapshot(executionKey),
    });
  }
  return { records, issues };
}

export function normalizeKiwoomUsDailyFills(
  payload: unknown,
  accountReference: string,
  queryDate = new Date(),
  observedAt = new Date().toISOString(),
): BrokerJournalNormalizationResult {
  const body = record(payload);
  if (!body || !success(body)) return { records: [], issues: [issue('KIWOOM_US_FILL_RESPONSE_INVALID', null)] };
  const records: UnifiedTradeOrder[] = [];
  const issues: BrokerJournalNormalizationIssue[] = [];
  for (const row of rows(body.result_list)) {
    const orderId = text(row.ord_no);
    const symbol = text(row.stk_cd)?.toUpperCase() ?? null;
    const direction = side(row.slby_tp_nm ?? row.frgn_trde_tp);
    const filledQuantity = nonNegative(row.cntr_qty);
    const price = nonNegative(row.cntr_uv);
    const currencyRaw = text(row.crnc_code)?.toUpperCase();
    const currency = currencyRaw === 'USD' || currencyRaw === '840' ? 'USD' as const : null;
    if (!orderId || !symbol || !direction || filledQuantity == null || filledQuantity <= 0 || price == null || price <= 0 || !currency) {
      issues.push(issue('KIWOOM_US_FILL_CONTRACT_INVALID', orderId));
      continue;
    }
    const remaining = nonNegative(row.ord_remnq) ?? 0;
    const quantity = nonNegative(row.ord_qty) ?? filledQuantity + remaining;
    const filledAt = fillTime(queryDate, row.cntr_time ?? row.ord_time);
    const executionKey = `KIWOOM-US:${orderId}:${filledAt}:${filledQuantity}:${price}`;
    records.push({
      schemaVersion: 1,
      recordType: 'unified_trade_order',
      source: 'KIWOOM_API',
      broker: 'KIWOOM',
      accountIdMasked: maskBrokerAccountReference('KIWOOM', accountReference),
      market: 'US_STOCK',
      symbol,
      side: direction,
      positionSide: 'LONG',
      positionEffect: direction === 'BUY' ? 'OPEN' : 'CLOSE',
      clientOrderId: null,
      brokerOrderId: orderId,
      fillId: null,
      executionKey,
      idempotencyBasis: 'aggregate-cumulative',
      orderedAt: fillTime(queryDate, row.ord_time),
      filledAt,
      observedAt,
      quantity,
      filledQuantity,
      remainingQuantity: remaining,
      averageFillPrice: price,
      fees: 0,
      tax: 0,
      currency,
      status: remaining > 0 ? 'PARTIALLY_FILLED' : 'FILLED',
      strategy: null,
      timeframe: null,
      stopLossPrice: null,
      targetPrice: null,
      ruleViolation: false,
      warnings: ['KIWOOM_US_DAILY_FILL_HAS_NO_PROVIDER_FILL_ID'],
      technicalSnapshot: snapshot(executionKey),
    });
  }
  return { records, issues };
}
