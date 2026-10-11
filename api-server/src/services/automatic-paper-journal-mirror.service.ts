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
function verifiedLiveKey(payload: Payload): string | null {
  if (payload.recordType !== 'unified_trade_order'
    || !LIVE_HISTORY_SOURCES.has(String(payload.source))) return null;
  const parts = [
    payload.broker, payload.market, payload.accountIdMasked,
    payload.brokerOrderId,
  ];
  if (parts.some((value) => !nonempty(value))
    || !(payload.accountIdMasked as string).includes('****')
    || (payload.accountIdMasked as string).includes('UNAVAILABLE')) return null;
  return JSON.stringify(parts);
}
function exactEconomicDuplicate(existing: Payload, external: Payload): boolean {
  for (const key of ['symbol','side','positionSide','positionEffect','currency']) {
    if (existing[key] !== external[key]) return false;
  }
  if (existing.status !== external.status
    || !positive(existing.filledQuantity) || !positive(external.filledQuantity)
    || !equalNumber(existing.filledQuantity,external.filledQuantity)
    || !positive(existing.averageFillPrice) || !positive(external.averageFillPrice)
    || !equalNumber(existing.averageFillPrice,external.averageFillPrice)) return false;
  // A provider-supplied fee/tax receipt must not be hidden by an
  // incomplete or conflicting cached projection.
  for (const key of ['fees','tax']) {
    if (typeof external[key] === 'number' && Number.isFinite(external[key])) {
      if (typeof existing[key] !== 'number' || !Number.isFinite(existing[key])
        || !equalNumber(existing[key], external[key])) return false;
    }
  }
  return true;
}
export function reconcileScopedExternalJournalHistory(
  known: readonly Payload[], external: readonly Payload[],
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
    const key = verifiedLiveKey(payload);
    if (!key) continue;
    const group = knownByScope.get(key) ?? [];
    group.push(payload);
    knownByScope.set(key, group);
  }
  let suppressed=0;
  const retained: Payload[]=[];
  for (const payload of external) {
    if (!object(payload)) throw new Error('JOURNAL_EXTERNAL_PAYLOAD_INVALID');
    const key=verifiedLiveKey(payload);
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
