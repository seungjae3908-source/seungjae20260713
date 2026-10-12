import { createHash } from 'node:crypto';
import type { TradingOrder, TradingPlan } from './trade-automation.types';
import type { StoredPaperJournalRecord } from './paper-journal.types';
import { adminPaperMarketFromPlan, ADMIN_FOUR_PAPER_MARKETS, type AdminPaperMarket } from './admin-four-market-paper-capital.service';


/**
 * Read-only owner-scoped reconciliation of a durable APP_PAPER execution
 * mirror with the canonical trading order projection. The historical mirror
 * records a *canonical internal order ID* in brokerOrderId; the read model
 * has retained exchangeOrderId for broker lineage. Never join by fuzzy
 * symbol/time, create fill evidence, rewrite a journal or dispatch orders.
 */
export const AUTOMATIC_PAPER_JOURNAL_MIRROR_VERSION =
  'automatic-paper-journal-canonical-mirror/v1';

type Payload = Record<string, unknown>;
const object = (value: unknown): value is Payload =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 160;
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;
const equalNumber = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-6);
const isPaper = (row: Payload) =>
  row.source === 'APP_PAPER' && row.recordType === 'unified_trade_order';

function mirrorMatchesCanonical(persisted: Payload, canonical: Payload): boolean {
  // Never compare masked account strings: historical mirrors used an
  // unavailable mask while the authenticated current projection hashes
  // account ownership. Both arrays are read for exactly the same owner.
  for (const key of [
    'source', 'broker', 'market', 'symbol', 'side',
    'positionSide', 'positionEffect', 'currency',
  ]) if (persisted[key] !== canonical[key]) return false;
  if (!positive(persisted.filledQuantity) || !positive(canonical.filledQuantity)
    || persisted.filledQuantity > canonical.filledQuantity
      + Math.max(1e-8, canonical.filledQuantity * 1e-6)) return false;
  if (!positive(persisted.averageFillPrice)
    || !positive(canonical.averageFillPrice)) return false;
  if (persisted.status !== 'FILLED' && persisted.status !== 'PARTIALLY_FILLED')
    return false;
  if (persisted.status === 'FILLED') {
    if (canonical.status !== 'FILLED'
      || !equalNumber(persisted.filledQuantity, canonical.filledQuantity)
      || !equalNumber(persisted.averageFillPrice, canonical.averageFillPrice))
      return false;
  }
  // Partial fills can legitimately have a different running average price.
  return true;
}

export function reconcileCanonicalPaperJournalMirrors(
  storedPayloads: readonly Payload[],
  canonicalPayloads: readonly Payload[],
): Readonly<{
  payloads: readonly Payload[];
  audit: Readonly<{
    contract: string;
    canonicalPaperOrders: number;
    persistedMirrorsSuppressed: number;
    canonicalOrdersWithoutPersistedMirror: number;
    unmatchedPersistedPaperRows: number;
    financialMutationCount: 0;
    independentSettlementVerified: false;
    executionAuthority: 'NONE';
  }>;
}> {
  if (!Array.isArray(storedPayloads) || !Array.isArray(canonicalPayloads)
    || storedPayloads.length > 5000 || canonicalPayloads.length > 5000)
    throw new Error('PAPER_JOURNAL_MIRROR_BATCH_INVALID');
  const canonical = new Map<string, Payload>();
  for (const payload of canonicalPayloads) {
    if (!object(payload)) throw new Error('PAPER_JOURNAL_CANONICAL_PAYLOAD_INVALID');
    if (!isPaper(payload)) continue;
    const id = payload.canonicalOrderId;
    if (!nonempty(id)
      || !object(payload.canonicalLineage)
      || !Array.isArray(payload.canonicalLineage.orderIds)
      || !payload.canonicalLineage.orderIds.includes(id))
      throw new Error('PAPER_JOURNAL_CANONICAL_ORDER_REFERENCE_REQUIRED');
    if (canonical.has(id)) throw new Error('PAPER_JOURNAL_CANONICAL_ORDER_COLLISION');
    canonical.set(id, payload);
  }

  const matched = new Set<string>();
  const retained: Payload[] = [];
  let mirrorsSuppressed = 0;
  let unmatchedStored = 0;
  for (const payload of storedPayloads) {
    if (!object(payload)) throw new Error('PAPER_JOURNAL_STORED_PAYLOAD_INVALID');
    if (!isPaper(payload)) {
      retained.push(payload);
      continue;
    }
    const mirrorId = payload.brokerOrderId;
    const canonicalRow = nonempty(mirrorId) ? canonical.get(mirrorId) : undefined;
    if (!canonicalRow) {
      unmatchedStored++;
      retained.push(payload); // preserve historical source evidence
      continue;
    }
    if (!mirrorMatchesCanonical(payload, canonicalRow))
      throw new Error('PAPER_JOURNAL_MIRROR_CANONICAL_CONFLICT');
    matched.add(mirrorId as string);
    mirrorsSuppressed++;
    // Current canonical projection is authoritative; mirrored fee/tax claims
    // never contribute an additional trade, fill or compound-capital credit.
  }
  return Object.freeze({
    payloads: Object.freeze([...retained, ...canonicalPayloads]),
    audit: Object.freeze({
      contract: AUTOMATIC_PAPER_JOURNAL_MIRROR_VERSION,
      canonicalPaperOrders: canonical.size,
      persistedMirrorsSuppressed: mirrorsSuppressed,
      canonicalOrdersWithoutPersistedMirror: canonical.size - matched.size,
      unmatchedPersistedPaperRows: unmatchedStored,
      financialMutationCount: 0 as const,
      independentSettlementVerified: false as const,
      executionAuthority: 'NONE' as const,
    }),
  });
}

/**
 * Provider history may reuse order IDs across brokers and account scopes.
 * Never use brokerOrderId alone to erase a historical row, and never treat
 * a simulated APP_PAPER or shadow execution as a real brokerage fill.
 * We only suppress a second, identical, fully scoped real-order snapshot.
 */
const LIVE_HISTORY_SOURCES = new Set([
  'APP_AUTO', 'TOSS_API', 'UPBIT_API', 'BITGET_API', 'KIWOOM_API',
]);
// The current APP_AUTO order adapter hashes uppercase BROKER:userId; the
// read-only Upbit vault provider hashes lowercase provider:userId.
// Neither is a real broker account number. Upbit order UUIDs uniquely bind
// a specific execution, so the verified owner/UUID bridge can be reconciled.
// KIWOOM/TOSS order numbers can repeat across *separate brokerage accounts*;
// their per-user vault masks cannot prove which account traded. Never alias
// such account masks until account-specific provenance exists.
function verifiedOwnerAccountScope(payload: Payload, ownerId?: string): string | null {
  if (!nonempty(payload.accountIdMasked)
    || !payload.accountIdMasked.includes('****')
    || payload.accountIdMasked.includes('UNAVAILABLE')) return null;
  const broker=String(payload.broker ?? '').toUpperCase();
  const source=String(payload.source ?? '');
  const isVerifiedUpbitOrderUuid = broker==='UPBIT'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
      .test(String(payload.brokerOrderId ?? ''));
  if (nonempty(ownerId) && isVerifiedUpbitOrderUuid) {
    const prefix=broker + '-****-';
    const hash=(identity: string) =>
      createHash('sha256').update(identity).digest('hex').slice(0,10);
    const expectedApp=prefix+hash(broker+':'+ownerId);
    const expectedVault=prefix+hash(broker.toLowerCase()+':'+ownerId);
    if ((source==='APP_AUTO' && payload.accountIdMasked===expectedApp)
      || (source===broker+'_API' && payload.accountIdMasked===expectedVault)) {
      return 'VERIFIED_SINGLE_PROVIDER_OWNER_VAULT';
    }
  }
  return payload.accountIdMasked;
}
function verifiedLiveKey(payload: Payload, ownerId?: string): string | null {
  if (payload.recordType !== 'unified_trade_order'
    || !LIVE_HISTORY_SOURCES.has(String(payload.source))) return null;
  const scope=verifiedOwnerAccountScope(payload,ownerId);
  const parts=[payload.broker,payload.market,scope,payload.brokerOrderId];
  if (parts.some((value)=>!nonempty(value))) return null;
  return JSON.stringify(parts);
}
function sameKstFillDate(existing: Payload, external: Payload): boolean {
  const first=typeof existing.filledAt==='string' ? Date.parse(existing.filledAt) : NaN;
  const second=typeof external.filledAt==='string' ? Date.parse(external.filledAt) : NaN;
  if (!Number.isFinite(first)||!Number.isFinite(second)) return false;
  const kstDate=(ms: number) => new Date(ms+9*60*60_000).toISOString().slice(0,10);
  return kstDate(first)===kstDate(second);
}
function exactEconomicDuplicate(existing: Payload, external: Payload): boolean {
  for (const key of ['symbol','side','positionSide','positionEffect','currency']) {
    if (existing[key] !== external[key]) return false;
  }
  // Order IDs can be reused on a later session. Refuse silent suppression
  // unless both verified fills occurred on the same KST trading date.
  if (!sameKstFillDate(existing,external)) return false;
  if (existing.status !== external.status
    || !positive(existing.filledQuantity) || !positive(external.filledQuantity)
    || !equalNumber(existing.filledQuantity,external.filledQuantity)
    || !positive(existing.averageFillPrice) || !positive(external.averageFillPrice)
    || !equalNumber(existing.averageFillPrice,external.averageFillPrice)) return false;
  // A provider-supplied fee/tax receipt must not be hidden by an
  // incomplete or conflicting cached projection.
  for (const key of ['fees','tax']) {
    // Invalid or negative provider costs are never suppressed as duplicates:
    // preserve them for canonical normalization/integrity rejection.
    if (external[key] != null) {
      if (typeof external[key] !== 'number'
        || !Number.isFinite(external[key]) || external[key] < 0
        || typeof existing[key] !== 'number'
        || !Number.isFinite(existing[key]) || existing[key] < 0
        || !equalNumber(existing[key], external[key])) return false;
    }
  }
  return true;
}
export function reconcileScopedExternalJournalHistory(
  known: readonly Payload[], external: readonly Payload[], ownerId?: string,
): Readonly<{ payloads: readonly Payload[]; audit: Readonly<{
  contract: string;
  suppressedVerifiedDuplicateCount: number;
  retainedExternalCount: number;
  financialMutationCount: 0;
  executionAuthority: 'NONE';
}> }> {
  if (!Array.isArray(known) || !Array.isArray(external)
    || known.length > 5000 || external.length > 5000)
    throw new Error('JOURNAL_EXTERNAL_SCOPE_BATCH_INVALID');
  const knownByScope = new Map<string, Payload[]>();
  for (const payload of known) {
    if (!object(payload)) throw new Error('JOURNAL_EXTERNAL_KNOWN_PAYLOAD_INVALID');
    const key = verifiedLiveKey(payload, ownerId);
    if (!key) continue;
    const group = knownByScope.get(key) ?? [];
    group.push(payload);
    knownByScope.set(key, group);
  }
  let suppressed=0;
  const retained: Payload[]=[];
  for (const payload of external) {
    if (!object(payload)) throw new Error('JOURNAL_EXTERNAL_PAYLOAD_INVALID');
    const key=verifiedLiveKey(payload, ownerId);
    const candidates=key ? knownByScope.get(key) ?? [] : [];
    for (const previous of candidates) {
      // Same provider/account/order cannot be silently relabeled as a
      // different instrument/side. A mismatch blocks this journal read.
      if (previous.symbol !== payload.symbol || previous.side !== payload.side
        || previous.currency !== payload.currency)
        throw new Error('JOURNAL_EXTERNAL_SCOPE_IDENTITY_CONFLICT');
    }
    if (candidates.some((previous)=>exactEconomicDuplicate(previous,payload))) {
      suppressed++;
    } else retained.push(payload);
  }
  return Object.freeze({
    payloads:Object.freeze(retained),
    audit:Object.freeze({
      contract:'journal-external-scoped-dedup/v1',
      suppressedVerifiedDuplicateCount:suppressed,
      retainedExternalCount:retained.length,
      financialMutationCount:0 as const,
      executionAuthority:'NONE' as const,
    }),
  });
}


/**
 * Owner-scoped, read-only audit of historical automatic Paper execution
 * evidence. This is NOT a settlement service: neither a FILLED status, an
 * aggregate fill nor an APP_PAPER journal mirror proves net KRW profitability.
 * Never repair legacy records by rewriting quantities or assuming zero tax.
 */
export const PAPER_EXECUTION_HISTORY_AUDIT_V1 = 'automatic-paper-history-audit-v1' as const;
type PaperMarketHistoryLane = {
  paperOrders: number;
  filledOrders: number;
  partialOrders: number;
  invalidFilledOrders: number;
  aggregateOnlyFilledOrders: number;
  confirmedJournalMirrors: number;
  missingJournalMirrors: number;
  conflictingJournalMirrors: number;
  missingFullCostEvidence: number;
};
const zeroPaperLane = (): PaperMarketHistoryLane => ({
  paperOrders:0, filledOrders:0, partialOrders:0,
  invalidFilledOrders:0, aggregateOnlyFilledOrders:0,
  confirmedJournalMirrors:0, missingJournalMirrors:0,
  conflictingJournalMirrors:0, missingFullCostEvidence:0,
});
const centsMatch = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-6);

export function auditAutomaticPaperExecutionHistory(input: Readonly<{
  ownerId: string;
  plans: readonly TradingPlan[];
  orders: readonly TradingOrder[];
  storedRows: readonly StoredPaperJournalRecord[];
}>) {
  if (!input || typeof input.ownerId !== 'string' || !input.ownerId.trim()
    || !Array.isArray(input.plans) || !Array.isArray(input.orders)
    || !Array.isArray(input.storedRows)) {
    throw new Error('PAPER_HISTORY_AUDIT_INPUT_INVALID');
  }
  const plansById = new Map<string, TradingPlan>();
  for (const plan of input.plans) {
    if (plan.accountMode !== 'paper' || plan.executionMode !== 'automatic') continue;
    // A caller must pass only repository-enforced authenticated-owner data.
    // A scope mixup must not return even an aggregate view of another owner.
    if (plan.userId !== input.ownerId) throw new Error('PAPER_HISTORY_AUDIT_OWNER_MISMATCH');
    if (plansById.has(plan.id)) throw new Error('PAPER_HISTORY_AUDIT_DUPLICATE_PLAN');
    plansById.set(plan.id, plan);
  }

  const mirrorsByInternalOrderId = new Map<string, Record<string, unknown>[]>();
  for (const row of input.storedRows) {
    if (row.kind !== 'journal' || row.deletedAt !== null) continue;
    const p = row.payload;
    if (p?.source !== 'APP_PAPER' || p.recordType !== 'unified_trade_order') continue;
    if (typeof p.brokerOrderId !== 'string' || p.brokerOrderId.length > 160) continue;
    const existing = mirrorsByInternalOrderId.get(p.brokerOrderId) ?? [];
    existing.push(p);
    mirrorsByInternalOrderId.set(p.brokerOrderId, existing);
  }
  const markets = Object.fromEntries(
    ADMIN_FOUR_PAPER_MARKETS.map(market => [market,zeroPaperLane()]),
  ) as Record<AdminPaperMarket,PaperMarketHistoryLane>;
  const seenOrders = new Set<string>();
  for (const order of input.orders) {
    const plan = plansById.get(order.planId);
    if (!plan) continue;
    if (order.userId !== input.ownerId || order.userId !== plan.userId) {
      throw new Error('PAPER_HISTORY_AUDIT_ORDER_OWNER_MISMATCH');
    }
    if (seenOrders.has(order.id)) throw new Error('PAPER_HISTORY_AUDIT_DUPLICATE_ORDER');
    seenOrders.add(order.id);
    const market = adminPaperMarketFromPlan(plan);
    const lane = markets[market];
    const expectedJournalMarket = {
      domestic_stock:'KR_STOCK', us_stock:'US_STOCK',
      crypto_spot:'CRYPTO_SPOT', crypto_futures:'CRYPTO_FUTURES',
    }[market];
    lane.paperOrders += 1;
    if (order.state === 'PARTIALLY_FILLED') lane.partialOrders += 1;
    if (order.state !== 'FILLED') continue;
    lane.filledOrders += 1;
    const qty = order.filledQuantity;
    const price = order.averageFillPrice;
    if (!(typeof qty === 'number' && Number.isFinite(qty) && qty > 0)
      || !(typeof price === 'number' && Number.isFinite(price) && price > 0)) {
      // Legacy FILLED rows with zero quantity cannot be given profit credit.
      lane.invalidFilledOrders += 1;
      continue;
    }
    if (!Array.isArray(order.fills) || order.fills.length === 0) {
      // An aggregate fill can be observable, but individual fill receipts are
      // still UNKNOWN. Do not manufacture per-fill prices or time stamps.
      lane.aggregateOnlyFilledOrders += 1;
    }
    const mirrored = mirrorsByInternalOrderId.get(order.id) ?? [];
    if (mirrored.length === 0) lane.missingJournalMirrors += 1;
    else if (mirrored.length !== 1
      || mirrored[0]?.market !== expectedJournalMarket
      || mirrored[0]?.status !== 'FILLED'
      || typeof mirrored[0]?.filledQuantity !== 'number'
      || typeof mirrored[0]?.averageFillPrice !== 'number'
      || !centsMatch(mirrored[0].filledQuantity as number, qty)
      || !centsMatch(mirrored[0].averageFillPrice as number, price)) {
      lane.conflictingJournalMirrors += 1;
    } else lane.confirmedJournalMirrors += 1;

    const currency = plan.exchange === 'bitget' ? 'USDT'
      : plan.exchange === 'upbit' ? 'KRW'
        : adminPaperMarketFromPlan(plan) === 'us_stock' ? 'USD' : 'KRW';
    const fx = order.settlementFxEvidence;
    const fxObservedAt = Date.parse(fx?.observedAt ?? '');
    const feeReady = typeof order.feeAmount === 'number'
      && Number.isFinite(order.feeAmount) && order.feeAmount >= 0
      && order.feeCurrency === currency;
    const taxReady = typeof order.taxAmount === 'number'
      && Number.isFinite(order.taxAmount) && order.taxAmount >= 0
      && order.taxCurrency === currency;
    const fxReady = fx && typeof fx.krwPerQuoteCurrency === 'number'
      && Number.isFinite(fx.krwPerQuoteCurrency) && fx.krwPerQuoteCurrency > 0
      && Number.isFinite(fxObservedAt)
      && (currency !== 'KRW' || fx.krwPerQuoteCurrency === 1);
    const fundingReady = plan.exchange !== 'bitget' || plan.reduceOnly !== true
      || order.paperFundingSettlementEvidence?.complete === true;
    if (!feeReady || !taxReady || !fxReady || !fundingReady) {
      lane.missingFullCostEvidence += 1;
    }
  }
  const total = zeroPaperLane();
  for (const market of ADMIN_FOUR_PAPER_MARKETS) {
    for (const key of Object.keys(total) as Array<keyof PaperMarketHistoryLane>) {
      total[key] += markets[market][key];
    }
  }
  const status = total.paperOrders === 0 ? 'NO_HISTORY'
    : total.invalidFilledOrders || total.conflictingJournalMirrors
      ? 'INCOMPLETE_EXECUTION_EVIDENCE'
      : total.missingJournalMirrors ? 'INCOMPLETE_JOURNAL'
        : total.missingFullCostEvidence || total.aggregateOnlyFilledOrders
          ? 'UNSETTLED_PAPER_HISTORY' : 'HISTORY_OBSERVED_NOT_PROFITABILITY';
  return Object.freeze({
    version: PAPER_EXECUTION_HISTORY_AUDIT_V1,
    readOnlyProbe: true as const,
    ownerScope: 'SELF' as const,
    status,
    totals: Object.freeze(total),
    markets: Object.freeze(Object.fromEntries(
      ADMIN_FOUR_PAPER_MARKETS.map(market => [market,Object.freeze(markets[market])]),
    ) as Record<AdminPaperMarket,Readonly<PaperMarketHistoryLane>>),
    actualSettlementProven: false as const,
    profitabilityProven: false as const,
    financialMutationCount: 0 as const,
    privateProviderRequests: 0 as const,
    executionAuthority: 'NONE' as const,
  });
}
