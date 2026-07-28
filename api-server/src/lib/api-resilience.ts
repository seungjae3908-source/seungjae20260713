export type ApiProvider =
  | 'kiwoom'
  | 'naver'
  | 'yahoo'
  | 'bitget'
  | 'upbit'
  | 'supabase'
  | string;

export type ResilientCallOptions<T> = {
  provider: ApiProvider;
  key: string;
  operation: () => Promise<T>;
  timeoutMs?: number;
  retries?: number;
  retryBaseDelayMs?: number;
  cacheTtlMs?: number;
  staleTtlMs?: number;
  circuitFailureThreshold?: number;
  circuitResetMs?: number;
  validate?: (value: T) => boolean;
};

export type ResilientCallResult<T> = {
  value: T;
  provider: ApiProvider;
  source: 'live' | 'cache' | 'stale-cache';
  isStale: boolean;
  fetchedAt: string;
  staleAgeMs: number;
};

type CacheEntry<T> = {
  value: T;
  fetchedAtMs: number;
  expiresAtMs: number;
  staleUntilMs: number;
};

type CircuitState = {
  failures: number;
  openedAtMs: number | null;
  lastError: string | null;
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
};

type ProviderStats = {
  calls: number;
  successes: number;
  failures: number;
  cacheHits: number;
  staleHits: number;
  lastLatencyMs: number | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
};

export class ApiResilienceError extends Error {
  readonly code: string;
  readonly provider: ApiProvider;
  readonly retryable: boolean;

  constructor(input: {
    code: string;
    provider: ApiProvider;
    message: string;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'ApiResilienceError';
    this.code = input.code;
    this.provider = input.provider;
    this.retryable = input.retryable ?? true;
  }
}

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<ResilientCallResult<unknown>>>();
const circuits = new Map<ApiProvider, CircuitState>();
const stats = new Map<ApiProvider, ProviderStats>();

function nowIso(value = Date.now()): string {
  return new Date(value).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'UNKNOWN_API_ERROR');
}

function makeCacheKey(provider: ApiProvider, key: string): string {
  return `${provider}:${key}`;
}

function getCircuit(provider: ApiProvider): CircuitState {
  const existing = circuits.get(provider);
  if (existing) return existing;

  const created: CircuitState = {
    failures: 0,
    openedAtMs: null,
    lastError: null,
    lastSuccessAtMs: null,
    lastFailureAtMs: null,
  };
  circuits.set(provider, created);
  return created;
}

function getStats(provider: ApiProvider): ProviderStats {
  const existing = stats.get(provider);
  if (existing) return existing;

  const created: ProviderStats = {
    calls: 0,
    successes: 0,
    failures: 0,
    cacheHits: 0,
    staleHits: 0,
    lastLatencyMs: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
  };
  stats.set(provider, created);
  return created;
}

async function withTimeout<T>(
  provider: ApiProvider,
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new ApiResilienceError({
              code: 'API_UPSTREAM_TIMEOUT',
              provider,
              message: `${provider} 응답 제한시간 ${timeoutMs}ms를 초과했습니다.`,
              retryable: true,
            }),
          );
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readCache<T>(
  provider: ApiProvider,
  key: string,
  allowStale: boolean,
): ResilientCallResult<T> | null {
  const entry = cache.get(makeCacheKey(provider, key)) as CacheEntry<T> | undefined;
  if (!entry) return null;

  const now = Date.now();
  const isFresh = now <= entry.expiresAtMs;
  const isStaleUsable = allowStale && now <= entry.staleUntilMs;
  if (!isFresh && !isStaleUsable) {
    cache.delete(makeCacheKey(provider, key));
    return null;
  }

  const providerStats = getStats(provider);
  if (isFresh) providerStats.cacheHits += 1;
  else providerStats.staleHits += 1;

  return {
    value: entry.value,
    provider,
    source: isFresh ? 'cache' : 'stale-cache',
    isStale: !isFresh,
    fetchedAt: nowIso(entry.fetchedAtMs),
    staleAgeMs: Math.max(0, now - entry.fetchedAtMs),
  };
}

function writeCache<T>(
  provider: ApiProvider,
  key: string,
  value: T,
  cacheTtlMs: number,
  staleTtlMs: number,
): void {
  if (cacheTtlMs <= 0 && staleTtlMs <= 0) return;

  const now = Date.now();
  cache.set(makeCacheKey(provider, key), {
    value,
    fetchedAtMs: now,
    expiresAtMs: now + Math.max(0, cacheTtlMs),
    staleUntilMs: now + Math.max(cacheTtlMs, staleTtlMs),
  });
}

function isCircuitOpen(provider: ApiProvider, resetMs: number): boolean {
  const circuit = getCircuit(provider);
  if (circuit.openedAtMs === null) return false;

  if (Date.now() - circuit.openedAtMs >= resetMs) {
    circuit.openedAtMs = null;
    circuit.failures = 0;
    return false;
  }

  return true;
}

function markSuccess(provider: ApiProvider, latencyMs: number): void {
  const circuit = getCircuit(provider);
  circuit.failures = 0;
  circuit.openedAtMs = null;
  circuit.lastError = null;
  circuit.lastSuccessAtMs = Date.now();

  const providerStats = getStats(provider);
  providerStats.successes += 1;
  providerStats.lastLatencyMs = latencyMs;
  providerStats.lastSuccessAt = nowIso();
  providerStats.lastError = null;
}

function markFailure(
  provider: ApiProvider,
  error: unknown,
  threshold: number,
  latencyMs: number,
): void {
  const message = errorMessage(error);
  const circuit = getCircuit(provider);
  circuit.failures += 1;
  circuit.lastError = message;
  circuit.lastFailureAtMs = Date.now();
  if (circuit.failures >= threshold) circuit.openedAtMs = Date.now();

  const providerStats = getStats(provider);
  providerStats.failures += 1;
  providerStats.lastLatencyMs = latencyMs;
  providerStats.lastFailureAt = nowIso();
  providerStats.lastError = message;
}

export async function resilientCall<T>(
  options: ResilientCallOptions<T>,
): Promise<ResilientCallResult<T>> {
  const timeoutMs = Math.max(250, options.timeoutMs ?? 5_000);
  const retries = Math.max(0, options.retries ?? 2);
  const retryBaseDelayMs = Math.max(10, options.retryBaseDelayMs ?? 200);
  const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 0);
  const staleTtlMs = Math.max(cacheTtlMs, options.staleTtlMs ?? cacheTtlMs);
  const circuitFailureThreshold = Math.max(1, options.circuitFailureThreshold ?? 5);
  const circuitResetMs = Math.max(1_000, options.circuitResetMs ?? 30_000);
  const requestKey = makeCacheKey(options.provider, options.key);
  const providerStats = getStats(options.provider);

  const fresh = readCache<T>(options.provider, options.key, false);
  if (fresh) return fresh;

  const existing = inflight.get(requestKey) as Promise<ResilientCallResult<T>> | undefined;
  if (existing) return existing;

  const task = (async (): Promise<ResilientCallResult<T>> => {
    providerStats.calls += 1;

    if (isCircuitOpen(options.provider, circuitResetMs)) {
      const stale = readCache<T>(options.provider, options.key, true);
      if (stale) return stale;
      throw new ApiResilienceError({
        code: 'API_CIRCUIT_OPEN',
        provider: options.provider,
        message: `${options.provider} 제공처가 연속 실패하여 잠시 차단되었습니다.`,
        retryable: true,
      });
    }

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const startedAt = Date.now();
      try {
        const value = await withTimeout(options.provider, options.operation, timeoutMs);
        if (options.validate && !options.validate(value)) {
          throw new ApiResilienceError({
            code: 'API_RESPONSE_INVALID',
            provider: options.provider,
            message: `${options.provider} 응답 검증에 실패했습니다.`,
            retryable: true,
          });
        }

        const latencyMs = Date.now() - startedAt;
        markSuccess(options.provider, latencyMs);
        writeCache(options.provider, options.key, value, cacheTtlMs, staleTtlMs);

        return {
          value,
          provider: options.provider,
          source: 'live',
          isStale: false,
          fetchedAt: nowIso(),
          staleAgeMs: 0,
        };
      } catch (error) {
        lastError = error;
        markFailure(
          options.provider,
          error,
          circuitFailureThreshold,
          Date.now() - startedAt,
        );

        if (attempt < retries) {
          const delayMs = retryBaseDelayMs * 2 ** attempt;
          await sleep(delayMs);
        }
      }
    }

    const stale = readCache<T>(options.provider, options.key, true);
    if (stale) return stale;

    throw new ApiResilienceError({
      code: 'API_PROVIDER_UNAVAILABLE',
      provider: options.provider,
      message: `${options.provider} 제공처 호출에 실패했습니다: ${errorMessage(lastError)}`,
      retryable: true,
      cause: lastError,
    });
  })();

  inflight.set(requestKey, task as Promise<ResilientCallResult<unknown>>);
  try {
    return await task;
  } finally {
    inflight.delete(requestKey);
  }
}

export function getApiResilienceSnapshot(): {
  cacheEntries: number;
  inflightRequests: number;
  providers: Array<{
    provider: ApiProvider;
    circuit: {
      state: 'closed' | 'open';
      failures: number;
      openedAt: string | null;
      lastSuccessAt: string | null;
      lastFailureAt: string | null;
      lastError: string | null;
    };
    stats: ProviderStats;
  }>;
} {
  const providers = new Set<ApiProvider>([
    ...circuits.keys(),
    ...stats.keys(),
  ]);

  return {
    cacheEntries: cache.size,
    inflightRequests: inflight.size,
    providers: [...providers].map((provider) => {
      const circuit = getCircuit(provider);
      return {
        provider,
        circuit: {
          state: circuit.openedAtMs === null ? 'closed' : 'open',
          failures: circuit.failures,
          openedAt: circuit.openedAtMs ? nowIso(circuit.openedAtMs) : null,
          lastSuccessAt: circuit.lastSuccessAtMs ? nowIso(circuit.lastSuccessAtMs) : null,
          lastFailureAt: circuit.lastFailureAtMs ? nowIso(circuit.lastFailureAtMs) : null,
          lastError: circuit.lastError,
        },
        stats: getStats(provider),
      };
    }),
  };
}

export function clearApiResilienceCache(provider?: ApiProvider): number {
  let removed = 0;
  for (const key of cache.keys()) {
    if (!provider || key.startsWith(`${provider}:`)) {
      cache.delete(key);
      removed += 1;
    }
  }
  return removed;
}
