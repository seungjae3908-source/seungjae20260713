/**
 * Scanner request coalescing and last-good observations belong to a single
 * authenticated browser member, not merely a shared URL. Never use access
 * tokens or other credentials as in-memory cache keys.
 */
export function scannerSessionCacheKey(url: string, memberId: string | null | undefined): string {
  return JSON.stringify([typeof memberId === 'string' && memberId.trim() ? memberId.trim() : 'UNAUTHENTICATED', url]);
}

export class ScannerBoundedLastGoodCache<T> {
  private readonly rows = new Map<string, { value: T; storedAt: number }>();

  constructor(
    private readonly maxEntries = 64,
    private readonly maxAgeMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
      throw new Error('SCANNER_CACHE_BOUNDS_INVALID');
    }
  }

  get(key: string): T | undefined {
    const cached = this.rows.get(key);
    if (!cached) return undefined;
    const age = this.now() - cached.storedAt;
    if (!Number.isFinite(age) || age < 0 || age > this.maxAgeMs) {
      this.rows.delete(key);
      return undefined;
    }
    // Refresh LRU ordering; never modify cached provider truth.
    this.rows.delete(key);
    this.rows.set(key, cached);
    return cached.value;
  }

  set(key: string, value: T): void {
    this.rows.delete(key);
    this.rows.set(key, { value, storedAt: this.now() });
    while (this.rows.size > this.maxEntries) {
      const oldest = this.rows.keys().next().value;
      if (oldest === undefined) break;
      this.rows.delete(oldest);
    }
  }
}
