import { createHash } from 'node:crypto';
import type { TradingOrder, TradingPlan } from './trade-automation.types';
// These imports are the existing PUBLIC-only Bitget funding and 1m mark
// owner. No authenticated exchange requests are made in this module.
// @ts-ignore JS research package module has no TypeScript source declaration.
import { BitgetPublicClient } from '../../../market-prediction-lab/src/bitget-public-client.js';
// @ts-ignore JS research package module has no TypeScript source declaration.
import { collectBitgetFundingCostOnlyHistory } from '../../../market-prediction-lab/src/bitget-funding-cost-owner-v1.js';

export const PAPER_FUNDING_CERTIFICATE_VERSION = 'server-paper-funding-ledger-v1';
export type PaperFundingCertificate = NonNullable<TradingOrder['paperFundingSettlementEvidence']>;
type CostItem = Readonly<{
  asOfMs: number; amount: number; receiptCreditExcluded: number;
  markPrice: number; positionValue: number; fundingRate: number;
  payer: boolean; source: string;
}>;
export type CompletePublicFundingHistory = Readonly<{
  schemaVersion: string; status: string; complete: boolean;
  fullCoverage: boolean; symbol: string; direction: string;
  quantity: number; startTime: number; endTime: number;
  collectedAtMs: number; fundingEventCount: number;
  payments: readonly CostItem[];
  totalFundingCost: number; excludedFundingCredit: number;
  publicOnly: boolean; executionAuthority: string;
}>;
export type EventHistoricalFx = Readonly<{
  atMs: number; source: 'UPBIT:KRW-USDT_HISTORICAL_1M';
  krwPerUsdt: number;
}>;
export type FundingCertificateRequest = Readonly<{
  entryOrder: TradingOrder; entryPlan: TradingPlan;
  exitOrder: TradingOrder; exitPlan: TradingPlan;
  exitAtMs: number;
  nowMs?: number;
  collectHistory?: (scope: Readonly<{
    symbol: string; direction: 'LONG' | 'SHORT'; quantity: number;
    startTime: number; endTime: number;
  }>) => Promise<CompletePublicFundingHistory>;
  historicalFx?: (atMs: number) => Promise<EventHistoricalFx>;
}>;

// An untrusted serialized request cannot synthesize this authority. The
// certificate is issued in the server process by validated public collectors;
// a plain JSON object with matching keys is deliberately *not* trusted.
const issued = new WeakSet<object>();
// Public proof may need multiple bounded historical requests after simulated fill.
const MAX_FUNDING_CERTIFICATION_LAG_MS = 120_000;
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function positive(value: unknown): value is number { return finite(value) && value > 0; }
function time(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function identity(order: TradingOrder): string | null {
  return typeof order.exchangeOrderId === 'string' && order.exchangeOrderId.startsWith('paper-')
    ? order.exchangeOrderId : null;
}
export function isProtectedPaperFundingCertificate(value: unknown): value is PaperFundingCertificate {
  return value !== null && typeof value === 'object' && issued.has(value);
}

export async function readHistoricalUpbitUsdtKrwMinute(
  atMs: number,
  fetcher: typeof fetch = fetch,
): Promise<EventHistoricalFx> {
  if (!time(atMs) || atMs % 60_000 !== 0
    || Date.now() < atMs + 60_000) throw new Error('PAPER_FUNDING_HISTORICAL_FX_TIME_INVALID');
  const url = new URL('https://api.upbit.com/v1/candles/minutes/1');
  url.searchParams.set('market', 'KRW-USDT');
  url.searchParams.set('to', new Date(atMs + 60_000).toISOString());
  url.searchParams.set('count', '1');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetcher(url, {
      method: 'GET', headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('PAPER_FUNDING_HISTORICAL_FX_PROVIDER_UNAVAILABLE');
    const body: unknown = await response.json();
    const row = Array.isArray(body) && body.length === 1 ? body[0] as Record<string, unknown> : null;
    const label = typeof row?.candle_date_time_utc === 'string'
      ? Date.parse(row.candle_date_time_utc + 'Z') : Number.NaN;
    if (row?.market !== 'KRW-USDT' || label !== atMs
      || !positive(row?.opening_price) || row?.unit !== 1) {
      throw new Error('PAPER_FUNDING_HISTORICAL_FX_EXACT_MINUTE_REQUIRED');
    }
    return Object.freeze({
      atMs, source: 'UPBIT:KRW-USDT_HISTORICAL_1M' as const,
      krwPerUsdt: row.opening_price,
    });
  } finally {
    clearTimeout(timeout);
  }
}
async function publicBitgetFundingHistory(scope: {
  symbol: string; direction: 'LONG' | 'SHORT'; quantity: number;
  startTime: number; endTime: number;
}): Promise<CompletePublicFundingHistory> {
  const client = new BitgetPublicClient({
    timeoutMs: 3_000, maxRetries: 0, minIntervalMs: 125,
  });
  return collectBitgetFundingCostOnlyHistory({
    client, ...scope, now: () => Date.now(),
  }) as Promise<CompletePublicFundingHistory>;
}

export async function issueProtectedPaperFundingCertificate(
  request: FundingCertificateRequest,
): Promise<PaperFundingCertificate | null> {
  const { entryOrder, entryPlan, exitOrder, exitPlan } = request;
  const exitAtMs = request.exitAtMs;
  const nowMs = request.nowMs ?? Date.now();
  const entryAtMs = Date.parse(entryOrder.updatedAt);
  const entryId = identity(entryOrder);
  const exitId = identity(exitOrder);
  const entryDirection = entryPlan.side === 'long' ? 'LONG'
    : entryPlan.side === 'short' ? 'SHORT' : null;
  // Reject partial adds/exits, cross-owner aliases and nonreducing / LIVE
  // orders rather than deriving unverified position-lifetime funding.
  if (!entryId || !exitId || entryId === exitId || !time(exitAtMs)
    || !time(nowMs) || !Number.isFinite(entryAtMs)
    || entryAtMs >= exitAtMs || exitAtMs > nowMs
    || nowMs - exitAtMs > MAX_FUNDING_CERTIFICATION_LAG_MS
    || entryOrder.state !== 'FILLED' || exitOrder.state !== 'FILLED'
    || entryPlan.accountMode !== 'paper' || exitPlan.accountMode !== 'paper'
    || entryPlan.executionMode !== 'automatic' || exitPlan.executionMode !== 'automatic'
    || entryPlan.exchange !== 'bitget' || exitPlan.exchange !== 'bitget'
    || entryDirection === null || entryPlan.reduceOnly === true
    || exitPlan.reduceOnly !== true
    || exitPlan.side !== (entryDirection === 'LONG' ? 'short' : 'long')
    || entryOrder.userId !== exitOrder.userId
    || entryOrder.userId !== entryPlan.userId
    || exitOrder.userId !== exitPlan.userId
    || entryOrder.planId !== entryPlan.id || exitOrder.planId !== exitPlan.id
    || entryPlan.symbol !== exitPlan.symbol
    || entryPlan.strategyId !== exitPlan.strategyId
    || !positive(entryOrder.filledQuantity)
    || !positive(exitOrder.filledQuantity)
    || Math.abs(entryOrder.filledQuantity - exitOrder.filledQuantity)
      > Math.max(1e-9, entryOrder.filledQuantity * 1e-8)
    || !Array.isArray(exitPlan.signalReasons)
    || !exitPlan.signalReasons.includes('AUTO_EXIT_ENTRY_ORDER:' + entryOrder.id)
    || !exitPlan.signalReasons.includes('AUTO_EXIT_ENTRY_PLAN:' + entryPlan.id)) return null;
  const symbol = String(entryPlan.symbol).toUpperCase().replace(/[^A-Z0-9]/gu, '');
  if (!/^[A-Z0-9]{2,24}USDT$/u.test(symbol)) return null;
  const scope = Object.freeze({
    symbol, direction: entryDirection, quantity: entryOrder.filledQuantity,
    startTime: entryAtMs, endTime: exitAtMs,
  });
  const collect = request.collectHistory ?? publicBitgetFundingHistory;
  const readFx = request.historicalFx ?? readHistoricalUpbitUsdtKrwMinute;
  let history: CompletePublicFundingHistory;
  try { history = await collect(scope); }
  catch { return null; } // Missing external evidence never becomes zero.
  if (history?.schemaVersion !== 'bitget-funding-cost-only-owner-v1'
    || history.status !== 'PRESENT' || history.complete !== true
    || history.fullCoverage !== true || history.publicOnly !== true
    || history.executionAuthority !== 'NONE'
    || history.symbol !== symbol || history.direction !== entryDirection
    || history.quantity !== scope.quantity
    || history.startTime !== entryAtMs || history.endTime !== exitAtMs
    || !time(history.collectedAtMs) || history.collectedAtMs < exitAtMs
    || history.collectedAtMs > Date.now() + 5_000
    || !Array.isArray(history.payments)
    || history.payments.length > 80
    || history.fundingEventCount !== history.payments.length
    || !finite(history.totalFundingCost) || history.totalFundingCost < 0
    || !finite(history.excludedFundingCredit) || history.excludedFundingCredit < 0) return null;
  let previousTime = entryAtMs;
  let payments = 0, credits = 0, netFundingKrw = 0;
  const signedEvents: unknown[] = [];
  for (const event of history.payments) {
    if (!time(event.asOfMs) || event.asOfMs <= previousTime
      || event.asOfMs >= exitAtMs || event.asOfMs % 60_000 !== 0
      || !positive(event.markPrice) || !positive(event.positionValue)
      || !finite(event.fundingRate) || Math.abs(event.fundingRate) > 1
      || !finite(event.amount) || event.amount < 0
      || !finite(event.receiptCreditExcluded) || event.receiptCreditExcluded < 0
      || typeof event.payer !== 'boolean'
      || event.source !== 'BITGET_PUBLIC_FUNDING_RATE_X_EXACT_1M_MARK_OPEN'
      || Math.abs(event.positionValue - scope.quantity * event.markPrice) > 1e-6
      || Math.abs(event.positionValue * Math.abs(event.fundingRate)
        - event.amount - event.receiptCreditExcluded) > 1e-6
      || (event.payer && event.receiptCreditExcluded !== 0)
      || (!event.payer && event.amount !== 0)) return null;
    let fx: EventHistoricalFx;
    try { fx = await readFx(event.asOfMs); }
    catch { return null; }
    if (fx?.atMs !== event.asOfMs
      || fx.source !== 'UPBIT:KRW-USDT_HISTORICAL_1M'
      || !positive(fx.krwPerUsdt)) return null;
    previousTime = event.asOfMs;
    payments += event.amount;
    credits += event.receiptCreditExcluded;
    const signedUsdt = event.amount - event.receiptCreditExcluded;
    netFundingKrw += signedUsdt * fx.krwPerUsdt;
    if (!finite(netFundingKrw)) return null;
    signedEvents.push([event.asOfMs, event.fundingRate, event.markPrice,
      event.amount, event.receiptCreditExcluded, fx.krwPerUsdt]);
  }
  if (Math.abs(payments - history.totalFundingCost) > 1e-6
    || Math.abs(credits - history.excludedFundingCredit) > 1e-6
    || Date.now() - exitAtMs > MAX_FUNDING_CERTIFICATION_LAG_MS) return null;
  const eventDigest = createHash('sha256').update(JSON.stringify({
    version: PAPER_FUNDING_CERTIFICATE_VERSION,
    ownerId: entryOrder.userId, symbol, entryId, exitId, entryAtMs,
    exitAtMs, signedEvents,
  })).digest('hex');
  const certificate: PaperFundingCertificate = Object.freeze({
    source: 'SERVER_PAPER_FUNDING_LEDGER_V1',
    underlyingCurrency: 'USDT',
    netFundingKrw, entryBrokerOrderId: entryId,
    exitBrokerOrderId: exitId,
    coveredFromAt: new Date(entryAtMs).toISOString(),
    coveredThroughAt: new Date(exitAtMs).toISOString(),
    attestedAt: new Date(Date.now()).toISOString(),
    complete: true,
    eventCount: signedEvents.length,
    eventDigest,
  });
  issued.add(certificate);
  return certificate;
}
