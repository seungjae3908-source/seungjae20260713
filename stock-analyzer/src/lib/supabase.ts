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
const memoryStorage = new Map<string, string>();

const resilientStorage = {
  getItem(key: string): string | null {
    try {
      return window.localStorage.getItem(key) ?? memoryStorage.get(key) ?? null;
    } catch {
      return memoryStorage.get(key) ?? null;
    }
  },
  setItem(key: string, value: string): void {
    memoryStorage.set(key, value);
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Keep the session for the current page even when browser storage is
      // temporarily unavailable (private mode, quota or WebView restrictions).
    }
  },
  removeItem(key: string): void {
    memoryStorage.delete(key);
    try {
      window.localStorage.removeItem(key);
    } catch {
      // The in-memory copy was already removed.
    }
  },
};

/**
 * Returns the shared Supabase client. Throws an honest error when the
 * environment is not configured instead of returning a broken client.
 */
export function getSupabase(): SupabaseClient {
  if (client) return client;

  if (!url || !anonKey) {
    throw new Error('로그인 서비스 연결 정보가 없습니다.');
  }

  client = createClient(url, anonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      storage: resilientStorage,
    },
    global: {
      headers: {
        'X-Client-Info': 'seungjae-stock-web',
      },
    },
  });
  return client;
}
