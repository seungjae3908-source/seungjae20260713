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

// Bounded, retrying transport for Supabase reads. A pooled keep-alive socket
// that the remote side already closed can leave a GET hanging until the
// browser gives up (staging showed a single /api/auth/profile stalled for the
// full client deadline while neighbouring requests took <0.1s). Only
// idempotent GET/HEAD requests are bounded and retried once; writes are left
// untouched so a timeout can never duplicate a mutation.
const SUPABASE_READ_ATTEMPT_TIMEOUT_MS = 3_500;

export async function supabaseBoundedFetch(
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
	fetchImpl: typeof fetch = fetch,
	attemptTimeoutMs: number = SUPABASE_READ_ATTEMPT_TIMEOUT_MS,
): Promise<Response> {
	const method = String(init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
	if (method !== 'GET' && method !== 'HEAD') return fetchImpl(input, init);

	const callerSignal = init?.signal ?? undefined;
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		if (callerSignal?.aborted) throw callerSignal.reason ?? new DOMException('Aborted', 'AbortError');
		const attemptSignal = AbortSignal.timeout(attemptTimeoutMs);
		const signal = callerSignal ? AbortSignal.any([callerSignal, attemptSignal]) : attemptSignal;
		try {
			return await fetchImpl(input, { ...init, signal });
		} catch (error) {
			if (callerSignal?.aborted) throw error;
			lastError = error;
		}
	}
	throw lastError;
}

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
		global: { fetch: supabaseBoundedFetch },
		auth: {
			// Server context: no browser session persistence.
			persistSession: false,
			autoRefreshToken: false,
		},
	});

	return client;
}

export function getUserSupabase(accessToken: string): SupabaseClient {
	const url = process.env.SUPABASE_URL;
	const key = process.env.SUPABASE_ANON_KEY ?? serverKey();

	if (!url || !key || !accessToken) {
		throw new Error('User-scoped Supabase is not configured.');
	}

	return createClient(url, key, {
		global: {
			headers: { Authorization: `Bearer ${accessToken}` },
			fetch: supabaseBoundedFetch,
		},
		auth: {
			persistSession: false,
			autoRefreshToken: false,
		},
	});
}
