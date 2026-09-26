export type TimedCacheEntry<T> = {
  expiresAt: number;
  value: T;
};

export class BoundedTtlCache {
  private readonly entries = new Map<string, TimedCacheEntry<unknown>>();

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('BOUNDED_TTL_CACHE_MAX_ENTRIES_INVALID');
    }
  }

  private pruneExpired(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) this.entries.delete(key);
    }
  }

  private trimToBound(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
  }

  async getOrLoad<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    const nowMs = this.now();
    this.pruneExpired(nowMs);

    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > nowMs) {
      // Refresh insertion order so capacity eviction behaves as bounded LRU
      // without extending the original TTL.
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.value as T;
    }

    if (cached) this.entries.delete(key);

    const value = await loader();
    const safeTtlMs = Number.isFinite(ttlMs) ? Math.max(0, ttlMs) : 0;
    this.entries.set(key, {
      expiresAt: this.now() + safeTtlMs,
      value,
    });
    this.pruneExpired(this.now());
    this.trimToBound();
    return value;
  }

  get size(): number {
    return this.entries.size;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }
}
