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
