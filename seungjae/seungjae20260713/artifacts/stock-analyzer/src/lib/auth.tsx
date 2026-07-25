import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from 'react';

import type {
	User,
} from '@supabase/supabase-js';

import {
	getSupabase,
	isSupabaseConfigured,
} from '@/lib/supabase';

interface AuthContextValue {
	configured: boolean;
	loading: boolean;
	user: User | null;
	displayName: string | null;

	signUp: (
		loginName: string,
		password: string,
	) => Promise<void>;

	signIn: (
		loginName: string,
		password: string,
	) => Promise<void>;

	signOut: () => Promise<void>;
}

const AuthContext =
	createContext<AuthContextValue | null>(
		null,
	);

function normalizeLoginName(
	value: string,
): string {
	return value
		.normalize('NFKC')
		.trim();
}

function validateLoginName(
	value: string,
): string {
	const cleanName =
		normalizeLoginName(value);

	if (cleanName.length < 2) {
		throw new Error(
			'이름은 2자 이상 입력해 주세요.',
		);
	}

	if (cleanName.length > 20) {
		throw new Error(
			'이름은 20자 이하로 입력해 주세요.',
		);
	}

	const allowedPattern =
		/^[0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ._-]+$/u;

	if (!allowedPattern.test(cleanName)) {
		throw new Error(
			'이름에는 한글, 영문, 숫자, 마침표, 밑줄, 하이픈만 사용할 수 있습니다. 띄어쓰기는 사용할 수 없습니다.',
		);
	}

	return cleanName;
}

function validatePassword(
	password: string,
): void {
	if (password.length < 6) {
		throw new Error(
			'비밀번호는 6자 이상 입력해 주세요.',
		);
	}

	if (password.length > 72) {
		throw new Error(
			'비밀번호는 72자 이하로 입력해 주세요.',
		);
	}
}

/**
 * 사용자가 입력한 이름을 Supabase에서 사용할 수 있는
 * 고정된 내부 이메일 주소로 변환한다.
 *
 * 예:
 * 승재 -> u_해시값@stockapp.example.com
 *
 * 이름 자체는 user_metadata에 별도로 저장된다.
 */
async function loginNameToEmail(
	loginName: string,
): Promise<string> {
	const normalizedName =
		normalizeLoginName(loginName)
			.toLocaleLowerCase('ko-KR');

	if (!globalThis.crypto?.subtle) {
		throw new Error(
			'브라우저 보안 기능을 사용할 수 없습니다. HTTPS 주소에서 앱을 다시 열어 주세요.',
		);
	}

	const encoder =
		new TextEncoder();

	const input =
		encoder.encode(
			`seungjae-stock-app:${normalizedName}`,
		);

	const digest =
		await globalThis.crypto.subtle.digest(
			'SHA-256',
			input,
		);

	const hash =
		Array.from(
			new Uint8Array(digest),
		)
			.map((value) =>
				value
					.toString(16)
					.padStart(2, '0'),
			)
			.join('');

	return `u_${hash.slice(0, 48)}@stockapp.example.com`;
}

function readErrorMessage(
	cause: unknown,
): string {
	if (
		cause instanceof Error &&
		cause.message
	) {
		return cause.message;
	}

	if (
		typeof cause === 'object' &&
		cause !== null &&
		'message' in cause
	) {
		const message =
			String(
				(
					cause as {
						message?: unknown;
					}
				).message ?? '',
			).trim();

		if (message) {
			return message;
		}
	}

	if (
		typeof cause === 'string' &&
		cause.trim()
	) {
		return cause.trim();
	}

	return '';
}

function createAuthError(
	cause: unknown,
	fallbackMessage: string,
): Error {
	const rawMessage =
		readErrorMessage(cause);

	const lowerMessage =
		rawMessage.toLowerCase();

	let friendlyMessage =
		rawMessage || fallbackMessage;

	if (
		lowerMessage.includes(
			'user already registered',
		) ||
		lowerMessage.includes(
			'already been registered',
		)
	) {
		friendlyMessage =
			'이미 사용 중인 이름입니다. 다른 이름을 입력해 주세요.';
	} else if (
		lowerMessage.includes(
			'invalid login credentials',
		)
	) {
		friendlyMessage =
			'이름 또는 비밀번호가 올바르지 않습니다.';
	} else if (
		lowerMessage.includes(
			'email not confirmed',
		)
	) {
		friendlyMessage =
			'Supabase의 이메일 확인 설정이 켜져 있습니다. Supabase에서 Confirm Email을 꺼 주세요.';
	} else if (
		lowerMessage.includes(
			'signup is disabled',
		) ||
		lowerMessage.includes(
			'signups not allowed',
		)
	) {
		friendlyMessage =
			'Supabase에서 신규 계정 등록이 꺼져 있습니다. Email 회원가입을 켜 주세요.';
	} else if (
		lowerMessage.includes(
			'password should be at least',
		) ||
		lowerMessage.includes(
			'password is too short',
		)
	) {
		friendlyMessage =
			'비밀번호가 너무 짧습니다. 6자 이상 입력해 주세요.';
	} else if (
		lowerMessage.includes(
			'rate limit',
		) ||
		lowerMessage.includes(
			'too many requests',
		)
	) {
		friendlyMessage =
			'계정 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
	} else if (
		lowerMessage.includes(
			'failed to fetch',
		) ||
		lowerMessage.includes(
			'network',
		)
	) {
		friendlyMessage =
			'Supabase 서버에 연결하지 못했습니다. 인터넷 연결과 Supabase URL을 확인해 주세요.';
	} else if (
		lowerMessage.includes(
			'invalid api key',
		) ||
		lowerMessage.includes(
			'apikey',
		)
	) {
		friendlyMessage =
			'Supabase API 키가 올바르지 않습니다. VITE_SUPABASE_ANON_KEY를 확인해 주세요.';
	}

	console.error(
		'Supabase 인증 오류:',
		cause,
	);

	if (
		rawMessage &&
		friendlyMessage !== rawMessage
	) {
		return new Error(
			`${friendlyMessage} (${rawMessage})`,
		);
	}

	return new Error(
		friendlyMessage,
	);
}

export function AuthProvider({
	children,
}: {
	children: ReactNode;
}) {
	const [
		user,
		setUser,
	] =
		useState<User | null>(
			null,
		);

	const [
		loading,
		setLoading,
	] =
		useState(
			isSupabaseConfigured,
		);

	useEffect(() => {
		if (!isSupabaseConfigured) {
			setUser(null);
			setLoading(false);
			return;
		}

		const supabase =
			getSupabase();

		let active = true;

		void supabase.auth
			.getSession()
			.then(
				({
					data,
					error,
				}) => {
					if (!active) {
						return;
					}

					if (error) {
						console.error(
							'로그인 상태 확인 오류:',
							error,
						);

						setUser(null);
					} else {
						setUser(
							data.session?.user ??
								null,
						);
					}

					setLoading(false);
				},
			)
			.catch((cause) => {
				if (!active) {
					return;
				}

				console.error(
					'로그인 상태 확인 실패:',
					cause,
				);

				setUser(null);
				setLoading(false);
			});

		const {
			data: {
				subscription,
			},
		} =
			supabase.auth.onAuthStateChange(
				(
					_event,
					session,
				) => {
					if (!active) {
						return;
					}

					setUser(
						session?.user ??
							null,
					);

					setLoading(false);
				},
			);

		return () => {
			active = false;
			subscription.unsubscribe();
		};
	}, []);

	const signUp =
		useCallback(
			async (
				loginName: string,
				password: string,
			) => {
				if (!isSupabaseConfigured) {
					throw new Error(
						'Supabase 연결 설정이 필요합니다.',
					);
				}

				const cleanName =
					validateLoginName(
						loginName,
					);

				validatePassword(
					password,
				);

				const email =
					await loginNameToEmail(
						cleanName,
					);

				const supabase =
					getSupabase();

				try {
					const {
						data,
						error,
					} =
						await supabase.auth.signUp(
							{
								email,
								password,

								options: {
									data: {
										display_name:
											cleanName,

										login_name:
											cleanName,
									},
								},
							},
						);

					if (error) {
						throw error;
					}

					if (!data.user) {
						throw new Error(
							'Supabase에서 사용자 정보가 반환되지 않았습니다.',
						);
					}

					/**
					 * Confirm Email이 켜져 있으면
					 * user는 생성되지만 session은 null이 된다.
					 */
					if (!data.session) {
						throw new Error(
							'계정은 생성됐지만 자동 로그인이 되지 않았습니다. Supabase Dashboard의 Authentication → Providers → Email에서 Confirm Email을 꺼 주세요.',
						);
					}

					setUser(
						data.user,
					);
				} catch (cause) {
					throw createAuthError(
						cause,
						'계정 등록에 실패했습니다.',
					);
				}
			},
			[],
		);

	const signIn =
		useCallback(
			async (
				loginName: string,
				password: string,
			) => {
				if (!isSupabaseConfigured) {
					throw new Error(
						'Supabase 연결 설정이 필요합니다.',
					);
				}

				const cleanName =
					validateLoginName(
						loginName,
					);

				validatePassword(
					password,
				);

				const email =
					await loginNameToEmail(
						cleanName,
					);

				const supabase =
					getSupabase();

				try {
					const {
						data,
						error,
					} =
						await supabase.auth
							.signInWithPassword(
								{
									email,
									password,
								},
							);

					if (error) {
						throw error;
					}

					if (!data.user) {
						throw new Error(
							'로그인 사용자 정보가 반환되지 않았습니다.',
						);
					}

					setUser(
						data.user,
					);
				} catch (cause) {
					throw createAuthError(
						cause,
						'로그인에 실패했습니다.',
					);
				}
			},
			[],
		);

	const signOut =
		useCallback(
			async () => {
				if (!isSupabaseConfigured) {
					setUser(null);
					return;
				}

				const supabase =
					getSupabase();

				try {
					const {
						error,
					} =
						await supabase.auth.signOut();

					if (error) {
						throw error;
					}

					setUser(null);
				} catch (cause) {
					throw createAuthError(
						cause,
						'로그아웃에 실패했습니다.',
					);
				}
			},
			[],
		);

	const displayName =
		useMemo(() => {
			if (!user) {
				return null;
			}

			const metadataName =
				user.user_metadata
					?.display_name;

			if (
				typeof metadataName ===
					'string' &&
				metadataName.trim()
			) {
				return metadataName.trim();
			}

			const loginName =
				user.user_metadata
					?.login_name;

			if (
				typeof loginName ===
					'string' &&
				loginName.trim()
			) {
				return loginName.trim();
			}

			return null;
		}, [user]);

	const value =
		useMemo<AuthContextValue>(
			() => ({
				configured:
					isSupabaseConfigured,

				loading,
				user,
				displayName,
				signUp,
				signIn,
				signOut,
			}),
			[
				loading,
				user,
				displayName,
				signUp,
				signIn,
				signOut,
			],
		);

	return (
		<AuthContext.Provider
			value={value}
		>
			{children}
		</AuthContext.Provider>
	);
}

export function useAuth(): AuthContextValue {
	const context =
		useContext(
			AuthContext,
		);

	if (!context) {
		throw new Error(
			'useAuth는 AuthProvider 안에서 사용해야 합니다.',
		);
	}

	return context;
}