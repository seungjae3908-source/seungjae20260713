import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type {
  Session,
  User,
} from '@supabase/supabase-js';
import {
  getSupabase,
  isSupabaseConfigured,
} from '@/lib/supabase';

interface AuthContextValue {
  configured: boolean;
  loading: boolean;
  session: Session | null;
  user: User | null;
  displayName: string | null;
  signIn: (
    loginName: string,
    password: string,
  ) => Promise<void>;
  signUp: (
    loginName: string,
    password: string,
  ) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext =
  createContext<AuthContextValue | null>(
    null,
  );

function cleanDisplayName(
  value: string,
): string {
  return value
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeLoginName(
  value: string,
): string {
  return cleanDisplayName(value)
    .normalize('NFKC')
    .toLowerCase();
}

function validateLoginName(
  value: string,
): string {
  const displayName =
    cleanDisplayName(value);

  if (
    displayName.length < 2
  ) {
    throw new Error(
      '이름은 2자 이상 입력해 주세요.',
    );
  }

  if (
    displayName.length > 20
  ) {
    throw new Error(
      '이름은 20자 이하로 입력해 주세요.',
    );
  }

  if (
    !/^[가-힣a-zA-Z0-9 _.-]+$/.test(
      displayName,
    )
  ) {
    throw new Error(
      '이름에는 한글, 영문, 숫자, 공백, _, -, .만 사용할 수 있습니다.',
    );
  }

  return displayName;
}

function validatePassword(
  password: string,
): void {
  if (
    password.length < 6
  ) {
    throw new Error(
      '비밀번호는 6자 이상 입력해 주세요.',
    );
  }

  if (
    password.length > 72
  ) {
    throw new Error(
      '비밀번호는 72자 이하로 입력해 주세요.',
    );
  }
}

function fallbackHash(
  value: string,
): string {
  let first =
    2166136261;

  let second =
    2246822519;

  for (
    let index = 0;
    index < value.length;
    index += 1
  ) {
    const code =
      value.charCodeAt(index);

    first ^= code;

    first =
      Math.imul(
        first,
        16777619,
      );

    second ^= code;

    second =
      Math.imul(
        second,
        3266489917,
      );
  }

  return `${(
    first >>> 0
  )
    .toString(16)
    .padStart(
      8,
      '0',
    )}${(
    second >>> 0
  )
    .toString(16)
    .padStart(
      8,
      '0',
    )}`;
}

async function loginNameToInternalEmail(
  loginName: string,
): Promise<string> {
  const normalized =
    normalizeLoginName(
      loginName,
    );

  const source =
    `seungjae-stock-account:${normalized}`;

  if (
    globalThis.crypto?.subtle
  ) {
    const bytes =
      new TextEncoder().encode(
        source,
      );

    const digest =
      await globalThis.crypto.subtle.digest(
        'SHA-256',
        bytes,
      );

    const token =
      Array.from(
        new Uint8Array(
          digest,
        ),
      )
        .slice(
          0,
          20,
        )
        .map(
          (value) =>
            value
              .toString(16)
              .padStart(
                2,
                '0',
              ),
        )
        .join('');

    return `u-${token}@accounts.seungjae-stock.com`;
  }

  return `u-${fallbackHash(
    source,
  )}@accounts.seungjae-stock.com`;
}

function authErrorMessage(
  cause: unknown,
  action:
    | 'login'
    | 'signup',
): string {
  const message =
    cause instanceof Error
      ? cause.message
      : String(
          cause ?? '',
        );

  const lower =
    message.toLowerCase();

  if (
    lower.includes(
      'invalid login credentials',
    ) ||
    lower.includes(
      'invalid_credentials',
    )
  ) {
    return '이름 또는 비밀번호가 맞지 않습니다.';
  }

  if (
    lower.includes(
      'user already registered',
    ) ||
    lower.includes(
      'already been registered',
    ) ||
    lower.includes(
      'already exists',
    )
  ) {
    return '이미 사용 중인 이름입니다. 이름 뒤에 숫자를 붙여 다시 등록해 주세요.';
  }

  if (
    lower.includes(
      'email not confirmed',
    )
  ) {
    return '가입 확인 설정이 켜져 있어 로그인할 수 없습니다. Supabase에서 이메일 확인 기능을 꺼 주세요.';
  }

  if (
    lower.includes(
      'password should be at least',
    ) ||
    lower.includes(
      'weak password',
    )
  ) {
    return '비밀번호는 6자 이상 입력해 주세요.';
  }

  if (
    lower.includes(
      'rate limit',
    ) ||
    lower.includes(
      'too many requests',
    )
  ) {
    return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  }

  return action ===
    'signup'
    ? '계정 등록에 실패했습니다. 잠시 후 다시 시도해 주세요.'
    : '로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.';
}

function displayNameOf(
  user: User | null,
): string | null {
  if (!user) {
    return null;
  }

  const metadataName =
    typeof user
      .user_metadata
      ?.display_name ===
    'string'
      ? user.user_metadata.display_name.trim()
      : '';

  if (metadataName) {
    return metadataName;
  }

  const loginName =
    typeof user
      .user_metadata
      ?.login_name ===
    'string'
      ? user.user_metadata.login_name.trim()
      : '';

  if (loginName) {
    return loginName;
  }

  return (
    user.email?.split(
      '@',
    )[0] ??
    '사용자'
  );
}

export function AuthProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [
    session,
    setSession,
  ] =
    useState<Session | null>(
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
    if (
      !isSupabaseConfigured
    ) {
      setLoading(false);
      return;
    }

    const supabase =
      getSupabase();

    let mounted = true;

    void supabase.auth
      .getSession()
      .then(
        ({
          data,
        }) => {
          if (!mounted) {
            return;
          }

          setSession(
            data.session,
          );

          setLoading(false);
        },
      );

    const {
      data:
        subscription,
    } =
      supabase.auth.onAuthStateChange(
        (
          _event,
          nextSession,
        ) => {
          setSession(
            nextSession,
          );

          setLoading(false);
        },
      );

    return () => {
      mounted = false;

      subscription
        .subscription
        .unsubscribe();
    };
  }, []);

  const value =
    useMemo<AuthContextValue>(
      () => ({
        configured:
          isSupabaseConfigured,

        loading,

        session,

        user:
          session?.user ??
          null,

        displayName:
          displayNameOf(
            session?.user ??
              null,
          ),

        async signIn(
          loginName,
          password,
        ) {
          const displayName =
            validateLoginName(
              loginName,
            );

          validatePassword(
            password,
          );

          const email =
            await loginNameToInternalEmail(
              displayName,
            );

          const {
            error,
          } =
            await getSupabase()
              .auth
              .signInWithPassword({
                email,
                password,
              });

          if (error) {
            throw new Error(
              authErrorMessage(
                error,
                'login',
              ),
            );
          }
        },

        async signUp(
          loginName,
          password,
        ) {
          const displayName =
            validateLoginName(
              loginName,
            );

          validatePassword(
            password,
          );

          const normalizedName =
            normalizeLoginName(
              displayName,
            );

          const email =
            await loginNameToInternalEmail(
              normalizedName,
            );

          const supabase =
            getSupabase();

          const {
            data,
            error,
          } =
            await supabase.auth.signUp({
              email,

              password,

              options: {
                data: {
                  display_name:
                    displayName,

                  login_name:
                    normalizedName,

                  account_type:
                    'simple-name-password',
                },
              },
            });

          if (error) {
            throw new Error(
              authErrorMessage(
                error,
                'signup',
              ),
            );
          }

          if (
            data.user &&
            Array.isArray(
              data.user.identities,
            ) &&
            data.user
              .identities
              .length === 0
          ) {
            throw new Error(
              '이미 사용 중인 이름입니다. 이름 뒤에 숫자를 붙여 다시 등록해 주세요.',
            );
          }

          if (
            !data.session
          ) {
            const {
              error:
                signInError,
            } =
              await supabase
                .auth
                .signInWithPassword({
                  email,
                  password,
                });

            if (
              signInError
            ) {
              throw new Error(
                authErrorMessage(
                  signInError,
                  'signup',
                ),
              );
            }
          }
        },

        async signOut() {
          const {
            error,
          } =
            await getSupabase()
              .auth
              .signOut();

          if (error) {
            throw error;
          }
        },
      }),
      [
        loading,
        session,
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
  const value =
    useContext(
      AuthContext,
    );

  if (!value) {
    throw new Error(
      'useAuth는 AuthProvider 내부에서 사용해야 합니다.',
    );
  }

  return value;
}