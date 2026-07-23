import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';

export type MemberProfile = {
	id: string;
	login_name: string;
	display_name: string;
	role: 'user' | 'admin';
	status: 'pending' | 'approved' | 'rejected' | 'suspended' | 'withdrawn';
};

type AuthContextValue = {
	configured: boolean;
	loading: boolean;
	session: Session | null;
	user: User | null;
	profile: MemberProfile | null;
	displayName: string | null;
	isAdmin: boolean;
	isApproved: boolean;
	signIn(loginName: string, password: string): Promise<void>;
	signUp(loginName: string, password: string): Promise<void>;
	signOut(): Promise<void>;
	refreshProfile(): Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function normalizeName(value: string): string {
	return value.normalize('NFKC').trim().toLocaleLowerCase('ko-KR');
}

function validate(loginName: string, password: string): string {
	const name = loginName.normalize('NFKC').trim();

	if (name.length < 2 || name.length > 20) {
		throw new Error('아이디는 2~20자로 입력해 주세요.');
	}

	if (!/^[0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ._-]+$/u.test(name)) {
		throw new Error(
			'아이디에는 한글, 영문, 숫자, 마침표, 밑줄, 하이픈만 사용할 수 있습니다. 띄어쓰기는 사용할 수 없습니다.',
		);
	}

	if (password.length < 6 || password.length > 72) {
		throw new Error('비밀번호는 6~72자로 입력해 주세요.');
	}

	return name;
}

async function sha256Hex(value: string): Promise<string> {
	if (!globalThis.crypto?.subtle) {
		throw new Error(
			'브라우저 보안 기능을 사용할 수 없습니다. HTTPS 주소에서 앱을 다시 열어 주세요.',
		);
	}

	const source = new TextEncoder().encode(value);
	const digest = await globalThis.crypto.subtle.digest('SHA-256', source);

	return Array.from(new Uint8Array(digest))
		.map((item) => item.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * 현재 Supabase에 실제로 저장된 계정 규칙입니다.
 *
 * lsj2189 예:
 * 14b802762dfb6345fc058dfae6542d49223dd3ad@accounts.seungjae-stock.com
 *
 * 중요:
 * 앞에 "u-"가 붙지 않습니다.
 */
async function currentInternalEmail(loginName: string): Promise<string> {
	const normalized = normalizeName(loginName);
	const hash = await sha256Hex(`seungjae-stock-account:${normalized}`);
	return `${hash.slice(0, 40)}@accounts.seungjae-stock.com`;
}

/**
 * 개발 과정에서 사용했던 u- 접두사 규칙도 기존 계정 호환을 위해 확인합니다.
 */
async function prefixedInternalEmail(loginName: string): Promise<string> {
	const normalized = normalizeName(loginName);
	const hash = await sha256Hex(`seungjae-stock-account:${normalized}`);
	return `u-${hash.slice(0, 40)}@accounts.seungjae-stock.com`;
}

/**
 * 더 이전에 사용했던 stockapp.example.com 규칙도 로그인 호환을 위해 확인합니다.
 */
async function legacyInternalEmail(loginName: string): Promise<string> {
	const normalized = normalizeName(loginName);
	const hash = await sha256Hex(`seungjae-stock-app:${normalized}`);
	return `u_${hash.slice(0, 48)}@stockapp.example.com`;
}

function readErrorMessage(cause: unknown): string {
	if (cause instanceof Error && cause.message) {
		return cause.message;
	}

	if (typeof cause === 'object' && cause !== null && 'message' in cause) {
		const message = String(
			(cause as { message?: unknown }).message ?? '',
		).trim();

		if (message) return message;
	}

	if (typeof cause === 'string' && cause.trim()) {
		return cause.trim();
	}

	return '';
}

function authMessage(cause: unknown): string {
	const rawMessage = readErrorMessage(cause);
	const message = rawMessage.toLowerCase();

	if (
		message.includes('invalid login') ||
		message.includes('invalid credentials')
	) {
		return '아이디 또는 비밀번호가 맞지 않습니다.';
	}

	if (
		message.includes('user already registered') ||
		message.includes('already been registered') ||
		message.includes('already')
	) {
		return '이미 사용 중인 아이디입니다.';
	}

	if (message.includes('email not confirmed')) {
		return '이메일 확인 설정 때문에 로그인할 수 없습니다. 관리자에게 문의해 주세요.';
	}

	if (
		message.includes('signup is disabled') ||
		message.includes('signups not allowed')
	) {
		return '현재 신규 회원가입이 비활성화되어 있습니다.';
	}

	if (message.includes('rate limit')) {
		return '요청이 많습니다. 잠시 후 다시 시도해 주세요.';
	}

	return rawMessage || '계정 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.';
}

function isInvalidLoginError(cause: unknown): boolean {
	const message = readErrorMessage(cause).toLowerCase();

	return (
		message.includes('invalid login') ||
		message.includes('invalid credentials')
	);
}

export function AuthProvider({ children }: { children: ReactNode }) {
	const [session, setSession] = useState<Session | null>(null);
	const [profile, setProfile] = useState<MemberProfile | null>(null);
	const [loading, setLoading] = useState(isSupabaseConfigured);

	async function loadProfile(user: User | null): Promise<void> {
		if (!user) {
			setProfile(null);
			return;
		}

		const { data, error } = await getSupabase()
			.from('profiles')
			.select('id,login_name,display_name,role,status')
			.eq('id', user.id)
			.maybeSingle();

		if (error) {
			console.error('프로필 조회 실패:', error.message);
			setProfile(null);
			return;
		}

		setProfile((data as MemberProfile | null) ?? null);
	}

	useEffect(() => {
		if (!isSupabaseConfigured) {
			setLoading(false);
			return;
		}

		let mounted = true;

		void getSupabase()
			.auth.getSession()
			.then(async ({ data }) => {
				if (!mounted) return;

				setSession(data.session);
				await loadProfile(data.session?.user ?? null);

				if (mounted) setLoading(false);
			})
			.catch((error: unknown) => {
				console.error('로그인 세션 확인 실패:', error);
				if (mounted) setLoading(false);
			});

		const { data: subscriptionData } = getSupabase().auth.onAuthStateChange(
			(_event, nextSession) => {
				setSession(nextSession);

				void loadProfile(nextSession?.user ?? null).finally(() => {
					if (mounted) setLoading(false);
				});
			},
		);

		return () => {
			mounted = false;
			subscriptionData.subscription.unsubscribe();
		};
	}, []);

	const value = useMemo<AuthContextValue>(
		() => ({
			configured: isSupabaseConfigured,
			loading,
			session,
			user: session?.user ?? null,
			profile,
			displayName:
				profile?.display_name ??
				(session?.user?.user_metadata?.display_name as string | undefined) ??
				null,
			isAdmin: profile?.status === 'approved' && profile.role === 'admin',
			isApproved: profile?.status === 'approved',

			async signIn(loginName, password) {
				const name = validate(loginName, password);
				const supabase = getSupabase();

				const candidateEmails = [
					await currentInternalEmail(name),
					await prefixedInternalEmail(name),
					await legacyInternalEmail(name),
				];

				let lastError: unknown = null;

				for (const email of candidateEmails) {
					const result = await supabase.auth.signInWithPassword({
						email,
						password,
					});

					if (!result.error) {
						return;
					}

					lastError = result.error;

					if (!isInvalidLoginError(result.error)) {
						throw new Error(authMessage(result.error));
					}
				}

				throw new Error(authMessage(lastError));
			},

			async signUp(loginName, password) {
				const name = validate(loginName, password);
				const normalized = normalizeName(name);

				// 신규 회원도 현재 실제 계정 규칙으로 생성합니다.
				const email = await currentInternalEmail(normalized);

				const { data, error } = await getSupabase().auth.signUp({
					email,
					password,
					options: {
						data: {
							display_name: name,
							login_name: normalized,
						},
					},
				});

				if (error || data.user?.identities?.length === 0) {
					throw new Error(authMessage(error ?? new Error('already')));
				}
			},

			async signOut() {
				const { error } = await getSupabase().auth.signOut();

				if (error) {
					throw new Error(authMessage(error));
				}
			},

			async refreshProfile() {
				await loadProfile(session?.user ?? null);
			},
		}),
		[loading, profile, session],
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
	const value = useContext(AuthContext);

	if (!value) {
		throw new Error('useAuth는 AuthProvider 안에서 사용해야 합니다.');
	}

	return value;
}