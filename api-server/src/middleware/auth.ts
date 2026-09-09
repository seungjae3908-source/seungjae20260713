import type { NextFunction, Request, Response } from 'express';
import { getSupabase, getUserSupabase, isSupabaseConfigured } from '../lib/supabase';
import {
  deriveMemberTier,
  hasCapability,
  type MemberCapability,
  type MemberTier,
} from '../../../packages/member-access/src/index.js';

export type MemberProfile = {
  id: string;
  login_name: string;
  display_name: string;
  role: string;
  status: 'pending' | 'approved' | 'rejected' | 'suspended' | 'revoked' | 'withdrawn' | 'disabled' | 'inactive';
  membership_level?: MemberTier | null;
  is_active?: boolean | null;
  permissions_updated_at?: string | null;
  updated_at?: string | null;
};

export type AuthenticatedRequest = Request & {
  member?: MemberProfile;
  accessToken?: string;
  membershipLevel?: MemberTier;
};

type AuthDependencies = {
  isSupabaseConfigured: typeof isSupabaseConfigured;
  getSupabase: typeof getSupabase;
  getUserSupabase: typeof getUserSupabase;
};

const defaultAuthDependencies: AuthDependencies = {
  isSupabaseConfigured,
  getSupabase,
  getUserSupabase,
};

function bearerToken(req: Request): string | null {
  const value = req.header('authorization') ?? '';
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : null;
}

function isDisabledMemberSession(member: MemberProfile): boolean {
  return member.status === 'suspended'
    || member.status === 'revoked'
    || member.status === 'withdrawn'
    || member.status === 'disabled'
    || member.status === 'inactive'
    || (member.status === 'approved' && member.is_active === false);
}

async function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  dependencies: AuthDependencies = defaultAuthDependencies,
): Promise<boolean> {
  if (req.member && req.accessToken) {
    req.membershipLevel = deriveMemberTier(req.member);
    return true;
  }
  if (!dependencies.isSupabaseConfigured()) {
    res.status(503).json({ error: 'AUTH_NOT_CONFIGURED' });
    return false;
  }

  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'LOGIN_REQUIRED' });
    return false;
  }

  const supabase = dependencies.getSupabase();
  const { data: auth, error: authError } = await supabase.auth.getUser(token);
  if (authError || !auth.user) {
    res.status(401).json({ error: 'INVALID_SESSION' });
    return false;
  }

  // Always resolve authorization from the current database profile. Client role
  // claims and request bodies are never authoritative.
  const { data: profile, error } = await dependencies.getUserSupabase(token)
    .from('profiles')
    .select('*')
    .eq('id', auth.user.id)
    .single();
  if (error || !profile) {
    res.status(403).json({ error: 'PROFILE_NOT_FOUND' });
    return false;
  }

  const member = profile as unknown as MemberProfile;
  if (isDisabledMemberSession(member)) {
    res.status(403).json({ error: 'MEMBER_SESSION_DISABLED' });
    return false;
  }

  req.member = member;
  req.accessToken = token;
  req.membershipLevel = deriveMemberTier(member);
  return true;
}

export async function requireAuthenticated(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
  dependencies: AuthDependencies = defaultAuthDependencies,
) {
  if (!(await authenticate(req, res, dependencies))) return;
  return next();
}

export function requireCapability(capability: MemberCapability) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.member) return res.status(401).json({ error: 'LOGIN_REQUIRED' });
    const membershipLevel = req.membershipLevel ?? deriveMemberTier(req.member);
    if (!hasCapability(req.member, capability)) {
      return res.status(403).json({
        error: 'CAPABILITY_REQUIRED',
        capability,
        membershipLevel,
      });
    }
    return next();
  };
}

// Backward-compatible member guard: associate, regular and admin may proceed.
export async function requireMember(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!(await authenticate(req, res))) return;
  return requireCapability('canAccessBasicInfo')(req, res, next);
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.member || !hasCapability(req.member, 'canManageMembers')) {
    return res.status(403).json({ error: 'ADMIN_REQUIRED' });
  }
  return next();
}
