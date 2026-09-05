import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';
import { getActiveQuerySignal } from '@/lib/query-abort-signal';
import {
  APP_API_REQUEST_TIMEOUT_MS,
  APP_API_SESSION_TIMEOUT_MS,
  withFiniteDeadline,
} from '@/lib/auth-bootstrap';

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

export type AuthorizedFetchOptions = {
  /**
   * Transport-level abort deadline. `undefined` preserves the normal app API
   * deadline; `null` deliberately leaves transport lifetime to the owning
   * request lifecycle.
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
  const handleParentAbort = () => controller.abort(signal ? abortReason(signal) : undefined);
  signal?.addEventListener('abort', handleParentAbort, { once: true });
  const timeout = timeoutMs === null
    ? null
    : window.setTimeout(
      () => {
        timedOut = true;
        controller.abort(new DOMException('App API request timed out.', 'TimeoutError'));
      },
      timeoutMs,
    );

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
    try {
      return await fetch(input, { ...init, headers, signal: controller.signal });
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
