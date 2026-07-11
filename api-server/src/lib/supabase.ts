// Supabase server-side client (api-server).
//
// Uses SUPABASE_URL + SUPABASE_ANON_KEY from the environment. The anon
// (publishable) key is safe to use server-side for operations permitted by
// Row Level Security. If a service-role key is added later (SUPABASE_SERVICE_ROLE_KEY,
// keep it in Secrets — never expose it to the frontend), it takes precedence so
// the server can bypass RLS for trusted admin operations.
//
// The client is created lazily and memoized; callers get an honest error when
// Supabase is not configured instead of a silently broken client.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

function serverKey(): string | undefined {
	return process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
}

export function isSupabaseConfigured(): boolean {
	return Boolean(process.env.SUPABASE_URL) &&
		Boolean(serverKey() ?? process.env.SUPABASE_ANON_KEY);
}

// True when a secret (service) key is present — required for the RLS-locked
// tables (watchlist_items, market_cache) that have no anon policies.
export function hasSupabaseServerKey(): boolean {
	return Boolean(process.env.SUPABASE_URL) && Boolean(serverKey());
}

export function getSupabase(): SupabaseClient {
	if (client) return client;

	const url = process.env.SUPABASE_URL;
	const key = serverKey() ?? process.env.SUPABASE_ANON_KEY;

	if (!url || !key) {
		throw new Error(
			'Supabase is not configured: set SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY).',
		);
	}

	client = createClient(url, key, {
		auth: {
			// Server context: no browser session persistence.
			persistSession: false,
			autoRefreshToken: false,
		},
	});

	return client;
}
