import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
const PROFILE_CACHE_PREFIX = 'seungjae-stock-profile-v1:';
const PROFILE_TIMEOUT_MS = 8_000;
const PROFILE_RETRY_DELAYS_MS = [0, 400, 1_200] as const;
const normalizeName = (value: string) => value.trim().normalize('NFKC').toLowerCase();

function validate(loginName: string, password: string) {
  const name = loginName.trim();
  if (name.length < 2 || name.length > 20) throw new Error('아이디는 2~20자로 입력해 주세요.');
  if (!/^[가-힣a-zA-Z0-9 _.-]+$/.test(name)) {
    throw new Error('아이디에는 한글, 영문, 숫자, 공백, _, -, .만 사용할 수 있습니다.');
  }
  if (password.length < 8 || password.length > 72) throw new Error('비밀번호는 8~72자로 입력해 주세요.');
  return name;
}

async function internalEmail(loginName: string) {
  const source = new TextEncoder().encode(`seungjae-stock-account:${normalizeName(loginName)}`);
  const digest = await crypto.subtle.digest('SHA-256', source);
  const token = Array.from(new Uint8Array(digest))
    .slice(0, 20)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `${token}@accounts.seungjae-stock.com`;
}

function authMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message.toLowerCase() : '';
  if (message.includes('invalid login')) return '아이디 또는 비밀번호가 맞지 않습니다.';
  if (message.includes('already')) return '이미 사용 중인 아이디입니다.';
  if (message.includes('rate limit')) return '요청이 많습니다. 잠시 후 다시 시도해 주세요.';
  if (message.includes('failed to fetch') || message.includes('network')) {
    return '네트워크 연결을 확인한 뒤 다시 시도해 주세요.';
  }
  return '로그인 서비스에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요.';
}

function isMemberProfile(value: unknown): value is MemberProfile {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<MemberProfile>;
  return (
    typeof row.id === 'string' &&
    typeof row.login_name === 'string' &&
    typeof row.display_name === 'string' &&
    (row.role === 'user' || row.role === 'admin') &&
    ['pending', 'approved', 'rejected', 'suspended', 'withdrawn'].includes(String(row.status))
  );
}

function readCachedProfile(userId: string): MemberProfile | null {
  try {
    const raw = window.localStorage.getItem(`${PROFILE_CACHE_PREFIX}${userId}`);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    return isMemberProfile(value) && value.id === userId ? value : null;
  } catch {
    return null;
  }
}

function writeCachedProfile(profile: MemberProfile): void {
  try {
    window.localStorage.setItem(`${PROFILE_CACHE_PREFIX}${profile.id}`, JSON.stringify(profile));
  } catch {
    // A missing profile cache must never sign the user out.
  }
}

function clearCachedProfile(userId: string | undefined): void {
  if (!userId) return;
  try {
    window.localStorage.removeItem(`${PROFILE_CACHE_PREFIX}${userId}`);
  } catch {
    // The authenticated session is still cleared by Supabase.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function withTimeout<T>(operation: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timer = 0;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error('PROFILE_REQUEST_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}

async function fetchProfile(user: User): Promise<MemberProfile | null> {
  let lastError: unknown = null;

  for (const waitMs of PROFILE_RETRY_DELAYS_MS) {
    if (waitMs) await delay(waitMs);
    try {
      const { data, error } = await withTimeout(
        getSupabase()
          .from('profiles')
          .select('id,login_name,display_name,role,status')
          .eq('id', user.id)
          .maybeSingle(),
        PROFILE_TIMEOUT_MS,
      );
      if (error) throw error;
      const next = isMemberProfile(data) ? data : null;
      if (next) writeCachedProfile(next);
      return next;
    } catch (cause) {
      lastError = cause;
      if (typeof navigator !== 'undefined' && !navigator.onLine) break;
    }
  }

  throw lastError ?? new Error('PROFILE_REQUEST_FAILED');
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const syncSequence = useRef(0);

  const synchronizeSession = useCallback(async (next: Session | null) => {
    const sequence = ++syncSequence.current;
    setSession(next);

    if (!next?.user) {
      setProfile(null);
      setLoading(false);
      return;
    }

    const cached = readCachedProfile(next.user.id);
    if (cached) setProfile(cached);

    try {
      const fresh = await fetchProfile(next.user);
      if (sequence !== syncSequence.current) return;
      setProfile(fresh ?? cached ?? null);
    } catch {
      // Keep the valid Supabase session and the last known profile during a
      // temporary network/RLS outage instead of showing the login screen.
      if (sequence !== syncSequence.current) return;
      if (cached) setProfile(cached);
    } finally {
      if (sequence === syncSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }

    const supabase = getSupabase();
    let active = true;

    const scheduleSync = (next: Session | null) => {
      if (!active) return;
      setSession(next);
      if (!next?.user) {
        ++syncSequence.current;
        setProfile(null);
        setLoading(false);
        return;
      }

      const cached = readCachedProfile(next.user.id);
      if (cached) setProfile(cached);

      // Do not make another Supabase call inside onAuthStateChange. Moving the
      // profile request to the next task prevents auth callback deadlocks.
      window.setTimeout(() => {
        if (active) void synchronizeSession(next);
      }, 0);
    };

    const restoreSession = () => {
      void supabase.auth
        .getSession()
        .then(({ data, error }) => {
          if (error) throw error;
          scheduleSync(data.session);
        })
        .catch(() => {
          if (active) setLoading(false);
        });
    };

    restoreSession();

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
      scheduleSync(next);
    });

    const handleOnline = () => restoreSession();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') restoreSession();
    };
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [synchronizeSession]);

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
      isAdmin:
        (profile?.status === 'approved' && profile.role === 'admin') ||
        (session?.user?.app_metadata?.status === 'approved' &&
          session?.user?.app_metadata?.role === 'admin'),
      isApproved:
        profile?.status === 'approved' || session?.user?.app_metadata?.status === 'approved',
      async signIn(loginName, password) {
        const name = validate(loginName, password);
        const { data, error } = await getSupabase().auth.signInWithPassword({
          email: await internalEmail(name),
          password,
        });
        if (error) throw new Error(authMessage(error));
        await synchronizeSession(data.session);
      },
      async signUp(loginName, password) {
        const name = validate(loginName, password);
        const normalized = normalizeName(name);
        const { data, error } = await getSupabase().auth.signUp({
          email: await internalEmail(normalized),
          password,
          options: { data: { display_name: name, login_name: normalized } },
        });
        if (error || data.user?.identities?.length === 0) {
          throw new Error(authMessage(error ?? new Error('already')));
        }
        if (data.session) await synchronizeSession(data.session);
      },
      async signOut() {
        const userId = session?.user.id;
        const { error } = await getSupabase().auth.signOut();
        if (error) throw new Error(authMessage(error));
        clearCachedProfile(userId);
        ++syncSequence.current;
        setSession(null);
        setProfile(null);
        setLoading(false);
      },
      async refreshProfile() {
        const user = session?.user;
        if (!user) return;
        const fresh = await fetchProfile(user);
        setProfile(fresh);
      },
    }),
    [loading, profile, session, synchronizeSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth는 AuthProvider 안에서 사용해야 합니다.');
  return value;
}
