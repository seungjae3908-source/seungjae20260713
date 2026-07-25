import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';

export type StoredMemberRole = 'pending' | 'associate' | 'full' | 'master' | 'admin' | 'user';
export type MembershipRole = 'pending' | 'associate' | 'full' | 'master' | 'admin';

export type MemberProfile = {
  id: string;
  login_name: string;
  display_name: string;
  role: StoredMemberRole;
  status: 'pending' | 'approved' | 'rejected' | 'suspended' | 'withdrawn';
};

type AuthContextValue = {
  configured: boolean;
  loading: boolean;
  session: Session | null;
  user: User | null;
  profile: MemberProfile | null;
  displayName: string | null;
  membershipRole: MembershipRole;
  isAssociate: boolean;
  isFullMember: boolean;
  isAdmin: boolean;
  isApproved: boolean;
  signIn(identifier: string, password: string, keepLogin?: boolean): Promise<void>;
  signUp(input: SignUpInput): Promise<void>;
  signOut(): Promise<void>;
  refreshProfile(): Promise<void>;
  requestLoginName(email: string): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  updateRecoveredPassword(password: string): Promise<void>;
  findLoginName(input: { name: string; email: string; birth6: string }): Promise<string>;
  findPassword(input: { identifier: string; name: string; birth6: string }): Promise<void>;
};

export type SignUpInput = {
  loginName: string;
  displayName: string;
  email: string;
  password: string;
  birth6: string;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const normalizeName = (value: string) => value.trim().normalize('NFKC').toLowerCase();
const normalizeEmail = (value: string) => value.trim().normalize('NFKC').toLowerCase();
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || '/api';

export function normalizeMembershipRole(role?: StoredMemberRole | null): MembershipRole {
  if (role === 'admin') return 'admin';
  if (role === 'master') return 'master';
  if (role === 'full' || role === 'user') return 'full';
  if (role === 'associate') return 'associate';
  return 'pending';
}

function validateLoginName(loginName: string) {
  const name = loginName.trim().normalize('NFKC');
  if (name.length < 2 || name.length > 20) throw new Error('아이디는 2~20자로 입력해 주세요.');
  if (!/^[가-힣a-zA-Z0-9 _.-]+$/.test(name)) throw new Error('아이디에는 한글, 영문, 숫자, 공백, _, -, .만 사용할 수 있습니다.');
  return name;
}

function validatePassword(password: string) {
  if (password.length < 8 || password.length > 72) throw new Error('비밀번호는 8~72자로 입력해 주세요.');
}

function validateEmail(value: string) {
  const email = normalizeEmail(value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error('사용 가능한 이메일 주소를 정확히 입력해 주세요.');
  }
  return email;
}

// 생년월일 6자리(YYMMDD)는 서버에서 해시로만 저장되며, 앱에는 절대 남기지 않습니다.
export function validateBirth6(value: string): string {
  const birth6 = value.trim();
  if (!/^[0-9]{6}$/.test(birth6)) throw new Error('생년월일 6자리(예: 900131)를 숫자로 입력해 주세요.');
  const month = Number(birth6.slice(2, 4));
  const day = Number(birth6.slice(4, 6));
  const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    throw new Error('생년월일이 올바르지 않습니다. YYMMDD 형식으로 입력해 주세요.');
  }
  return birth6;
}

// 로그인 유지 여부: 유지 안 함이면 브라우저 세션이 끝날 때 로그아웃 처리합니다.
const KEEP_LOGIN_KEY = 'sj-keep-login';
const SESSION_ALIVE_KEY = 'sj-session-alive';

export function setKeepLogin(keep: boolean) {
  try {
    localStorage.setItem(KEEP_LOGIN_KEY, keep ? '1' : '0');
    sessionStorage.setItem(SESSION_ALIVE_KEY, '1');
  } catch { /* 저장 불가 환경에서는 항상 로그인 유지 */ }
}

function shouldDropRestoredSession(): boolean {
  try {
    return localStorage.getItem(KEEP_LOGIN_KEY) === '0' && sessionStorage.getItem(SESSION_ALIVE_KEY) !== '1';
  } catch {
    return false;
  }
}

function accountRedirectUrl(mode: 'email_confirmed' | 'login_name' | 'password') {
  const base = String(import.meta.env.BASE_URL || '/').replace(/\/$/, '');
  return `${window.location.origin}${base}/account?recovery=${mode}`;
}

function authMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message.toLowerCase() : '';
  if (message.includes('invalid login') || message.includes('invalid_credentials')) return '아이디·이메일 또는 비밀번호가 맞지 않습니다.';
  if (message.includes('email not confirmed')) return '이메일 인증이 필요합니다. 가입 이메일의 인증 링크를 확인해 주세요.';
  if (message.includes('already') || message.includes('registered')) return '이미 가입된 아이디 또는 이메일입니다.';
  if (message.includes('rate limit')) return '요청이 많습니다. 잠시 후 다시 시도해 주세요.';
  if (message.includes('service_role')) return '아이디 로그인 서버 설정이 필요합니다. 관리자에게 문의해 주세요.';
  return '계정 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);

  async function loadProfile(user: User | null) {
    if (!user) {
      setProfile(null);
      return;
    }
    const { data } = await getSupabase()
      .from('profiles')
      .select('id,login_name,display_name,role,status')
      .eq('id', user.id)
      .maybeSingle();
    setProfile((data as MemberProfile | null) ?? null);
  }

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }
    let mounted = true;
    void getSupabase().auth.getSession().then(async ({ data }) => {
      if (!mounted) return;

      // "로그인 유지" 미선택 상태에서 브라우저를 완전히 닫았다 열면 로그아웃 처리
      if (data.session && shouldDropRestoredSession()) {
        await getSupabase().auth.signOut();
        setSession(null);
        setProfile(null);
        setLoading(false);
        return;
      }
      if (data.session) {
        try { sessionStorage.setItem(SESSION_ALIVE_KEY, '1'); } catch { /* noop */ }
      }

      setSession(data.session);
      await loadProfile(data.session?.user ?? null);
      setLoading(false);
    });
    const { data: sub } = getSupabase().auth.onAuthStateChange((_event, next) => {
      setSession(next);
      // 주의: 이 콜백 안에서 다른 supabase 호출을 기다리면(auth 내부 잠금 보유 중)
      // getSession()이 영원히 대기하는 교착이 생겨 앱 전체 API 호출이 멈춥니다.
      // 반드시 콜백 밖(setTimeout)으로 미뤄서 실행합니다.
      setTimeout(() => {
        void loadProfile(next?.user ?? null).finally(() => setLoading(false));
      }, 0);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) return;

    const currentUser = session?.user;
    if (!currentUser) return;

    let active = true;

    const refresh = async () => {
      if (!active) return;
      await loadProfile(currentUser);
    };

    const channel = getSupabase()
      .channel(`profile-access-${currentUser.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'profiles',
          filter: `id=eq.${currentUser.id}`,
        },
        () => {
          void refresh();
        },
      )
      .subscribe();

    const onFocus = () => void refresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh();
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    // 30초 폴링은 Supabase 요청 폭주(레이트리밋)를 유발해 앱 전체 API가 멈추는 원인이 됐다.
    // 등급 변경은 실시간 채널·화면 복귀(focus/visibility)로도 반영되므로 폴링은 5분으로 완화.
    const intervalId = window.setInterval(() => void refresh(), 300_000);

    return () => {
      active = false;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(intervalId);
      void getSupabase().removeChannel(channel);
    };
  }, [session?.user?.id]);

  const membershipRole = normalizeMembershipRole(profile?.role);
  const isApproved = profile?.status === 'approved';

  const value = useMemo<AuthContextValue>(() => ({
    configured: isSupabaseConfigured,
    loading,
    session,
    user: session?.user ?? null,
    profile,
    displayName: profile?.display_name ?? (session?.user?.user_metadata?.display_name as string | undefined) ?? null,
    membershipRole,
    isAssociate: isApproved && membershipRole === 'associate',
    isFullMember: isApproved && ['full', 'master', 'admin'].includes(membershipRole),
    isAdmin: isApproved && ['master', 'admin'].includes(membershipRole),
    isApproved,

    async signIn(identifier, password, keepLogin = true) {
      const cleanIdentifier = identifier.trim().normalize('NFKC');
      if (!cleanIdentifier) throw new Error('아이디 또는 이메일을 입력해 주세요.');
      validatePassword(password);
      setKeepLogin(keepLogin);

      const response = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: cleanIdentifier, password }),
      });
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        session?: { access_token?: string; refresh_token?: string };
      };

      if (!response.ok || !payload.session?.access_token || !payload.session.refresh_token) {
        if (payload.error === 'SUPABASE_SERVICE_ROLE_REQUIRED') {
          throw new Error('아이디 로그인을 사용하려면 서버에 SUPABASE_SERVICE_ROLE_KEY 설정이 필요합니다. 이메일로는 로그인할 수 있습니다.');
        }
        throw new Error(authMessage(new Error(payload.error ?? 'invalid login')));
      }

      const { error } = await getSupabase().auth.setSession({
        access_token: payload.session.access_token,
        refresh_token: payload.session.refresh_token,
      });
      if (error) throw new Error(authMessage(error));
    },

    async signUp(input) {
      const name = validateLoginName(input.loginName);
      const normalized = normalizeName(name);
      const displayName = input.displayName.trim().normalize('NFKC');
      if (displayName.length < 2 || displayName.length > 20) throw new Error('이름은 2~20자로 입력해 주세요.');
      const email = validateEmail(input.email);
      validatePassword(input.password);
      const birth6 = validateBirth6(input.birth6);

      // birth_date_6은 서버 트리거가 즉시 해시로 바꾸고 메타데이터에서 제거합니다.
      const { data, error } = await getSupabase().auth.signUp({
        email,
        password: input.password,
        options: {
          emailRedirectTo: accountRedirectUrl('email_confirmed'),
          data: { display_name: displayName, login_name: normalized, birth_date_6: birth6 },
        },
      });
      if (error || data.user?.identities?.length === 0) {
        throw new Error(authMessage(error ?? new Error('already registered')));
      }

      // 이메일 확인이 꺼진 프로젝트에서는 즉시 세션이 생길 수 있습니다.
      // 가입 직후에는 승인 대기 안내를 보여주기 위해 로그인 상태를 종료합니다.
      if (data.session) await getSupabase().auth.signOut();
    },

    async signOut() {
      const { error } = await getSupabase().auth.signOut();
      if (error) throw error;
    },

    async refreshProfile() {
      await loadProfile(session?.user ?? null);
    },

    async requestLoginName(emailInput) {
      const email = validateEmail(emailInput);
      const { error } = await getSupabase().auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
          emailRedirectTo: accountRedirectUrl('login_name'),
        },
      });
      if (error) throw new Error(authMessage(error));
    },

    async requestPasswordReset(emailInput) {
      const email = validateEmail(emailInput);
      const { error } = await getSupabase().auth.resetPasswordForEmail(email, {
        redirectTo: accountRedirectUrl('password'),
      });
      if (error) throw new Error(authMessage(error));
    },

    async updateRecoveredPassword(password) {
      validatePassword(password);
      const { error } = await getSupabase().auth.updateUser({ password });
      if (error) throw new Error(authMessage(error));
    },

    async findLoginName(input) {
      const email = validateEmail(input.email);
      const birth6 = validateBirth6(input.birth6);
      const name = input.name.trim().normalize('NFKC');
      if (!name) throw new Error('이름을 입력해 주세요.');

      const response = await fetch(`${API_BASE}/auth/find-id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, birth6 }),
      });
      const payload = await response.json().catch(() => ({})) as { maskedLoginName?: string; error?: string };
      if (response.status === 429) throw new Error('시도 횟수가 많습니다. 10분 후 다시 시도해 주세요.');
      if (!response.ok || !payload.maskedLoginName) {
        throw new Error('입력하신 정보와 일치하는 계정을 찾지 못했습니다.');
      }
      return payload.maskedLoginName;
    },

    async findPassword(input) {
      const identifier = input.identifier.trim().normalize('NFKC');
      const name = input.name.trim().normalize('NFKC');
      const birth6 = input.birth6.trim() === '' ? '' : validateBirth6(input.birth6);
      if (!identifier || !name) throw new Error('아이디(또는 이메일)와 이름을 입력해 주세요.');

      const response = await fetch(`${API_BASE}/auth/find-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, name, birth6, redirectTo: accountRedirectUrl('password') }),
      });
      if (response.status === 429) throw new Error('시도 횟수가 많습니다. 10분 후 다시 시도해 주세요.');
      if (!response.ok) {
        throw new Error('입력하신 정보와 일치하는 계정을 찾지 못했습니다.');
      }
    },
  }), [isApproved, loading, membershipRole, profile, session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth는 AuthProvider 안에서 사용해야 합니다.');
  return value;
}