import type { NextFunction, Request, Response } from 'express';
import { getSupabase, getUserSupabase, isSupabaseConfigured } from '../lib/supabase';

export type StoredMemberRole = 'associate' | 'full' | 'admin' | 'user';
export type MembershipRole = 'associate' | 'full' | 'admin';

export type MemberProfile = {
  id: string;
  login_name: string;
  display_name: string;
  role: StoredMemberRole;
  status: 'pending' | 'approved' | 'rejected' | 'suspended' | 'withdrawn';
};

export type AuthenticatedRequest = Request & {
  member?: MemberProfile;
  accessToken?: string;
};

export function normalizeMembershipRole(
  role?: StoredMemberRole | null,
): MembershipRole {
  if (role === 'admin') return 'admin';
  if (role === 'associate') return 'associate';
  return 'full';
}

function bearerToken(req: Request): string | null {
  const value = req.header('authorization') ?? '';
  return value.toLowerCase().startsWith('bearer ')
    ? value.slice(7).trim()
    : null;
}

// 토큰 검증 결과를 짧게 캐시해 Supabase 호출 폭주(레이트리밋 → 전체 API 멈춤)를 막는다.
// 차트 폴링(20~30초 간격) 요청마다 auth.getUser + profiles 조회가 나가면
// Supabase 에지가 유효 키 요청을 지연시키기 시작해 모든 화면이 무한 로딩된다.
const MEMBER_CACHE_TTL_MS = 60_000;
const MEMBER_CACHE_MAX = 500;
const memberCache = new Map<string, { profile: MemberProfile; expiresAt: number }>();

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('AUTH_UPSTREAM_TIMEOUT')), ms),
    ),
  ]);
}

export async function requireMember(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  if (!isSupabaseConfigured()) {
    return res.status(503).json({ error: 'AUTH_NOT_CONFIGURED' });
  }

  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'LOGIN_REQUIRED' });

  const cached = memberCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    req.member = cached.profile;
    req.accessToken = token;
    return next();
  }

  try {
    const supabase = getSupabase();
    const { data: auth, error: authError } = await withTimeout(
      supabase.auth.getUser(token),
      10_000,
    );
    if (authError || !auth.user) {
      return res.status(401).json({ error: 'INVALID_SESSION' });
    }

    const { data: profile, error } = await withTimeout(
      Promise.resolve(
        getUserSupabase(token)
          .from('profiles')
          .select('*')
          .eq('id', auth.user.id)
          .single(),
      ),
      10_000,
    );

    if (error || !profile) {
      return res.status(403).json({ error: 'PROFILE_NOT_FOUND' });
    }
    if (profile.status !== 'approved') {
      return res.status(403).json({
        error: 'MEMBER_NOT_APPROVED',
        status: profile.status,
      });
    }

    if (memberCache.size >= MEMBER_CACHE_MAX) {
      const oldest = memberCache.keys().next().value;
      if (oldest) memberCache.delete(oldest);
    }
    memberCache.set(token, {
      profile: profile as MemberProfile,
      expiresAt: Date.now() + MEMBER_CACHE_TTL_MS,
    });

    req.member = profile as MemberProfile;
    req.accessToken = token;
    return next();
  } catch (cause) {
    // Supabase가 응답하지 않으면 무한 대기 대신 명시적 오류를 돌려준다.
    const message = cause instanceof Error ? cause.message : 'AUTH_UPSTREAM_ERROR';
    return res.status(503).json({
      error: message === 'AUTH_UPSTREAM_TIMEOUT' ? 'AUTH_UPSTREAM_TIMEOUT' : 'AUTH_UPSTREAM_ERROR',
      message: '인증 서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.',
    });
  }
}

export function requireFullMember(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  const role = normalizeMembershipRole(req.member?.role);
  if (role !== 'full' && role !== 'admin') {
    return res.status(403).json({
      error: 'FULL_MEMBER_REQUIRED',
      message: '정회원 이상만 사용할 수 있는 기능입니다.',
    });
  }
  return next();
}

export function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  if (normalizeMembershipRole(req.member?.role) !== 'admin') {
    return res.status(403).json({
      error: 'ADMIN_REQUIRED',
      message: '관리자만 사용할 수 있는 기능입니다.',
    });
  }
  return next();
}
