import { createHash } from 'node:crypto';

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
  // No row-count ceiling: the repository pages through every stored row and
  // this reconciliation is linear (Map lookups). A fixed cap here turned a
  // large-but-valid journal into an HTTP 500 instead of a correct read.
  if (!Array.isArray(storedPayloads) || !Array.isArray(canonicalPayloads))
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
  'APP_AUTO', 'APP_MANUAL', 'TOSS_API', 'UPBIT_API', 'BITGET_API', 'KIWOOM_API',
]);
// Live orders placed by the app itself (automatic or user-clicked manual).
// Both are projected by the same trade-automation adapter with the same
// uppercase BROKER:userId account hash.
const APP_LIVE_SOURCES = new Set(['APP_AUTO', 'APP_MANUAL']);
const VERIFIED_UPBIT_BRIDGE_SCOPE = 'VERIFIED_SINGLE_PROVIDER_OWNER_VAULT';
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
    if ((APP_LIVE_SOURCES.has(source) && payload.accountIdMasked===expectedApp)
      || (source===broker+'_API' && payload.accountIdMasked===expectedVault)) {
      return VERIFIED_UPBIT_BRIDGE_SCOPE;
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
function validCostOrNull(value: unknown): boolean {
  return value == null
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}
function hasExchangeOrderId(payload: Payload): boolean {
  // The app adapter falls back to its *internal* order id when the exchange
  // id is unknown; that is not exchange evidence and must never bind.
  if (!APP_LIVE_SOURCES.has(String(payload.source))) return true;
  const lineage = object(payload.canonicalLineage) ? payload.canonicalLineage : null;
  const internal = lineage && Array.isArray(lineage.orderIds) ? lineage.orderIds : [];
  return !internal.includes(payload.brokerOrderId);
}
/**
 * Exchange-order-id binding (only for the verified Upbit owner bridge, where
 * brokerOrderId is an Upbit order UUID: globally unique, never reused).
 * Both rows are then snapshots of ONE exchange order, so exactly one may
 * count. Returns which snapshot is authoritative, or null to fall back to
 * the conservative rule (keep both):
 *  - equal cumulative fill + equal average price: the provider row wins
 *    (it carries the fee/tax receipt the app snapshot may lack);
 *  - different cumulative fill: the larger one wins, but only when the
 *    smaller one is an explicit PARTIALLY_FILLED snapshot.
 * Any other disagreement (FILLED with different quantity/price, invalid
 * provider costs, different position side/effect) keeps both rows.
 */
function exchangeOrderSupersession(
  previous: Payload, external: Payload, previousScope: string | null,
  externalScope: string | null,
): 'EXTERNAL' | 'PREVIOUS' | null {
  if (previousScope !== VERIFIED_UPBIT_BRIDGE_SCOPE
    || externalScope !== VERIFIED_UPBIT_BRIDGE_SCOPE) return null;
  if (!hasExchangeOrderId(previous) || !hasExchangeOrderId(external)) return null;
  for (const key of ['symbol','side','positionSide','positionEffect','currency']) {
    if (previous[key] !== external[key]) return null;
  }
  if (!validCostOrNull(external.fees) || !validCostOrNull(external.tax)) return null;
  const fillStates = new Set(['FILLED', 'PARTIALLY_FILLED']);
  if (!fillStates.has(String(previous.status)) || !fillStates.has(String(external.status)))
    return null;
  if (!positive(previous.filledQuantity) || !positive(external.filledQuantity)
    || !positive(previous.averageFillPrice) || !positive(external.averageFillPrice))
    return null;
  if (equalNumber(previous.filledQuantity, external.filledQuantity)) {
    return equalNumber(previous.averageFillPrice, external.averageFillPrice)
      ? 'EXTERNAL' : null;
  }
  const [smaller, winner] = previous.filledQuantity < external.filledQuantity
    ? [previous, 'EXTERNAL' as const] : [external, 'PREVIOUS' as const];
  return smaller.status === 'PARTIALLY_FILLED' ? winner : null;
}
export function reconcileScopedExternalJournalHistory(
  known: readonly Payload[], external: readonly Payload[], ownerId?: string,
): Readonly<{ payloads: readonly Payload[]; knownPayloads: readonly Payload[];
  audit: Readonly<{
  contract: string;
  suppressedVerifiedDuplicateCount: number;
  supersededKnownSnapshotCount: number;
  retainedExternalCount: number;
  financialMutationCount: 0;
  executionAuthority: 'NONE';
}> }> {
  // No row-count ceiling (see reconcileCanonicalPaperJournalMirrors).
  if (!Array.isArray(known) || !Array.isArray(external))
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
  const supersededKnown=new Set<Payload>();
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
      continue;
    }
    // Fallback: bind by the exchange order UUID (verified bridge only).
    const externalScope=verifiedOwnerAccountScope(payload, ownerId);
    const verdicts=candidates.map((previous)=>({
      previous,
      winner: exchangeOrderSupersession(previous,payload,
        verifiedOwnerAccountScope(previous,ownerId),externalScope),
    }));
    if (verdicts.some((verdict)=>verdict.winner==='PREVIOUS')) {
      suppressed++;
      continue;
    }
    for (const verdict of verdicts) {
      if (verdict.winner==='EXTERNAL') supersededKnown.add(verdict.previous);
    }
    retained.push(payload);
  }
  return Object.freeze({
    payloads:Object.freeze(retained),
    // Known rows minus app/stored snapshots superseded by the provider's
    // view of the same exchange order. Stored rows are never rewritten.
    knownPayloads:Object.freeze(known.filter((payload)=>!supersededKnown.has(payload))),
    audit:Object.freeze({
      contract:'journal-external-scoped-dedup/v1',
      suppressedVerifiedDuplicateCount:suppressed,
      supersededKnownSnapshotCount:supersededKnown.size,
      retainedExternalCount:retained.length,
      financialMutationCount:0 as const,
      executionAuthority:'NONE' as const,
    }),
  });
}
