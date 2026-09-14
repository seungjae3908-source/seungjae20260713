import type { Session } from '@supabase/supabase-js';
import {
  AUTH_PROFILE_BOOTSTRAP_TIMEOUT_MS,
  AUTH_SESSION_BOOTSTRAP_TIMEOUT_MS,
  withFiniteDeadline,
} from '@/lib/auth-bootstrap';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';

export type InitialMemberProfile = {
  id: string;
  login_name: string;
  display_name: string;
  role: string;
  status: 'pending' | 'approved' | 'rejected' | 'suspended' | 'withdrawn';
  membership_level?: 'pending' | 'associate' | 'regular' | 'admin' | null;
  is_active?: boolean | null;
  permissions_updated_at?: string | null;
  updated_at?: string | null;
};

export type InitialAuthBootstrap = {
  session: Session | null;
  profile: InitialMemberProfile | null;
};

let initialBootstrap: Promise<InitialAuthBootstrap> | null = null;
let initialBootstrapClaimed = false;
let initialBootstrapUserId: string | null | undefined;

export function primeInitialAuthBootstrap(): Promise<InitialAuthBootstrap> | null {
  if (!isSupabaseConfigured) return null;
  if (initialBootstrap) return initialBootstrap;

  initialBootstrap = (async () => {
    const { data, error } = await withFiniteDeadline(
      getSupabase().auth.getSession(),
      AUTH_SESSION_BOOTSTRAP_TIMEOUT_MS,
      'AUTH_SESSION_TIMEOUT',
    );
    if (error) throw error;
    const session = data.session;
    initialBootstrapUserId = session?.user.id ?? null;
    if (!session) return { session: null, profile: null };

    const controller = new AbortController();
    const profile = await withFiniteDeadline(
      (async () => {
        const query = getSupabase().from('profiles').select('*').eq('id', session.user.id);
        const { data: profileData, error: profileError } = await query
          .abortSignal(controller.signal)
          .maybeSingle();
        if (profileError) throw profileError;
        return (profileData as InitialMemberProfile | null) ?? null;
      })(),
      AUTH_PROFILE_BOOTSTRAP_TIMEOUT_MS,
      'AUTH_PROFILE_TIMEOUT',
      (deadlineError) => controller.abort(deadlineError),
    );
    if (profile && profile.id !== session.user.id) {
      throw new Error('AUTH_PROFILE_IDENTITY_MISMATCH');
    }
    return { session, profile };
  })();

  return initialBootstrap;
}

export function claimInitialAuthBootstrap(): Promise<InitialAuthBootstrap> | null {
  if (initialBootstrapClaimed) return null;
  initialBootstrapClaimed = true;
  return initialBootstrap;
}

export function getInitialAuthBootstrapUserId(): string | null | undefined {
  return initialBootstrapUserId;
}
