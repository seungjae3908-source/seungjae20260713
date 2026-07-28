import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

function serverKey(): string | undefined {
	return (
		process.env.SUPABASE_SECRET_KEY ??
		process.env.SUPABASE_SERVICE_ROLE_KEY
	);
}

export function isSupabaseConfigured(): boolean {
	return (
		Boolean(process.env.SUPABASE_URL) &&
		Boolean(serverKey() ?? process.env.SUPABASE_ANON_KEY)
	);
}

export function hasSupabaseServerKey(): boolean {
	return Boolean(process.env.SUPABASE_URL) && Boolean(serverKey());
}

export function getSupabase(): SupabaseClient {
	if (client) {
		return client;
	}

	const url = process.env.SUPABASE_URL;
	const key = serverKey() ?? process.env.SUPABASE_ANON_KEY;

	if (!url || !key) {
		throw new Error(
			'Supabase is not configured: set SUPABASE_URL and SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY.',
		);
	}

	client = createClient(url, key, {
		auth: {
			persistSession: false,
			autoRefreshToken: false,
		},
	});

	return client;
}

export function getPublicAuthSupabase(): SupabaseClient {
	const url = process.env.SUPABASE_URL;
	const key = process.env.SUPABASE_ANON_KEY;

	if (!url || !key) {
		throw new Error(
			'Public Supabase Auth is not configured: SUPABASE_URL and SUPABASE_ANON_KEY are required.',
		);
	}

	return createClient(url, key, {
		auth: {
			persistSession: false,
			autoRefreshToken: false,
		},
	});
}

export function getUserSupabase(accessToken: string): SupabaseClient {
	const url = process.env.SUPABASE_URL;
	const key = process.env.SUPABASE_ANON_KEY ?? serverKey();

	if (!url || !key || !accessToken) {
		throw new Error('User-scoped Supabase is not configured.');
	}

	return createClient(url, key, {
		global: {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		},
		auth: {
			persistSession: false,
			autoRefreshToken: false,
		},
	});
}