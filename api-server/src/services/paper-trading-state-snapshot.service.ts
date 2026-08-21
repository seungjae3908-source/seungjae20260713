import { createHash } from 'node:crypto';
import { validateState } from './paper-trading-core.service';
import type { PaperTradingState } from './paper-trading.types';

export const PAPER_TRADING_STATE_SNAPSHOT_VERSION =
  'paper-trading-state-snapshot-v1' as const;

export type PaperTradingStateSnapshot = Readonly<{
  schemaVersion: typeof PAPER_TRADING_STATE_SNAPSHOT_VERSION;
  paperStateSchemaVersion: 1;
  sourceOwner: string;
  provenance: readonly string[];
  observedAtMs: number;
  stateUpdatedAtMs: number;
  maximumAgeMs: number;
  accountId: string;
  equity: number;
  openPositionCount: number;
  stateDigestSha256: string;
  state: Readonly<PaperTradingState>;
  immutable: true;
  executionAuthority: 'NONE';
  privateApiAllowed: false;
  liveTrading: false;
  financialMutationAllowed: false;
}>;

type SnapshotInput = Readonly<{
  state: PaperTradingState;
  sourceOwner: string;
  provenance: readonly string[];
  observedAtMs?: number;
  maximumAgeMs?: number;
}>;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stateDigest(state: PaperTradingState): string {
  return createHash('sha256').update(canonicalJson(state)).digest('hex');
}

function assertSnapshotState(state: PaperTradingState, nowMs: number, maximumAgeMs: number): number {
  validateState(state);
  if (!nonEmpty(state.account.id)) throw new Error('PAPER_STATE_ACCOUNT_ID_REQUIRED');
  if (!finite(state.account.equity) || state.account.equity <= 0) {
    throw new Error('PAPER_STATE_EQUITY_REQUIRED');
  }
  if (!state.riskState || [
    state.riskState.dailyRealizedPnl,
    state.riskState.weeklyRealizedPnl,
    state.riskState.consecutiveLosses,
  ].some((value) => !finite(value))) {
    throw new Error('PAPER_STATE_RISK_STATE_REQUIRED');
  }
  if (!Array.isArray(state.processedEventIds)) throw new Error('PAPER_STATE_EVENT_IDS_REQUIRED');
  for (const position of state.positions) {
    if (!finite(position.notionalValue) || position.notionalValue < 0) {
      throw new Error('PAPER_STATE_POSITION_EXPOSURE_REQUIRED');
    }
  }
  const stateUpdatedAtMs = Date.parse(state.updatedAt);
  if (!finite(stateUpdatedAtMs) || stateUpdatedAtMs <= 0 || stateUpdatedAtMs > nowMs) {
    throw new Error('PAPER_STATE_TIMESTAMP_INVALID');
  }
  if (nowMs - stateUpdatedAtMs > maximumAgeMs) throw new Error('PAPER_STATE_STALE');
  return stateUpdatedAtMs;
}

export function createImmutablePaperTradingStateSnapshot({
  state,
  sourceOwner,
  provenance,
  observedAtMs = Date.now(),
  maximumAgeMs = 30_000,
}: SnapshotInput): PaperTradingStateSnapshot {
  if (!finite(observedAtMs) || observedAtMs <= 0) throw new Error('PAPER_STATE_OBSERVED_AT_INVALID');
  if (!finite(maximumAgeMs) || maximumAgeMs <= 0) throw new Error('PAPER_STATE_MAXIMUM_AGE_INVALID');
  if (!nonEmpty(sourceOwner)) throw new Error('PAPER_STATE_SOURCE_OWNER_REQUIRED');
  if (!Array.isArray(provenance) || provenance.length === 0 || provenance.some((value) => !nonEmpty(value))) {
    throw new Error('PAPER_STATE_PROVENANCE_REQUIRED');
  }
  const clonedState = cloneJson(state);
  const stateUpdatedAtMs = assertSnapshotState(clonedState, observedAtMs, maximumAgeMs);
  const openPositionCount = clonedState.positions.filter((position) => position.status !== 'closed').length;
  return deepFreeze({
    schemaVersion: PAPER_TRADING_STATE_SNAPSHOT_VERSION,
    paperStateSchemaVersion: clonedState.schemaVersion,
    sourceOwner: sourceOwner.trim(),
    provenance: [...provenance],
    observedAtMs,
    stateUpdatedAtMs,
    maximumAgeMs,
    accountId: clonedState.account.id,
    equity: clonedState.account.equity,
    openPositionCount,
    stateDigestSha256: stateDigest(clonedState),
    state: clonedState,
    immutable: true,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
  });
}

export function validateImmutablePaperTradingStateSnapshot(
  value: unknown,
  nowMs = Date.now(),
): PaperTradingStateSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PAPER_STATE_SNAPSHOT_REQUIRED');
  }
  const snapshot = cloneJson(value) as PaperTradingStateSnapshot;
  if (snapshot.schemaVersion !== PAPER_TRADING_STATE_SNAPSHOT_VERSION
    || snapshot.paperStateSchemaVersion !== 1
    || snapshot.immutable !== true
    || snapshot.executionAuthority !== 'NONE'
    || snapshot.privateApiAllowed !== false
    || snapshot.liveTrading !== false
    || snapshot.financialMutationAllowed !== false) {
    throw new Error('PAPER_STATE_SNAPSHOT_CONTRACT_INVALID');
  }
  const rebuilt = createImmutablePaperTradingStateSnapshot({
    state: snapshot.state as PaperTradingState,
    sourceOwner: snapshot.sourceOwner,
    provenance: snapshot.provenance,
    observedAtMs: snapshot.observedAtMs,
    maximumAgeMs: snapshot.maximumAgeMs,
  });
  if (!finite(nowMs) || nowMs < rebuilt.observedAtMs || nowMs - rebuilt.stateUpdatedAtMs > rebuilt.maximumAgeMs) {
    throw new Error('PAPER_STATE_SNAPSHOT_STALE_OR_FUTURE');
  }
  if (snapshot.stateUpdatedAtMs !== rebuilt.stateUpdatedAtMs
    || snapshot.accountId !== rebuilt.accountId
    || snapshot.equity !== rebuilt.equity
    || snapshot.openPositionCount !== rebuilt.openPositionCount
    || snapshot.stateDigestSha256 !== rebuilt.stateDigestSha256) {
    throw new Error('PAPER_STATE_SNAPSHOT_DIGEST_MISMATCH');
  }
  return rebuilt;
}
