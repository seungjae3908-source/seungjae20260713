import { getSupabase, hasSupabaseServerKey } from '../lib/supabase';
import type { ScannerSignalState } from './scanner-signal.types';

export type StoredTelegramSignalFollowupState = {
  signalId: string;
  expiresAt: string;
  lastState: ScannerSignalState;
  lastPrice: number | null;
  reachedTargets: number[];
  stopReached: boolean;
  announcedAt: number;
  lastSeenAt: number;
};

export interface TelegramSignalFollowupRepository {
  list(signalIds: readonly string[]): Promise<StoredTelegramSignalFollowupState[]>;
  save(states: readonly StoredTelegramSignalFollowupState[]): Promise<void>;
  pruneBefore(cutoffMs: number): Promise<number>;
}

const scannerSignalStates = new Set<ScannerSignalState>([
  'CANDIDATE',
  'CONFIRMED',
  'ARMED',
  'ENTRY_ZONE',
  'APPROVAL_PENDING',
  'APPROVED',
  'EXECUTING',
  'PARTIALLY_FILLED',
  'FILLED',
  'MANAGING',
  'CLOSED',
  'INVALIDATED',
  'EXPIRED',
  'REJECTED',
  'CANCELLED',
  'DETECTED',
  'WATCHING',
  'READY_FOR_APPROVAL',
  'WEAKENED',
]);

function storageError(): Error {
  return new Error('TELEGRAM_SIGNAL_FOLLOWUP_STORAGE_UNAVAILABLE');
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw storageError();
  return value.trim();
}

function requiredTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) throw storageError();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw storageError();
  return parsed;
}

function requiredState(value: unknown): ScannerSignalState {
  const candidate = requiredString(value) as ScannerSignalState;
  if (!scannerSignalStates.has(candidate)) throw storageError();
  return candidate;
}

function requiredTargets(value: unknown): number[] {
  if (!Array.isArray(value)) throw storageError();
  const targets = value.map((target) => {
    if (!Number.isInteger(target) || target < 0 || target > 16) throw storageError();
    return target as number;
  });
  if (new Set(targets).size !== targets.length) throw storageError();
  return [...targets].sort((left, right) => left - right);
}

function optionalPrice(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1e18) {
    throw storageError();
  }
  return value;
}

export function validateStoredTelegramSignalFollowupState(
  state: StoredTelegramSignalFollowupState,
): StoredTelegramSignalFollowupState {
  const signalId = requiredString(state.signalId);
  const expiresAt = requiredString(state.expiresAt);
  requiredTimestamp(expiresAt);
  const lastState = requiredState(state.lastState);
  const lastPrice = optionalPrice(state.lastPrice);
  const reachedTargets = requiredTargets(state.reachedTargets);
  if (typeof state.stopReached !== 'boolean') throw storageError();
  if (!Number.isFinite(state.announcedAt) || state.announcedAt < 0) throw storageError();
  if (!Number.isFinite(state.lastSeenAt) || state.lastSeenAt < state.announcedAt) throw storageError();
  return {
    signalId,
    expiresAt,
    lastState,
    lastPrice,
    reachedTargets,
    stopReached: state.stopReached,
    announcedAt: state.announcedAt,
    lastSeenAt: state.lastSeenAt,
  };
}

function copyState(state: StoredTelegramSignalFollowupState): StoredTelegramSignalFollowupState {
  const valid = validateStoredTelegramSignalFollowupState(state);
  return {
    ...valid,
    reachedTargets: [...valid.reachedTargets],
  };
}

export class InMemoryTelegramSignalFollowupRepository implements TelegramSignalFollowupRepository {
  private readonly states = new Map<string, StoredTelegramSignalFollowupState>();

  async list(signalIds: readonly string[]) {
    const ids = new Set(signalIds);
    return [...this.states.values()]
      .filter((state) => ids.has(state.signalId))
      .map(copyState);
  }

  async save(states: readonly StoredTelegramSignalFollowupState[]) {
    for (const state of states) {
      const valid = copyState(state);
      this.states.set(valid.signalId, valid);
    }
  }

  async pruneBefore(cutoffMs: number) {
    if (!Number.isFinite(cutoffMs) || cutoffMs < 0) throw storageError();
    let deleted = 0;
    for (const [signalId, state] of this.states) {
      if (state.lastSeenAt < cutoffMs) {
        this.states.delete(signalId);
        deleted += 1;
      }
    }
    return deleted;
  }
}

function safeIso(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) throw storageError();
  return new Date(ms).toISOString();
}

function fromRow(row: Record<string, unknown>): StoredTelegramSignalFollowupState {
  if (typeof row.stop_reached !== 'boolean') throw storageError();
  const state: StoredTelegramSignalFollowupState = {
    signalId: requiredString(row.signal_id),
    expiresAt: requiredString(row.expires_at),
    lastState: requiredState(row.last_state),
    lastPrice: optionalPrice(row.last_price),
    reachedTargets: requiredTargets(row.reached_targets),
    stopReached: row.stop_reached,
    announcedAt: requiredTimestamp(row.announced_at),
    lastSeenAt: requiredTimestamp(row.last_seen_at),
  };
  return validateStoredTelegramSignalFollowupState(state);
}

function toRow(state: StoredTelegramSignalFollowupState) {
  const valid = validateStoredTelegramSignalFollowupState(state);
  return {
    signal_id: valid.signalId,
    expires_at: valid.expiresAt,
    last_state: valid.lastState,
    last_price: valid.lastPrice,
    reached_targets: valid.reachedTargets,
    stop_reached: valid.stopReached,
    announced_at: safeIso(valid.announcedAt),
    last_seen_at: safeIso(valid.lastSeenAt),
    updated_at: new Date().toISOString(),
  };
}

export class SupabaseTelegramSignalFollowupRepository implements TelegramSignalFollowupRepository {
  private table() {
    if (!hasSupabaseServerKey()) throw storageError();
    return getSupabase().from('telegram_signal_followup_ledger');
  }

  async list(signalIds: readonly string[]) {
    const ids = [...new Set(signalIds.map((value) => value.trim()).filter(Boolean))].slice(0, 500);
    if (!ids.length) return [];
    const { data, error } = await this.table()
      .select('signal_id,expires_at,last_state,last_price,reached_targets,stop_reached,announced_at,last_seen_at')
      .in('signal_id', ids);
    if (error) throw storageError();
    return (data ?? []).map((row) => fromRow(row as Record<string, unknown>));
  }

  async save(states: readonly StoredTelegramSignalFollowupState[]) {
    if (!states.length) return;
    const rows = states.slice(0, 500).map(toRow);
    const { error } = await this.table().upsert(rows, { onConflict: 'signal_id' });
    if (error) throw storageError();
  }

  async pruneBefore(cutoffMs: number) {
    const cutoff = safeIso(cutoffMs);
    const { data, error } = await this.table()
      .delete()
      .lt('last_seen_at', cutoff)
      .select('signal_id');
    if (error) throw storageError();
    return data?.length ?? 0;
  }
}

const testFallbackRepository = new InMemoryTelegramSignalFollowupRepository();

export function createTelegramSignalFollowupRepository(): TelegramSignalFollowupRepository {
  if (hasSupabaseServerKey()) return new SupabaseTelegramSignalFollowupRepository();
  if (process.env.NODE_ENV !== 'production') return testFallbackRepository;
  throw storageError();
}
