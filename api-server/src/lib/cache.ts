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
  staleUntil: number;
}

export interface CacheOptions {
  staleTtlMs?: number;
  loaderTimeoutMs?: number;
}

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

const PERSIST_TABLE = 'market_cache';
const PERSIST_MIN_TTL_MS = 5 * 60 * 1000;

let persistWarned = false;

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
      staleUntil: expires,
    };
  } catch (error) {
    warnPersistOnce('read', error);
    return null;
  }
}

function writePersistent(key: string, value: unknown, ttlMs: number, expires: number): void {
  void getSupabase()
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
    )
    .then(({ error }) => {
      if (error) warnPersistOnce('write', new Error(error.message));
    });
}

async function loadWithTimeout<T>(
  key: string,
  loader: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return loader();
  }

  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      loader(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `CACHE_LOADER_TIMEOUT:${key}:${Math.round(timeoutMs)}`,
            ),
          );
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  options: CacheOptions = {},
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;

  if (hit && hit.expires > now) {
    return hit.value;
  }

  const hasStale =
    Boolean(hit) &&
    Number(hit?.staleUntil ?? 0) > now;

  const staleValue = hasStale
    ? hit!.value
    : undefined;

  if (persistable(ttlMs)) {
    const persisted = await readPersistent<T>(key);

    if (persisted) {
      store.set(key, persisted);
      return persisted.value;
    }
  }

  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const task = (async (): Promise<T> => {
    try {
      const value = await loadWithTimeout(
        key,
        loader,
        Number(options.loaderTimeoutMs ?? 0),
      );

      const savedAt = Date.now();
      const expires = savedAt + Math.max(0, ttlMs);
      const staleUntil =
        expires + Math.max(0, Number(options.staleTtlMs ?? 0));

      store.set(key, {
        value,
        expires,
        staleUntil,
      });

      if (persistable(ttlMs)) {
        writePersistent(key, value, ttlMs, expires);
      }

      return value;
    } catch (error) {
      if (hasStale) {
        return staleValue as T;
      }

      throw error;
    }
  })();

  inflight.set(key, task as Promise<unknown>);

  try {
    return await task;
  } finally {
    if (inflight.get(key) === task) {
      inflight.delete(key);
    }
  }
}

export const TTL = {
  quote: 60 * 1000, // 1 min
  candles: 10 * 60 * 1000, // 10 min (차트 캔들)
  news: 15 * 60 * 1000, // 15 min
  financials: 24 * 60 * 60 * 1000, // 24 h (rate-limit friendly)
  signals: 12 * 60 * 60 * 1000, // 12 h
  risk: 6 * 60 * 60 * 1000, // 6 h
  profile: 24 * 60 * 60 * 1000, // 24 h
  mapping: 24 * 60 * 60 * 1000, // 24 h (CIK / corp_code maps)
  market: 6 * 60 * 60 * 1000, // 6 h (full market listings)
} as const;
