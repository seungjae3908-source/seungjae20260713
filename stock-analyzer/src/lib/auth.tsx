import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
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
  configured: boolean; loading: boolean; session: Session | null; user: User | null;
  profile: MemberProfile | null; displayName: string | null; isAdmin: boolean; isApproved: boolean;
  signIn(loginName: string, password: string): Promise<void>;
  signUp(loginName: string, password: string): Promise<void>;
  signOut(): Promise<void>; refreshProfile(): Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const normalizeName = (value: string) => value.trim().normalize('NFKC').toLowerCase();

function validate(loginName: string, password: string) {
  const name = loginName.trim();
  if (name.length < 2 || name.length > 20) throw new Error('아이디는 2~20자로 입력해 주세요.');
  if (!/^[가-힣a-zA-Z0-9 _.-]+$/.test(name)) throw new Error('아이디에는 한글, 영문, 숫자, 공백, _, -, .만 사용할 수 있습니다.');
  if (password.length < 8 || password.length > 72) throw new Error('비밀번호는 8~72자로 입력해 주세요.');
  return name;
}

async function internalEmail(loginName: string) {
  const source = new TextEncoder().encode(`seungjae-stock-account:${normalizeName(loginName)}`);
  const digest = await crypto.subtle.digest('SHA-256', source);
  const token = Array.from(new Uint8Array(digest)).slice(0, 20).map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${token}@accounts.seungjae-stock.com`;
}

function authMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message.toLowerCase() : '';
  if (message.includes('invalid login')) return '아이디 또는 비밀번호가 맞지 않습니다.';
  if (message.includes('already')) return '이미 사용 중인 아이디입니다.';
  if (message.includes('rate limit')) return '요청이 많습니다. 잠시 후 다시 시도해 주세요.';
  return '계정 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);

  async function loadProfile(user: User | null) {
    if (!user) { setProfile(null); return; }
    const { data } = await getSupabase().from('profiles').select('id,login_name,display_name,role,status').eq('id', user.id).maybeSingle();
    setProfile((data as MemberProfile | null) ?? null);
  }

  useEffect(() => {
    if (!isSupabaseConfigured) { setLoading(false); return; }
    let mounted = true;
    void getSupabase().auth.getSession().then(async ({ data }) => {
      if (!mounted) return;
      setSession(data.session); await loadProfile(data.session?.user ?? null); setLoading(false);
    });
    const { data: sub } = getSupabase().auth.onAuthStateChange((_event, next) => {
      setSession(next); void loadProfile(next?.user ?? null).finally(() => setLoading(false));
    });
    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    configured: isSupabaseConfigured, loading, session, user: session?.user ?? null, profile,
    displayName: profile?.display_name ?? (session?.user?.user_metadata?.display_name as string | undefined) ?? null,
    isAdmin:
        (profile?.status === 'approved' && profile.role === 'admin') ||
        (session?.user?.app_metadata?.status === 'approved' &&
          session?.user?.app_metadata?.role === 'admin'),
      isApproved:
        profile?.status === 'approved' ||
        session?.user?.app_metadata?.status === 'approved',
    async signIn(loginName, password) {
      const name = validate(loginName, password);
      const { error } = await getSupabase().auth.signInWithPassword({ email: await internalEmail(name), password });
      if (error) throw new Error(authMessage(error));
    },
    async signUp(loginName, password) {
      const name = validate(loginName, password); const normalized = normalizeName(name);
      const { data, error } = await getSupabase().auth.signUp({ email: await internalEmail(normalized), password, options: { data: { display_name: name, login_name: normalized } } });
      if (error || data.user?.identities?.length === 0) throw new Error(authMessage(error ?? new Error('already')));
    },
    async signOut() { const { error } = await getSupabase().auth.signOut(); if (error) throw error; },
    async refreshProfile() { await loadProfile(session?.user ?? null); },
  }), [loading, profile, session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth는 AuthProvider 안에서 사용해야 합니다.');
  return value;
}
