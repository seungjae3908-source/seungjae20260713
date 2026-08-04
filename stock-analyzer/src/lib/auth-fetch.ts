import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';
import { getActiveQuerySignal } from '@/lib/query-abort-signal';

/**
 * Calls an app API with the current Supabase access token.
 * Public/external URLs should continue to use the browser fetch directly.
 */
export async function authorizedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const signal = init.signal ?? getActiveQuerySignal();

  if (isSupabaseConfigured && !headers.has('Authorization')) {
    const { data } = await getSupabase().auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  return fetch(input, { ...init, headers, signal });
}
