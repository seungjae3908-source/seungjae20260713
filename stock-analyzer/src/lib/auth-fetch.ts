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

/**
 * Calls an app API with the current Supabase access token.
 * Public/external URLs should continue to use the browser fetch directly.
 */
export async function authorizedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const parentSignal = init.signal ?? getActiveQuerySignal();
  if (parentSignal?.aborted) throw abortReason(parentSignal);

  const controller = new AbortController();
  const handleParentAbort = () => controller.abort(parentSignal ? abortReason(parentSignal) : undefined);
  parentSignal?.addEventListener('abort', handleParentAbort, { once: true });
  const timeout = window.setTimeout(
    () => controller.abort(new DOMException('App API request timed out.', 'TimeoutError')),
    APP_API_REQUEST_TIMEOUT_MS,
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
    window.clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', handleParentAbort);
  }
}
