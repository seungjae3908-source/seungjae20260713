import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';
import { getActiveQuerySignal } from '@/lib/query-abort-signal';
import {
  APP_API_REQUEST_TIMEOUT_MS,
  APP_API_SESSION_TIMEOUT_MS,
  withFiniteDeadline,
} from '@/lib/auth-bootstrap';
import { requireSpotCryptoTickerResponse } from '@/lib/crypto-ticker-response';
import {
  INVALID_PRICE_ALERT_RESPONSE,
  isPriceAlertResponsePath,
  normalizePriceAlertSuccessPayload,
} from '@/lib/price-alert-response';

// The stock Market Information backend intentionally returns a bounded partial
// first paint after 4 seconds. Keep the client transport guard outside that
// server budget so the browser cannot abort before the fail-closed fallback.
const MARKET_INFORMATION_REQUEST_TIMEOUT_MS = 6_000;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function requestPath(input: RequestInfo | URL): string {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  try {
    return new URL(raw, window.location.origin).pathname;
  } catch {
    return '';
  }
}

function requestMethod(input: RequestInfo | URL, init: RequestInit): string {
  if (init.method) return init.method.toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

function jsonResponseFrom(response: Response, payload: unknown): Response {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function validateInvestmentResponse(
  input: RequestInfo | URL,
  init: RequestInit,
  response: Response,
): Promise<Response> {
  if (!response.ok) return response;

  const path = requestPath(input);
  if (path.endsWith('/crypto/spot/tickers')) {
    try {
      requireSpotCryptoTickerResponse(await response.clone().json());
    } catch {
      throw new Error('INVALID_SPOT_CRYPTO_TICKER_RESPONSE');
    }
  }

  const method = requestMethod(input, init);
  if (isPriceAlertResponsePath(path, method)) {
    try {
      const payload = await response.clone().json();
      const normalized = normalizePriceAlertSuccessPayload(path, method, payload);
      return normalized === payload ? response : jsonResponseFrom(response, normalized);
    } catch {
      throw new Error(INVALID_PRICE_ALERT_RESPONSE);
    }
  }

  return response;
}

export type AuthorizedFetchOptions = {
  /**
   * Transport-level abort deadline. `undefined` preserves the normal app API
   * deadline; `null` deliberately leaves transport lifetime to the owning
   * request lifecycle. Authentication/session resolution has its own finite
   * deadline and does not consume this transport budget.
   */
  timeoutMs?: number | null;
};

/**
 * Calls an app API with the current Supabase access token.
 * Public/external URLs should continue to use the browser fetch directly.
 */
export async function authorizedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: AuthorizedFetchOptions = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const signal = init.signal ?? getActiveQuerySignal();
  if (signal?.aborted) throw abortReason(signal);

  const marketInformationRequest = requestPath(input).startsWith('/api/market-information/');
  const timeoutMs = options.timeoutMs === undefined
    ? marketInformationRequest
      ? MARKET_INFORMATION_REQUEST_TIMEOUT_MS
      : APP_API_REQUEST_TIMEOUT_MS
    : options.timeoutMs;
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`invalid app API request timeout: ${timeoutMs}`);
  }

  const controller = new AbortController();
  let timedOut = false;
  let timeout: number | null = null;
  const handleParentAbort = () => controller.abort(signal ? abortReason(signal) : undefined);
  signal?.addEventListener('abort', handleParentAbort, { once: true });

  try {
    if (isSupabaseConfigured && !headers.has('Authorization')) {
      const { data, error } = await withFiniteDeadline(
        getSupabase().auth.getSession(),
        APP_API_SESSION_TIMEOUT_MS,
        'APP_API_SESSION_TIMEOUT',
      );
      if (error) throw error;
      const token = data.session?.access_token;
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }

    if (controller.signal.aborted) throw abortReason(controller.signal);
    timeout = timeoutMs === null
      ? null
      : window.setTimeout(
        () => {
          timedOut = true;
          controller.abort(new DOMException('App API request timed out.', 'TimeoutError'));
        },
        timeoutMs,
      );

    try {
      const response = await fetch(input, { ...init, headers, signal: controller.signal });
      return await validateInvestmentResponse(input, init, response);
    } catch (error) {
      if (marketInformationRequest && timedOut && !signal?.aborted) {
        return new Response(JSON.stringify({
          errorCode: 'MARKET_INFORMATION_TIMEOUT',
          retryable: false,
          message: '시장정보 요청이 6초 내 완료되지 않았습니다.',
        }), {
          status: 408,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      throw error;
    }
  } finally {
    if (timeout !== null) window.clearTimeout(timeout);
    signal?.removeEventListener('abort', handleParentAbort);
  }
}
