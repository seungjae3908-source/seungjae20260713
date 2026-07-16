import type { NextFunction, Request, Response } from 'express';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase';

export type MemberProfile = {
  id: string;
  login_name: string;
  display_name: string;
  role: 'user' | 'admin';
  status: 'pending' | 'approved' | 'rejected' | 'suspended' | 'withdrawn';
};

export type AuthenticatedRequest = Request & { member?: MemberProfile; accessToken?: string };

function bearerToken(req: Request): string | null {
  const value = req.header('authorization') ?? '';
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : null;
}

export async function requireMember(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!isSupabaseConfigured()) return res.status(503).json({ error: 'AUTH_NOT_CONFIGURED' });
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'LOGIN_REQUIRED' });

  const supabase = getSupabase();
  const { data: auth, error: authError } = await supabase.auth.getUser(token);
  if (authError || !auth.user) return res.status(401).json({ error: 'INVALID_SESSION' });

  const { data: profile, error } = await supabase.from('profiles').select('*').eq('id', auth.user.id).single();
  if (error || !profile) return res.status(403).json({ error: 'PROFILE_NOT_FOUND' });
  if (profile.status !== 'approved') return res.status(403).json({ error: 'MEMBER_NOT_APPROVED', status: profile.status });

  req.member = profile as MemberProfile;
  req.accessToken = token;
  return next();
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (req.member?.role !== 'admin') return res.status(403).json({ error: 'ADMIN_REQUIRED' });
  return next();
}

