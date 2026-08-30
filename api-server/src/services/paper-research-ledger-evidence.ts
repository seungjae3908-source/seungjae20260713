import { validPaperTimestamp } from '../../../packages/api-zod/src/paper-state-evidence.js';
import type { PaperResearchCurrencyLedger } from './paper-research-currency-ledger.service';

export const PAPER_RESEARCH_PERSISTED_LEDGER_ID = 'paper-research-currency-ledger-v1' as const;
export const PAPER_RESEARCH_PERSISTED_LEDGER_SCHEMA = 'paper-research-persisted-ledger-v1' as const;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const currency: Record<string, string> = { CASH: 'KRW', KR_STOCK: 'KRW', US_STOCK: 'USD', CRYPTO_SPOT: 'KRW', CRYPTO_FUTURES: 'USDT' };
const disabled = ['persistentLedgerIntegrated', 'signalToPaperIntegrated', 'schedulerIntegrated', 'autoPaperAllowed', 'liveOrderAllowed', 'privateTradingApiAllowed', 'orderSubmitted', 'profitabilityClaimAllowed'];

// Validate the persisted calculation, never reconstruct missing amounts or evidence clocks.
export function validResearchCurrencyLedger(value: unknown, latest: number): value is PaperResearchCurrencyLedger {
  if (!object(value) || value.schemaVersion !== 'paper-research-currency-ledger-v1' || !['READY', 'PARTIAL'].includes(String(value.status))
    || value.initialCapitalKrw !== 1_000_000 || value.baseCurrency !== 'KRW' || value.simulatedOnly !== true
    || value.currencyAwareLedgerIntegrated !== true || disabled.some((key) => value[key] !== false)
    || !Array.isArray(value.blockers) || !value.blockers.every(text) || value.status === 'READY' && value.blockers.length !== 0
    || !Array.isArray(value.components) || value.components.length === 0 || value.components.length > 10000) return false;
  const ids = new Set<string>();
  let known = 0;
  let knownCount = 0;
  for (const row of value.components) {
    if (!object(row) || !text(row.id) || ids.has(row.id) || !text(row.bucket) || !Object.hasOwn(currency, row.bucket)
      || row.quoteCurrency !== currency[row.bucket] || !nonnegative(row.nativeAmount)
      || !finite(row.observedAtMs) || row.observedAtMs <= 0 || row.observedAtMs > latest
      || !['source', 'provenance', 'version'].every((key) => text(row[key]))
      || !['LIVE', 'DELAYED', 'STALE', 'PARTIAL', 'UNAVAILABLE'].includes(String(row.quality))) return false;
    ids.add(row.id);
    if (row.fxRate !== null && (!finite(row.fxRate) || row.fxRate <= 0)) return false;
    if (row.fxObservedAtMs !== null && (!finite(row.fxObservedAtMs) || row.fxObservedAtMs <= 0 || row.fxObservedAtMs > latest)) return false;
    if (!['fxSource', 'fxProvenance', 'fxVersion'].every((key) => row[key] === null || text(row[key]))) return false;
    if (row.normalizationStatus === 'FX_UNAVAILABLE') {
      if (row.normalizedKrwAmount !== null || value.status === 'READY') return false;
      continue;
    }
    if (row.normalizationStatus !== 'READY' || !nonnegative(row.normalizedKrwAmount) || !finite(row.fxRate) || row.fxRate <= 0
      || !['fxSource', 'fxProvenance', 'fxVersion'].every((key) => text(row[key])) || !finite(row.fxObservedAtMs)
      || row.quoteCurrency === 'KRW' && row.fxRate !== 1
      || ['STALE', 'UNAVAILABLE'].includes(String(row.quality))) return false;
    const converted = row.nativeAmount * row.fxRate;
    if (!Number.isFinite(converted) || row.normalizedKrwAmount !== converted) return false;
    known += converted;
    knownCount += 1;
  }
  if (!Number.isFinite(known)) return false;
  return value.knownEquityKrw === (knownCount ? known : null)
    && value.totalEquityKrw === (value.status === 'READY' ? known : null);
}

export function validResearchLedgerPayload(value: unknown, latest: number): boolean {
  return object(value) && value.schemaVersion === PAPER_RESEARCH_PERSISTED_LEDGER_SCHEMA && value.adapterVersion === 'v1'
    && validPaperTimestamp(value.persistedAt, latest) && validResearchCurrencyLedger(value.ledger, Date.parse(String(value.persistedAt)))
    && value.simulatedOnly === true
    && ['liveOrderAllowed', 'privateTradingApiAllowed', 'orderSubmitted', 'exchangeRequestSent', 'profitabilityClaimAllowed'].every((key) => value[key] === false);
}
