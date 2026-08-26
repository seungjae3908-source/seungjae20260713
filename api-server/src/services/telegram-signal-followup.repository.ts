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

function copyState(state: StoredTelegramSignalFollowupState): StoredTelegramSignalFollowupState {
  return {
    ...state,
    reachedTargets: [...state.reachedTargets],
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
    for (const state of states) this.states.set(state.signalId, copyState(state));
  }

  async pruneBefore(cutoffMs: number) {
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

function storageError(): Error {
  return new Error('TELEGRAM_SIGNAL_FOLLOWUP_STORAGE_UNAVAILABLE');
}

function safeIso(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) throw storageError();
  return new Date(ms).toISOString();
}

function fromRow(row: Record<string, unknown>): StoredTelegramSignalFollowupState {
  const reachedTargets = Array.isArray(row.reached_targets)
    ? row.reached_targets.filter((value): value is number => Number.isInteger(value) && value >= 0 && value <= 16)
    : [];
  const announcedAt = Date.parse(String(row.announced_at ?? ''));
  const lastSeenAt = Date.parse(String(row.last_seen_at ?? ''));
  const lastPrice = row.last_price == null ? null : Number(row.last_price);
  if (!Number.isFinite(announcedAt) || !Number.isFinite(lastSeenAt) || (lastPrice != null && !Number.isFinite(lastPrice))) {
    throw storageError();
  }
  return {
    signalId: String(row.signal_id ?? ''),
    expiresAt: String(row.expires_at ?? ''),
    lastState: String(row.last_state ?? '') as ScannerSignalState,
    lastPrice,
    reachedTargets,
    stopReached: row.stop_reached === true,
    announcedAt,
    lastSeenAt,
  };
}

function toRow(state: StoredTelegramSignalFollowupState) {
  return {
    signal_id: state.signalId,
    expires_at: state.expiresAt,
    last_state: state.lastState,
    last_price: state.lastPrice,
    reached_targets: [...state.reachedTargets].sort((a, b) => a - b),
    stop_reached: state.stopReached,
    announced_at: safeIso(state.announcedAt),
    last_seen_at: safeIso(state.lastSeenAt),
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
