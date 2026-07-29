// Two-tier TTL cache.
//
// Tier 1: in-memory Map — always on, keeps hot values across requests and
// protects strict free-tier rate limits (e.g. Alpha Vantage ~25 req/day).
// Tier 2: Supabase `market_cache` table (jsonb payload + expires_at) — used
// only for entries with TTL >= 5 min (disclosures, listings, signals, ...) so
// short-lived quote keys don't churn the table. Survives server restarts.
//
// The persistent tier is best-effort: if Supabase is unconfigured, the table
// is missing, or a call fails, we log once and behave exactly like the old
// memory-only cache. Loader errors are never cached in either tier.
import { getSupabase, hasSupabaseServerKey } from './supabase';

interface Entry<T> {
  value: T;
  expires: number;
  estimatedBytes: number;
}

const store = new Map<string, Entry<unknown>>();
const pendingLoads = new Map<string, Promise<unknown>>();
const pendingPersistentWrites = new Set<Promise<void>>();

const DEFAULT_MAX_MEMORY_ENTRIES = 750;
const MIN_MAX_MEMORY_ENTRIES = 100;
const MAX_MAX_MEMORY_ENTRIES = 10_000;

const cacheCounters = {
  hits: 0,
  misses: 0,
  sets: 0,
  expiredDeleted: 0,
  evicted: 0,
};

const PERSIST_TABLE = 'market_cache';
const PERSIST_MIN_TTL_MS = 5 * 60 * 1000;

let persistWarned = false;

function maxMemoryEntries(): number {
  const configured = Number(process.env.MEMORY_CACHE_MAX_ENTRIES);
  if (!Number.isFinite(configured)) return DEFAULT_MAX_MEMORY_ENTRIES;
  return Math.max(
    MIN_MAX_MEMORY_ENTRIES,
    Math.min(MAX_MAX_MEMORY_ENTRIES, Math.trunc(configured)),
  );
}

function pruneExpired(now = Date.now()): void {
  for (const [key, entry] of store) {
    if (entry.expires > now) continue;
    store.delete(key);
    cacheCounters.expiredDeleted += 1;
  }
}

function enforceMemoryLimit(): void {
  const maximum = maxMemoryEntries();
  while (store.size > maximum) {
    const oldest = store.keys().next();
    if (oldest.done) return;
    store.delete(oldest.value);
    cacheCounters.evicted += 1;
  }
}

function estimateBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized == null ? 0 : Buffer.byteLength(serialized);
  } catch {
    return 0;
  }
}

function cacheNamespace(key: string): string {
  const separator = key.indexOf(':');
  return separator > 0 ? key.slice(0, separator) : 'other';
}

function saveMemoryEntry<T>(key: string, entry: Entry<T>): void {
  // Refresh insertion order so the bounded Map behaves as a simple LRU.
  store.delete(key);
  store.set(key, entry as Entry<unknown>);
  cacheCounters.sets += 1;
  pruneExpired();
  enforceMemoryLimit();
}

function warnPersistOnce(action: string, error: unknown): void {
  if (persistWarned) return;
  persistWarned = true;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[cache] Supabase persistent tier disabled for this issue (${action}): ${message}`,
  );
}

function persistable(ttlMs: number): boolean {
  return ttlMs >= PERSIST_MIN_TTL_MS && hasSupabaseServerKey();
}

async function readPersistent<T>(key: string): Promise<Entry<T> | null> {
  try {
    const { data, error } = await getSupabase()
      .from(PERSIST_TABLE)
      .select('payload,expires_at')
      .eq('cache_key', key)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const expires = Date.parse(data.expires_at as string);
    if (!Number.isFinite(expires) || expires <= Date.now()) return null;
    return {
      value: data.payload as T,
      expires,
      estimatedBytes: estimateBytes(data.payload),
    };
  } catch (error) {
    warnPersistOnce('read', error);
    return null;
  }
}

function writePersistent(key: string, value: unknown, ttlMs: number, expires: number): void {
  const operation = Promise.resolve(
    getSupabase()
      .from(PERSIST_TABLE)
      .upsert(
        {
          cache_key: key,
          payload: value,
          ttl_ms: ttlMs,
          expires_at: new Date(expires).toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'cache_key' },
      ),
  )
    .then(({ error }) => {
      if (error) warnPersistOnce('write', new Error(error.message));
    })
    .then(() => undefined)
    .finally(() => {
      pendingPersistentWrites.delete(operation);
    });
  pendingPersistentWrites.add(operation);
}

export async function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expires > now) {
    store.delete(key);
    store.set(key, hit as Entry<unknown>);
    cacheCounters.hits += 1;
    return hit.value;
  }
  if (hit) {
    store.delete(key);
    cacheCounters.expiredDeleted += 1;
  }
  cacheCounters.misses += 1;

  const pending = pendingLoads.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const operation = (async () => {
    if (persistable(ttlMs)) {
      const persisted = await readPersistent<T>(key);
      if (persisted) {
        saveMemoryEntry(key, persisted);
        return persisted.value;
      }
    }

    const value = await loader();
    const expires = Date.now() + ttlMs;
    saveMemoryEntry(key, {
      value,
      expires,
      estimatedBytes: estimateBytes(value),
    });
    if (persistable(ttlMs)) {
      writePersistent(key, value, ttlMs, expires);
    }
    return value;
  })().finally(() => {
    if (pendingLoads.get(key) === operation) {
      pendingLoads.delete(key);
    }
  });

  pendingLoads.set(key, operation);
  return operation;
}

export interface MemoryCacheDiagnostics {
  entries: number;
  expiredEntries: number;
  estimatedBytes: number;
  pendingLoads: number;
  pendingPersistentWrites: number;
  maxEntries: number;
  hits: number;
  misses: number;
  sets: number;
  expiredDeleted: number;
  evicted: number;
  namespaceEntries: Record<string, number>;
  namespaceEstimatedBytes: Record<string, number>;
}

export function getMemoryCacheDiagnostics(
  now = Date.now(),
): MemoryCacheDiagnostics {
  let expiredEntries = 0;
  let estimatedBytes = 0;
  const namespaceEntries: Record<string, number> = {};
  const namespaceEstimatedBytes: Record<string, number> = {};
  for (const [key, entry] of store) {
    if (entry.expires <= now) expiredEntries += 1;
    estimatedBytes += entry.estimatedBytes;
    const namespace = cacheNamespace(key);
    namespaceEntries[namespace] = (namespaceEntries[namespace] ?? 0) + 1;
    namespaceEstimatedBytes[namespace] =
      (namespaceEstimatedBytes[namespace] ?? 0) + entry.estimatedBytes;
  }
  return {
    entries: store.size,
    expiredEntries,
    estimatedBytes,
    pendingLoads: pendingLoads.size,
    pendingPersistentWrites: pendingPersistentWrites.size,
    maxEntries: maxMemoryEntries(),
    ...cacheCounters,
    namespaceEntries,
    namespaceEstimatedBytes,
  };
}

export function resetMemoryCacheForTests(): void {
  store.clear();
  pendingLoads.clear();
  pendingPersistentWrites.clear();
  cacheCounters.hits = 0;
  cacheCounters.misses = 0;
  cacheCounters.sets = 0;
  cacheCounters.expiredDeleted = 0;
  cacheCounters.evicted = 0;
}

export const TTL = {
  quote: 60 * 1000, // 1 min
  news: 15 * 60 * 1000, // 15 min
  financials: 24 * 60 * 60 * 1000, // 24 h (rate-limit friendly)
  signals: 12 * 60 * 60 * 1000, // 12 h
  risk: 6 * 60 * 60 * 1000, // 6 h
  profile: 24 * 60 * 60 * 1000, // 24 h
  mapping: 24 * 60 * 60 * 1000, // 24 h (CIK / corp_code maps)
  market: 6 * 60 * 60 * 1000, // 6 h (full market listings)
} as const;
