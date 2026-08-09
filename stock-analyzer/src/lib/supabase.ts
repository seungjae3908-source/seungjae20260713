// Supabase browser client (stock-analyzer frontend).
//
// Uses VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY, injected by Vite at
// build/dev time. The anon (publishable) key is designed to be public; data
// access is protected by Supabase Row Level Security policies.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AUTH_SESSION_BOOTSTRAP_TIMEOUT_MS } from '@/lib/auth-bootstrap';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);

let client: SupabaseClient | null = null;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

async function boundedSupabaseFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const parentSignal = init.signal;
  if (parentSignal?.aborted) throw abortReason(parentSignal);

  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal ? abortReason(parentSignal) : undefined);
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = globalThis.setTimeout(
    () => controller.abort(new DOMException('Supabase request timed out.', 'TimeoutError')),
    AUTH_SESSION_BOOTSTRAP_TIMEOUT_MS,
  );

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

/**
 * Returns the shared Supabase client. Throws an honest error when the
 * environment is not configured instead of returning a broken client.
 */
export function getSupabase(): SupabaseClient {
  if (client) return client;

  if (!url || !anonKey) {
    throw new Error(
      'Supabase가 설정되지 않았습니다: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 환경변수가 필요합니다.',
    );
  }

  client = createClient(url, anonKey, {
    global: { fetch: boundedSupabaseFetch },
  });
  return client;
}
