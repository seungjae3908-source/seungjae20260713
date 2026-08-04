type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type SleepLike = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
type CacheEntry<T> = { value: T; freshUntil: number; staleUntil: number };
export type MarketInformationCacheLoad<T> = { value: T; stale: boolean };

const UPBIT_BASE = 'https://api.upbit.com';
const BITGET_BASE = 'https://api.bitget.com';
const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

export class MarketInformationError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'MarketInformationError';
  }
}

function abortError(): Error {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

const defaultSleep: SleepLike = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(abortError());
    return;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, milliseconds);
  const onAbort = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    reject(abortError());
  };
  signal?.addEventListener('abort', onAbort, { once: true });
});

export function validatePublicMarketUrl(value: string | URL): URL {
  const url = value instanceof URL ? value : new URL(value);
  const upbitAllowed = url.origin === UPBIT_BASE
    && (url.pathname === '/v1/market/all' || url.pathname === '/v1/ticker');
  const bitgetAllowed = url.origin === BITGET_BASE
    && (url.pathname.startsWith('/api/v2/mix/market/') || url.pathname.startsWith('/api/v3/market/'));
  if (!upbitAllowed && !bitgetAllowed) {
    throw new MarketInformationError(
      'PUBLIC_MARKET_URL_BLOCKED',
      500,
      false,
      '허용되지 않은 외부 시장정보 URL입니다.',
    );
  }
  return url;
}

function retryDelay(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get('retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5_000, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(5_000, Math.max(0, date - Date.now()));
  }
  return Math.min(2_000, 250 * (2 ** attempt) + Math.floor(Math.random() * 150));
}

export async function fetchPublicMarketJson(
  value: string | URL,
  options: {
    provider: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    sleepImpl?: SleepLike;
  },
): Promise<unknown> {
  const url = validatePublicMarketUrl(value);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 8_000;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (options.signal?.aborted) throw abortError();
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason ?? abortError());
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | null = null;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'seungjae-market-information/1.0',
        },
        signal: controller.signal,
      });
      const retryableStatus = response.status === 429
        || response.status === 500
        || response.status === 502
        || response.status === 503
        || response.status === 504;
      if (!response.ok) {
        if (retryableStatus && attempt === 0) {
          await sleepImpl(retryDelay(response, attempt), options.signal);
          continue;
        }
        throw new MarketInformationError(
          response.status === 429 ? 'UPSTREAM_RATE_LIMITED' : `UPSTREAM_HTTP_${response.status}`,
          response.status,
          retryableStatus,
          response.status === 429
            ? `${options.provider} 호출 한도에 도달했습니다.`
            : `${options.provider} 응답 오류입니다.`,
        );
      }

      const text = await response.text();
      if (!text.trim()) {
        throw new MarketInformationError('UPSTREAM_EMPTY_BODY', 502, true, `${options.provider} 응답 본문이 비어 있습니다.`);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        throw new MarketInformationError('UPSTREAM_INVALID_JSON', 502, true, `${options.provider} JSON 응답을 해석할 수 없습니다.`);
      }
      const objectPayload = payload && typeof payload === 'object';
      if (!objectPayload) {
        throw new MarketInformationError('UPSTREAM_PRIMITIVE_PAYLOAD', 502, false, `${options.provider} 응답 형식이 객체 또는 배열이 아닙니다.`);
      }
      if (!Array.isArray(payload) && Object.keys(payload as Record<string, unknown>).length === 0) {
        throw new MarketInformationError('UPSTREAM_EMPTY_OBJECT', 502, false, `${options.provider} 응답 객체가 비어 있습니다.`);
      }
      return payload;
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      if (error instanceof MarketInformationError) {
        if (error.retryable && attempt === 0) {
          await sleepImpl(retryDelay(response, attempt), options.signal);
          continue;
        }
        throw error;
      }
      const timedOut = controller.signal.aborted;
      if (attempt === 0) {
        await sleepImpl(retryDelay(response, attempt), options.signal);
        continue;
      }
      throw new MarketInformationError(
        timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_NETWORK_ERROR',
        timedOut ? 504 : 502,
        true,
        timedOut
          ? `${options.provider} 응답 시간이 초과되었습니다.`
          : `${options.provider} 네트워크 연결에 실패했습니다.`,
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  throw new MarketInformationError(
    'UPSTREAM_RETRY_EXHAUSTED',
    502,
    true,
    `${options.provider} 재시도 후에도 응답하지 않았습니다.`,
  );
}

export async function loadMarketInformationCache<T>(
  key: string,
  ttlMs: number,
  staleMs: number,
  loader: () => Promise<T>,
): Promise<MarketInformationCacheLoad<T>> {
  const now = Date.now();
  const existing = cache.get(key) as CacheEntry<T> | undefined;
  if (existing && existing.freshUntil > now) return { value: existing.value, stale: false };

  const refresh = () => {
    const running = inFlight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const promise = loader()
      .then((value) => {
        const savedAt = Date.now();
        cache.set(key, {
          value,
          freshUntil: savedAt + ttlMs,
          staleUntil: savedAt + ttlMs + staleMs,
        });
        return value;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, promise as Promise<unknown>);
    return promise;
  };

  if (existing && existing.staleUntil > now) {
    void refresh().catch(() => undefined);
    return { value: existing.value, stale: true };
  }

  try {
    return { value: await refresh(), stale: false };
  } catch (error) {
    if (existing) return { value: existing.value, stale: true };
    throw error;
  }
}

export function resetMarketInformationCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
