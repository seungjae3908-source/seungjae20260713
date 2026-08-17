import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';
import { getActiveQuerySignal } from '@/lib/query-abort-signal';
import {
  APP_API_REQUEST_TIMEOUT_MS,
  APP_API_SESSION_TIMEOUT_MS,
  withFiniteDeadline,
} from '@/lib/auth-bootstrap';

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
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

  const timeoutMs = options.timeoutMs === undefined
    ? APP_API_REQUEST_TIMEOUT_MS
    : options.timeoutMs;
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`invalid app API request timeout: ${timeoutMs}`);
  }

  const controller = new AbortController();
  const handleParentAbort = () => controller.abort(signal ? abortReason(signal) : undefined);
  signal?.addEventListener('abort', handleParentAbort, { once: true });
  const timeout = timeoutMs === null
    ? null
    : window.setTimeout(
      () => controller.abort(new DOMException('App API request timed out.', 'TimeoutError')),
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
    return await fetch(input, { ...init, headers, signal: controller.signal });
  } finally {
    if (timeout !== null) window.clearTimeout(timeout);
    signal?.removeEventListener('abort', handleParentAbort);
  }
}
