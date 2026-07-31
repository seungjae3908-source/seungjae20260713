// Supabase browser client (stock-analyzer frontend).
//
// Uses VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY, injected by Vite at
// build/dev time. The anon (publishable) key is designed to be public; data
// access is protected by Supabase Row Level Security policies.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);

let client: SupabaseClient | null = null;

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

  client = createClient(url, anonKey);
  return client;
}
