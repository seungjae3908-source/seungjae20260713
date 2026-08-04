import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';
import { ProfileRequestCoordinator } from '@/lib/profile-request-coordinator';
import {
  deriveMemberTier,
  hasCapability,
  permissionsFor,
  type MemberCapability,
  type MemberTier,
} from '../../../packages/member-access/src/index.js';

export type MemberProfile = {
  id: string;
  login_name: string;
  display_name: string;
  role: string;
  status: 'pending' | 'approved' | 'rejected' | 'suspended' | 'withdrawn';
  membership_level?: MemberTier | null;
  is_active?: boolean | null;
  permissions_updated_at?: string | null;
  updated_at?: string | null;
};

type AuthContextValue = {
  configured: boolean;
  loading: boolean;
  session: Session | null;
  user: User | null;
  profile: MemberProfile | null;
  displayName: string | null;
  membershipLevel: MemberTier;
  permissions: Readonly<Record<MemberCapability, boolean>>;
  can(capability: MemberCapability): boolean;
  isAdmin: boolean;
  isApproved: boolean;
  signIn(loginName: string, password: string): Promise<void>;
  signUp(loginName: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  refreshProfile(): Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const normalizeName = (value: string) => value.trim().normalize('NFKC').toLowerCase();
const PROFILE_AUTO_REFRESH_MS = 30_000;

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
  if (message.includes('invalid login') || message.includes('invalid credentials')) return '아이디 또는 비밀번호가 맞지 않습니다.';
  if (message.includes('already')) return '이미 사용 중인 아이디입니다.';
  if (message.includes('rate limit')) return '요청이 많습니다. 잠시 후 다시 시도해 주세요.';
  if (message.includes('session token')) return cause instanceof Error ? cause.message : '로그인 세션을 적용하지 못했습니다.';
  return '계정 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.';
}

async function signInWithSupabase(loginName: string, password: string) {
  const client = getSupabase();
  const { data, error } = await client.auth.signInWithPassword({
    email: await internalEmail(loginName),
    password,
  });
  if (error || !data.session) throw error ?? new Error('Invalid login credentials');

  const { data: verified, error: verifyError } = await client.auth.getUser();
  if (verifyError || !verified.user) {
    await client.auth.signOut({ scope: 'local' });
    throw new Error('로그인 session token 검증에 실패했습니다.');
  }
  return data.session;
}

function profileRequestKey(value: Session | null): string | null {
  return value ? `${value.user.id}:${value.access_token}` : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const mountedRef = useRef(true);
  const signingOutRef = useRef(false);
  const signOutTaskRef = useRef<Promise<void> | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const profileLoadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const profileRequestsRef = useRef(new ProfileRequestCoordinator<MemberProfile | null>());

  function applySession(next: Session | null) {
    sessionRef.current = next;
    setSession(next);
    profileRequestsRef.current.setIdentity(next?.user.id ?? null, profileRequestKey(next));
    if (!next) setProfile(null);
  }

  function loadProfile(user: User | null, options: { force?: boolean; maxAgeMs?: number } = {}): Promise<void> {
    if (!user) {
      if (mountedRef.current) setProfile(null);
      return Promise.resolve();
    }
    if (signingOutRef.current || sessionRef.current?.user.id !== user.id) return Promise.resolve();

    const queued = profileLoadQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (signingOutRef.current || sessionRef.current?.user.id !== user.id) return;
        const current = sessionRef.current;
        const requestKey = profileRequestKey(current);
        if (!current || !requestKey) return;
        await profileRequestsRef.current.request({
          identity: user.id,
          requestKey,
          force: options.force,
          maxAgeMs: options.maxAgeMs ?? PROFILE_AUTO_REFRESH_MS,
          load: async () => {
            const { data } = await getSupabase().from('profiles').select('*').eq('id', user.id).maybeSingle();
            return (data as MemberProfile | null) ?? null;
          },
          apply: (nextProfile) => {
            if (!signingOutRef.current && sessionRef.current?.user.id === user.id) {
              if (mountedRef.current) setProfile(nextProfile);
            }
          },
        });
      });

    profileLoadQueueRef.current = queued.catch(() => undefined);
    return queued;
  }

  useEffect(() => {
    mountedRef.current = true;
    if (!isSupabaseConfigured) { setLoading(false); return; }
    void getSupabase().auth.getSession().then(async ({ data }) => {
      if (!mountedRef.current) return;
      applySession(data.session);
      await loadProfile(data.session?.user ?? null);
      if (mountedRef.current) setLoading(false);
    });
    const { data: sub } = getSupabase().auth.onAuthStateChange((_event, next) => {
      if (signingOutRef.current && next) return;
      applySession(next);
      void loadProfile(next?.user ?? null).finally(() => {
        if (mountedRef.current) setLoading(false);
      });
    });
    return () => {
      mountedRef.current = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session?.user) return;
    let active = true;
    const refresh = () => {
      if (active && !signingOutRef.current) void loadProfile(session.user);
    };
    const visibility = () => { if (document.visibilityState === 'visible') refresh(); };
    const timer = window.setInterval(refresh, PROFILE_AUTO_REFRESH_MS);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [session?.user?.id]);

  const membershipLevel = deriveMemberTier(profile);
  const permissions = permissionsFor(profile);
  const value = useMemo<AuthContextValue>(() => ({
    configured: isSupabaseConfigured,
    loading,
    session,
    user: session?.user ?? null,
    profile,
    displayName: profile?.display_name ?? (session?.user?.user_metadata?.display_name as string | undefined) ?? null,
    membershipLevel,
    permissions,
    can: (capability) => hasCapability(profile, capability),
    isAdmin: permissions.canManageMembers,
    isApproved: permissions.canAccessBasicInfo,
    async signIn(loginName, password) {
      const name = validate(loginName, password);
      setLoading(true);
      try {
        const nextSession = await signInWithSupabase(name, password);
        applySession(nextSession);
        await loadProfile(nextSession.user);
      } catch (cause) {
        applySession(null);
        throw new Error(authMessage(cause));
      } finally {
        setLoading(false);
      }
    },
    async signUp(loginName, password) {
      const name = validate(loginName, password);
      const normalized = normalizeName(name);
      const { data, error } = await getSupabase().auth.signUp({
        email: await internalEmail(normalized), password,
        options: { data: { display_name: name, login_name: normalized } },
      });
      if (error || data.user?.identities?.length === 0) throw new Error(authMessage(error ?? new Error('already')));
    },
    async signOut() {
      if (signOutTaskRef.current) return signOutTaskRef.current;
      const previousSession = sessionRef.current;
      const previousRequestKey = profileRequestKey(previousSession);
      const task = (async () => {
        signingOutRef.current = true;
        setLoading(true);
        try {
          const coordinatorDrain = profileRequestsRef.current.beginLogout();
          await profileLoadQueueRef.current;
          await coordinatorDrain;
          const { error } = await getSupabase().auth.signOut();
          if (error) throw error;
          applySession(null);
          profileRequestsRef.current.finishLogout();
        } catch (cause) {
          const { data } = await getSupabase().auth.getSession();
          const restored = data.session ?? previousSession;
          const restoredRequestKey = profileRequestKey(restored) ?? previousRequestKey;
          if (restored && restoredRequestKey) {
            profileRequestsRef.current.restoreAfterFailedLogout(restored.user.id, restoredRequestKey);
            applySession(restored);
          } else {
            profileRequestsRef.current.finishLogout();
            applySession(null);
          }
          throw cause;
        } finally {
          signingOutRef.current = false;
          signOutTaskRef.current = null;
          setLoading(false);
        }
      })();
      signOutTaskRef.current = task;
      return task;
    },
    async refreshProfile() {
      const current = sessionRef.current;
      await loadProfile(current?.user ?? null, { force: true });
    },
  }), [loading, membershipLevel, permissions, profile, session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth는 AuthProvider 안에서 사용해야 합니다.');
  return value;
}
