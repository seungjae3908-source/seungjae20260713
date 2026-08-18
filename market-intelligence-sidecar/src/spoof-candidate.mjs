const CONTRACT = 'market-intelligence-spoof-candidate/v1';

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function normalizeLevel(level) {
  if (Array.isArray(level)) return { price: finite(level[0]), size: finite(level[1]) };
  if (level && typeof level === 'object') {
    return {
      price: finite(level.price ?? level[0]),
      size: finite(level.size ?? level.qty ?? level.quantity ?? level[1]),
    };
  }
  return { price: null, size: null };
}

function normalizeBook(book) {
  const clean = (rows, descending) => (Array.isArray(rows) ? rows : [])
    .map(normalizeLevel)
    .filter((row) => row.price > 0 && row.size >= 0)
    .sort((a, b) => descending ? b.price - a.price : a.price - b.price)
    .slice(0, 50);
  return {
    ts: finite(book?.ts ?? book?.timestamp),
    bids: clean(book?.bids, true),
    asks: clean(book?.asks, false),
  };
}

function bookMid(book) {
  const bestBid = book.bids[0];
  const bestAsk = book.asks[0];
  return bestBid && bestAsk ? (bestBid.price + bestAsk.price) / 2 : null;
}

function spreadBps(book) {
  const mid = bookMid(book);
  const bestBid = book.bids[0];
  const bestAsk = book.asks[0];
  return mid && bestBid && bestAsk ? ((bestAsk.price - bestBid.price) / mid) * 10_000 : null;
}

function levelNearPrice(levels, price, toleranceBps) {
  if (!(price > 0)) return null;
  return levels.find((row) => Math.abs(row.price - price) / price * 10_000 <= toleranceBps) ?? null;
}

function levelNotionals(book) {
  return [...book.bids.slice(0, 20), ...book.asks.slice(0, 20)].map((row) => row.price * row.size);
}

function trailingPersistence(history, side, price, referenceSize) {
  const rows = Array.isArray(history) ? history : [];
  let count = 0;
  let firstTs = null;
  let lastTs = null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const book = normalizeBook(rows[index]?.orderBook);
    const levels = side === 'bid' ? book.bids : book.asks;
    const level = levelNearPrice(levels, price, 1);
    if (!level || level.size < referenceSize * 0.5) break;
    count += 1;
    const ts = finite(rows[index]?.asOf ?? book.ts);
    if (ts != null) {
      firstTs = ts;
      if (lastTs == null) lastTs = ts;
    }
  }
  return {
    snapshots: count,
    durationMs: firstTs != null && lastTs != null ? Math.max(0, lastTs - firstTs) : null,
  };
}

export function evaluateSpoofCandidate(input = {}) {
  const withdrawal = input.withdrawal ?? {};
  const currentBook = normalizeBook(input.currentBook);
  const previousBook = normalizeBook(input.previousBook);
  const wallSide = withdrawal.side === 'bid' || withdrawal.side === 'ask' ? withdrawal.side : null;
  const wallPrice = finite(withdrawal.wallPrice);
  const wallNotional = finite(withdrawal.wallNotional);
  const cancellationRatio = finite(withdrawal.cancellationRatio);
  const executedRatio = finite(withdrawal.executedRatio);
  const rawWithdrawalScore = finite(withdrawal.score, 0);
  const direction = wallSide === 'ask' ? 'BULLISH_SUPPORT' : wallSide === 'bid' ? 'BEARISH_SUPPORT' : null;

  const base = {
    contract: CONTRACT,
    mode: 'OBSERVE_ONLY',
    state: 'NO_CANDIDATE',
    direction,
    evidenceScore: null,
    evidence: {
      wallSide,
      wallPrice,
      wallNotional,
      relativeSizeRatio: null,
      cancellationRatio,
      executedRatio,
      persistenceSnapshots: 0,
      persistenceMs: null,
      snapshotGapMs: null,
      distanceToMidBps: null,
      migratedNotionalRatio: null,
      postWithdrawMidMoveBps: null,
      ofi: finite(input.ofi),
      cvdNormalized: finite(input.cvdNormalized),
      micropriceBiasBps: finite(input.micropriceBiasBps),
    },
    confounders: [],
    missingEvidence: [],
    scannerHardBlockAllowed: false,
    parentGateImpact: 'NONE',
    orderAllowed: false,
    executionAuthority: 'NONE',
  };

  if (!(rawWithdrawalScore > 0) || !wallSide || !(wallPrice > 0) || !(wallNotional > 0)) return base;

  const previousMid = bookMid(previousBook);
  const currentMid = bookMid(currentBook);
  const previousSpread = spreadBps(previousBook);
  const currentSpread = spreadBps(currentBook);
  const med = median(levelNotionals(previousBook));
  const relativeSizeRatio = med && med > 0 ? wallNotional / med : null;
  const distanceToMidBps = previousMid ? Math.abs(wallPrice - previousMid) / previousMid * 10_000 : null;
  const snapshotGapMs = previousBook.ts != null && currentBook.ts != null ? currentBook.ts - previousBook.ts : null;
  const postWithdrawMidMoveBps = previousMid && currentMid ? ((currentMid - previousMid) / previousMid) * 10_000 : null;
  const currentSide = wallSide === 'bid' ? currentBook.bids : currentBook.asks;
  const migrated = currentSide
    .filter((row) => Math.abs(row.price - wallPrice) / wallPrice * 10_000 > 1)
    .filter((row) => Math.abs(row.price - wallPrice) / wallPrice * 10_000 <= 10)
    .reduce((max, row) => Math.max(max, row.price * row.size), 0);
  const migratedNotionalRatio = wallNotional > 0 ? clamp(migrated / wallNotional, 0, 2) : null;
  const persistence = trailingPersistence(input.history, wallSide, wallPrice, wallNotional / wallPrice);

  const missingEvidence = [];
  if (!Array.isArray(input.history) || input.history.length < 2) missingEvidence.push('MULTI_SNAPSHOT_HISTORY');
  if (executedRatio == null) missingEvidence.push('TRADE_EXECUTION_EVIDENCE');
  if (previousMid == null || currentMid == null) missingEvidence.push('TWO_SIDED_BOOK');
  if (snapshotGapMs == null) missingEvidence.push('SNAPSHOT_TIMESTAMPS');

  const confounders = [];
  if (previousBook.bids.length < 5 || previousBook.asks.length < 5) confounders.push('THIN_BOOK');
  if (snapshotGapMs != null && snapshotGapMs <= 0) confounders.push('OUT_OF_ORDER_SNAPSHOT');
  const maxGapMs = Math.max(1_000, finite(input.maxDataAgeMs, 15_000) * 2);
  if (snapshotGapMs != null && snapshotGapMs > maxGapMs) confounders.push('SNAPSHOT_GAP_TOO_LARGE');
  if (migratedNotionalRatio != null && migratedNotionalRatio >= 0.5) confounders.push('NEARBY_QUOTE_MIGRATION');
  if (previousSpread != null && currentSpread != null && currentSpread > Math.max(previousSpread * 2.5, previousSpread + 10)) {
    confounders.push('SPREAD_SHOCK');
  }
  if (persistence.snapshots < 2) confounders.push('WALL_PERSISTENCE_NOT_PROVEN');

  const expectedSign = wallSide === 'ask' ? 1 : -1;
  const flowComponents = [finite(input.ofi), finite(input.cvdNormalized), finite(input.micropriceBiasBps) == null ? null : clamp(input.micropriceBiasBps / 5, -1, 1)]
    .filter(Number.isFinite);
  const flowComposite = flowComponents.length ? flowComponents.reduce((sum, value) => sum + value, 0) / flowComponents.length : null;
  const flowAligned = flowComposite == null ? null : Math.sign(flowComposite) === expectedSign;
  const priceResponseAligned = postWithdrawMidMoveBps == null
    ? null
    : expectedSign > 0 ? postWithdrawMidMoveBps >= 0 : postWithdrawMidMoveBps <= 0;

  let evidenceScore = 0;
  evidenceScore += clamp((cancellationRatio ?? 0) * 30, 0, 30);
  evidenceScore += clamp((1 - (executedRatio ?? 1)) * 20, 0, 20);
  evidenceScore += clamp(((relativeSizeRatio ?? 0) - 3) * 5, 0, 15);
  evidenceScore += clamp(persistence.snapshots * 5, 0, 15);
  evidenceScore += distanceToMidBps == null ? 0 : clamp((20 - distanceToMidBps) / 2, 0, 10);
  if (flowAligned === true) evidenceScore += 5;
  if (priceResponseAligned === true) evidenceScore += 5;
  evidenceScore = clamp(evidenceScore, 0, 100);

  const hardConfounders = new Set(['OUT_OF_ORDER_SNAPSHOT', 'SNAPSHOT_GAP_TOO_LARGE', 'NEARBY_QUOTE_MIGRATION', 'SPREAD_SHOCK', 'THIN_BOOK']);
  const state = missingEvidence.length || confounders.some((reason) => hardConfounders.has(reason)) || persistence.snapshots < 2
    ? 'INSUFFICIENT_EVIDENCE'
    : 'CANDIDATE';

  return {
    ...base,
    state,
    evidenceScore,
    evidence: {
      ...base.evidence,
      relativeSizeRatio,
      persistenceSnapshots: persistence.snapshots,
      persistenceMs: persistence.durationMs,
      snapshotGapMs,
      distanceToMidBps,
      migratedNotionalRatio,
      postWithdrawMidMoveBps,
      flowComposite,
      flowAligned,
      priceResponseAligned,
    },
    confounders,
    missingEvidence,
  };
}

export { CONTRACT as SPOOF_CANDIDATE_CONTRACT };
