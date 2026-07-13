import {
	createClient,
	type SupabaseClient,
} from '@supabase/supabase-js';

const supabaseUrl = String(
	import.meta.env.VITE_SUPABASE_URL ?? '',
).trim();

const supabaseAnonKey = String(
	import.meta.env.VITE_SUPABASE_ANON_KEY ?? '',
).trim();

export const isSupabaseConfigured = Boolean(
	supabaseUrl && supabaseAnonKey,
);

let supabaseClient: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
	if (!isSupabaseConfigured) {
		throw new Error(
			'Supabase 연결 정보가 없습니다. Replit Secrets에 VITE_SUPABASE_URL과 VITE_SUPABASE_ANON_KEY를 등록해 주세요.',
		);
	}

	if (!supabaseClient) {
		supabaseClient = createClient(
			supabaseUrl,
			supabaseAnonKey,
			{
				auth: {
					persistSession: true,
					autoRefreshToken: true,
					detectSessionInUrl: true,
				},
			},
		);
	}

	return supabaseClient;
}