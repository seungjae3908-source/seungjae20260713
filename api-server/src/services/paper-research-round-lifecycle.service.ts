import { createHash } from 'node:crypto';
import { ADMIN_FOUR_PAPER_MARKETS, type AdminPaperMarket } from './admin-four-market-paper-capital.service';

// A deterministic, READ-ONLY research-round proposal. This is NOT a wallet
// bootstrap, financial receipt, or authority to bypass production RLS.
// Durable persistence and transactional idempotency belong to a separately
// reviewed server-owned Paper-only V3 wallet migration/worker integration.
export type PaperResearchMode = 'automatic' | 'manual';
export type PaperRoundDecision = Readonly<{
  status: 'ACTIVE' | 'EXHAUSTED' | 'BLOCKED_EVIDENCE' | 'OPEN_EXPOSURE';
  eligibleForNewRound: boolean;
  // Zero equity is true bankruptcy; positive cash below the provider
  // minimum is a different research-round ending and is not counted as ruin.
  endingCause: 'ZERO_EQUITY' | 'BELOW_VERIFIED_MINIMUM' | null;
  nextAction: 'NONE' | 'AUTO_RESEARCH_ROUND_PROPOSAL' | 'MANUAL_OWNER_CONFIRMATION';
  proposedRoundId: string | null;
  nextSeedKrw: number | null;
  blockers: readonly string[];
  executionAuthority: 'NONE';
  financialMutationAllowed: false;
  mayUsePriorReserve: false;
  previousHistoryPreserved: true;
}>;

export type PaperRoundSnapshot = Readonly<{
  // Identity/epoch and settlement evidence MUST be supplied by the protected
  // server ledger reader, never by an HTTP body or client-side declaration.
  ownerId: string;
  market: AdminPaperMarket;
  mode: PaperResearchMode;
  roundNumber: number;
  currentEpochId: string;
  previousRoundReceiptSha256: string | null;
  settlementDigestSha256: string;
  ledgerReadbackReady: boolean;
  costsAndFxVerified: boolean;
  positionCount: number;
  pendingOrderCount: number;
  unreconciledFillCount: number;
  operatingCapitalKrw: number;
  reserveKrw: number;
  availableToTradeKrw: number;
  // Must be derived from the actual selected market contract and fresh quote,
  // not a constant universal minimum. Unknown means fail closed.
  verifiedMinimumEntryKrw: number | null;
  minimumEntryObservedAtMs: number | null;
  nowMs: number;
  alreadyCreatedNextRound: boolean;
}>;

const DIGEST = /^[0-9a-f]{64}$/u;
const SHA = (value: string) => createHash('sha256').update(value).digest('hex');
const finiteNonnegative = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0;
const safeCount = (n: unknown): n is number =>
  Number.isSafeInteger(n) && Number(n) >= 0;
const INITIAL_KRW = 1_000_000;

/** The deterministic proposal never creates credits or modifies accounts. */
export function assessPaperResearchRound(snapshot: PaperRoundSnapshot): PaperRoundDecision {
  const blockers: string[] = [];
  const block = (code: string) => { if (!blockers.includes(code)) blockers.push(code); };
  const basicIdentity = typeof snapshot.ownerId === 'string'
    && /^[A-Za-z0-9._:-]{5,128}$/u.test(snapshot.ownerId)
    && ADMIN_FOUR_PAPER_MARKETS.includes(snapshot.market)
    && ['automatic','manual'].includes(snapshot.mode)
    && safeCount(snapshot.roundNumber) && snapshot.roundNumber > 0
    && typeof snapshot.currentEpochId === 'string'
    && /^[A-Za-z0-9._:-]{3,128}$/u.test(snapshot.currentEpochId)
    && DIGEST.test(snapshot.settlementDigestSha256)
    && (snapshot.previousRoundReceiptSha256 === null
      || DIGEST.test(snapshot.previousRoundReceiptSha256));
  if (!basicIdentity) block('PAPER_ROUND_IDENTITY_UNVERIFIED');
  if (!Number.isSafeInteger(snapshot.nowMs) || snapshot.nowMs <= 0) block('PAPER_ROUND_CLOCK_INVALID');
  if (!snapshot.ledgerReadbackReady || !snapshot.costsAndFxVerified) block('PAPER_ROUND_SETTLEMENT_UNVERIFIED');
  for (const number of [snapshot.operatingCapitalKrw, snapshot.reserveKrw, snapshot.availableToTradeKrw]) {
    if (!finiteNonnegative(number)) block('PAPER_ROUND_CAPITAL_UNVERIFIED');
  }
  for (const count of [snapshot.positionCount, snapshot.pendingOrderCount, snapshot.unreconciledFillCount]) {
    if (!safeCount(count)) block('PAPER_ROUND_OPEN_EXPOSURE_UNVERIFIED');
  }
  if (finiteNonnegative(snapshot.availableToTradeKrw)
    && finiteNonnegative(snapshot.operatingCapitalKrw)
    && snapshot.availableToTradeKrw > snapshot.operatingCapitalKrw + 0.01) {
    block('PAPER_ROUND_AVAILABLE_CAPITAL_EXCEEDS_EQUITY');
  }
  if (snapshot.alreadyCreatedNextRound) block('PAPER_ROUND_ALREADY_CREATED');

  const defaultDecision = (status: PaperRoundDecision['status']): PaperRoundDecision =>
    Object.freeze({
      status, eligibleForNewRound:false, endingCause:null, nextAction:'NONE' as const,
      proposedRoundId:null, nextSeedKrw:null, blockers:Object.freeze([...blockers]),
      executionAuthority:'NONE' as const, financialMutationAllowed:false as const,
      mayUsePriorReserve:false as const, previousHistoryPreserved:true as const,
    });
  if (blockers.length) return defaultDecision('BLOCKED_EVIDENCE');
  if (snapshot.positionCount > 0 || snapshot.pendingOrderCount > 0 || snapshot.unreconciledFillCount > 0) {
    block('PAPER_ROUND_POSITION_OR_ORDER_STILL_OPEN');
    return defaultDecision('OPEN_EXPOSURE');
  }

  // Zero *available* cash is not evidence of bankruptcy while equity is
  // still positive. Funds may be reserved, withheld by risk, or unsettled.
  // Never mint another 1m round to bypass locked capital.
  if (snapshot.operatingCapitalKrw > 0 && snapshot.availableToTradeKrw <= 0) {
    block('PAPER_ROUND_POSITIVE_EQUITY_WITH_NO_AVAILABLE_CASH');
    return defaultDecision('BLOCKED_EVIDENCE');
  }
  const empty = snapshot.operatingCapitalKrw <= 0;
  const minimumVerified = snapshot.verifiedMinimumEntryKrw !== null
    && Number.isFinite(snapshot.verifiedMinimumEntryKrw)
    && snapshot.verifiedMinimumEntryKrw > 0
    && Number.isSafeInteger(snapshot.minimumEntryObservedAtMs)
    && snapshot.minimumEntryObservedAtMs! <= snapshot.nowMs
    && snapshot.nowMs - snapshot.minimumEntryObservedAtMs! <= 60_000;
  if (!empty && !minimumVerified) {
    block('PAPER_ROUND_MINIMUM_ORDER_EVIDENCE_REQUIRED');
    return defaultDecision('BLOCKED_EVIDENCE');
  }
  if (!empty && minimumVerified && snapshot.operatingCapitalKrw >= snapshot.verifiedMinimumEntryKrw!
      && snapshot.availableToTradeKrw + 0.01 < snapshot.verifiedMinimumEntryKrw!) {
    block('PAPER_ROUND_LOCKED_CAPITAL_NOT_BANKRUPTCY');
    return defaultDecision('BLOCKED_EVIDENCE');
  }
  const exhausted = empty
    || (minimumVerified && snapshot.operatingCapitalKrw + 0.01 < snapshot.verifiedMinimumEntryKrw!
      && snapshot.availableToTradeKrw + 0.01 < snapshot.verifiedMinimumEntryKrw!);
  if (!exhausted) return defaultDecision('ACTIVE');
  if (snapshot.roundNumber >= 100_000) {
    block('PAPER_ROUND_SEQUENCE_EXHAUSTED');
    return defaultDecision('BLOCKED_EVIDENCE');
  }
  const identity = [
    'paper-research-round-proposal-v1',snapshot.ownerId,snapshot.mode,snapshot.market,
    snapshot.currentEpochId,snapshot.roundNumber+1,snapshot.settlementDigestSha256,
    snapshot.previousRoundReceiptSha256 ?? 'GENESIS',
  ].join('|');
  return Object.freeze({
    status:'EXHAUSTED' as const, eligibleForNewRound:true,
    endingCause:empty ? 'ZERO_EQUITY' as const:'BELOW_VERIFIED_MINIMUM' as const,
    nextAction:snapshot.mode === 'automatic'
      ? 'AUTO_RESEARCH_ROUND_PROPOSAL' as const
      : 'MANUAL_OWNER_CONFIRMATION' as const,
    proposedRoundId:`paper-round-v1:${SHA(identity)}`,
    nextSeedKrw:INITIAL_KRW,
    blockers:Object.freeze([] as string[]),
    executionAuthority:'NONE' as const, financialMutationAllowed:false as const,
    mayUsePriorReserve:false as const, previousHistoryPreserved:true as const,
  });
}

export type PaperResearchRoundSummary = Readonly<{
  market: AdminPaperMarket;
  mode: PaperResearchMode;
  initialKrw: number;
  realizedNetPnlKrw: number;
  exhausted: boolean;
  bankrupt: boolean;
  // Prior rounds may still have a tiny positive balance below the verified
  // minimum order. It is *not* a full 1m bankruptcy and must not disappear.
  finalOperatingCapitalKrw: number;
}>;

export function summarizePaperResearchRounds(
  rounds: readonly PaperResearchRoundSummary[],
  market: AdminPaperMarket,
  mode: PaperResearchMode,
) {
  if (!ADMIN_FOUR_PAPER_MARKETS.includes(market) || !['automatic','manual'].includes(mode)) {
    throw new Error('PAPER_ROUND_SUMMARY_SCOPE_INVALID');
  }
  let totalSeedKrw = 0;
  let totalNetPnlKrw = 0;
  let bankruptcies = 0;
  let exhaustedRounds = 0;
  let retainedFinalCapitalKrw = 0;
  let count = 0;
  for (const row of rounds) {
    if (row.market !== market || row.mode !== mode) continue;
    if (row.initialKrw !== INITIAL_KRW || !Number.isFinite(row.realizedNetPnlKrw)
      || !finiteNonnegative(row.finalOperatingCapitalKrw)
      || typeof row.exhausted !== 'boolean' || typeof row.bankrupt !== 'boolean'
      || (row.bankrupt && (!row.exhausted || row.finalOperatingCapitalKrw > 0))) {
      throw new Error('PAPER_ROUND_SUMMARY_INVALID');
    }
    totalSeedKrw += row.initialKrw;
    totalNetPnlKrw += row.realizedNetPnlKrw;
    retainedFinalCapitalKrw += row.finalOperatingCapitalKrw;
    bankruptcies += Number(row.bankrupt);
    exhaustedRounds += Number(row.exhausted);
    count += 1;
  }
  if (!Number.isSafeInteger(totalSeedKrw) || !Number.isFinite(totalNetPnlKrw)
    || !Number.isFinite(retainedFinalCapitalKrw)) {
    throw new Error('PAPER_ROUND_SUMMARY_OVERFLOW');
  }
  return Object.freeze({
    mode, market, rounds:count, bankruptcies, exhaustedRounds,
    retainedFinalCapitalKrw, totalSeedKrw,
    totalNetPnlKrw,
    netReturnOnAllIssuedSeedPercent:totalSeedKrw > 0 ? totalNetPnlKrw/totalSeedKrw*100 : null,
    // Reserves remain locked, never automatically used to refill a new round.
    reserveTransfers:0 as const,
  });
}
