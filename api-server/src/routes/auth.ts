import * as crypto from 'node:crypto';

import { Router, type IRouter } from 'express';
import { getPublicAuthSupabase, getSupabase, hasSupabaseServerKey, isSupabaseConfigured } from '../lib/supabase';

const router: IRouter = Router();

type LoginBody = {
  identifier?: unknown;
  password?: unknown;
};

const normalizeLoginName = (value: string) => value.trim().normalize('NFKC').toLowerCase();
const normalizeEmail = (value: string) => value.trim().normalize('NFKC').toLowerCase();

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * 아이디 또는 이메일로 로그인합니다.
 *
 * Supabase Auth는 이메일 로그인을 사용하므로, 아이디 로그인일 때만 서버의
 * service-role 권한으로 profiles.login_name -> auth.users.email을 안전하게 찾습니다.
 * 이메일 주소는 응답에 포함하지 않습니다.
 */
router.post('/login', async (req, res) => {
  if (!isSupabaseConfigured()) {
    return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  }

  const body = (req.body ?? {}) as LoginBody;
  const identifier = String(body.identifier ?? '').trim().normalize('NFKC');
  const password = String(body.password ?? '');

  if (!identifier || password.length < 8 || password.length > 72) {
    return res.status(400).json({ ok: false, error: 'INVALID_LOGIN_INPUT' });
  }

  try {
    let email = normalizeEmail(identifier);

    if (!isEmail(identifier)) {
      if (!hasSupabaseServerKey()) {
        return res.status(503).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_REQUIRED' });
      }

      const loginName = normalizeLoginName(identifier);
      const { data: profile, error: profileError } = await getSupabase()
        .from('profiles')
        .select('id')
        .eq('login_name', loginName)
        .maybeSingle();

      if (profileError || !profile?.id) {
        return res.status(401).json({ ok: false, error: 'INVALID_LOGIN' });
      }

      const { data: userData, error: userError } = await getSupabase().auth.admin.getUserById(String(profile.id));
      email = normalizeEmail(userData.user?.email ?? '');
      if (userError || !isEmail(email)) {
        return res.status(401).json({ ok: false, error: 'INVALID_LOGIN' });
      }
    }

    const { data, error } = await getPublicAuthSupabase().auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      return res.status(401).json({ ok: false, error: 'INVALID_LOGIN' });
    }

    if (hasSupabaseServerKey() && data.user?.id) {
      void getSupabase().from('profiles').update({ last_login_at: new Date().toISOString() }).eq('id', data.user.id);
    }

    return res.json({
      ok: true,
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in,
        expires_at: data.session.expires_at,
        token_type: data.session.token_type,
      },
    });
  } catch {
    return res.status(401).json({ ok: false, error: 'INVALID_LOGIN' });
  }
});

// ── 계정찾기 (아이디 찾기 / 비밀번호 찾기) ─────────────────────────────
// 계정 존재 여부가 과도하게 노출되지 않도록 실패 응답은 항상 동일하다.
// 생년월일 원문은 로그·응답에 남기지 않는다.

const RECOVERY_WINDOW_MS = 10 * 60_000;
const RECOVERY_MAX_ATTEMPTS = 5;
const recoveryAttempts = new Map<string, { count: number; resetAt: number }>();

function recoveryRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = recoveryAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    recoveryAttempts.set(ip, { count: 1, resetAt: now + RECOVERY_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RECOVERY_MAX_ATTEMPTS;
}

function maskLoginName(value: string): string {
  if (value.length <= 2) return `${value.slice(0, 1)}*`;
  if (value.length <= 5) return `${value.slice(0, 1)}${'*'.repeat(value.length - 2)}${value.slice(-1)}`;
  return `${value.slice(0, 3)}${'*'.repeat(Math.max(2, value.length - 7))}${value.slice(-4)}`;
}

function isBirth6(value: string): boolean {
  if (!/^[0-9]{6}$/.test(value)) return false;
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  if (month < 1 || month > 12) return false;
  const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

router.post('/find-id', async (req, res) => {
  if (!isSupabaseConfigured() || !hasSupabaseServerKey()) {
    return res.status(503).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_REQUIRED' });
  }
  if (recoveryRateLimited(`find-id:${req.ip ?? 'unknown'}`)) {
    return res.status(429).json({ ok: false, error: 'TOO_MANY_ATTEMPTS' });
  }

  const name = String(req.body?.name ?? '').trim().normalize('NFKC');
  const email = String(req.body?.email ?? '').trim().normalize('NFKC').toLowerCase();
  const birth6 = String(req.body?.birth6 ?? '').trim();

  if (!name || !isEmail(email) || !isBirth6(birth6)) {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  }

  try {
    const { data, error } = await getSupabase().rpc('find_login_name_by_identity', {
      p_email: email,
      p_name: name,
      p_birth6: birth6,
    });
    const loginName = typeof data === 'string' ? data : null;
    if (error || !loginName) {
      return res.status(404).json({ ok: false, error: 'ACCOUNT_NOT_FOUND' });
    }
    return res.json({ ok: true, maskedLoginName: maskLoginName(loginName) });
  } catch {
    return res.status(404).json({ ok: false, error: 'ACCOUNT_NOT_FOUND' });
  }
});

router.post('/find-password', async (req, res) => {
  if (!isSupabaseConfigured() || !hasSupabaseServerKey()) {
    return res.status(503).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_REQUIRED' });
  }
  if (recoveryRateLimited(`find-pw:${req.ip ?? 'unknown'}`)) {
    return res.status(429).json({ ok: false, error: 'TOO_MANY_ATTEMPTS' });
  }

  const identifier = String(req.body?.identifier ?? '').trim().normalize('NFKC');
  const name = String(req.body?.name ?? '').trim().normalize('NFKC');
  const birth6 = String(req.body?.birth6 ?? '').trim();
  const redirectTo = typeof req.body?.redirectTo === 'string' ? req.body.redirectTo : undefined;

  // 생년월일이 등록되지 않은 기존 회원을 위해 빈 값도 허용 (DB에서 hash null이면 통과)
  if (!identifier || !name || (birth6 !== '' && !isBirth6(birth6))) {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  }

  // 계정 존재 여부를 노출하지 않기 위해, 일치하는 계정이 없어도 항상 동일한 성공 응답을 준다.
  try {
    const { data, error } = await getSupabase().rpc('verify_recovery_identity', {
      p_identifier: identifier,
      p_name: name,
      p_birth6: birth6,
    });
    const email = typeof data === 'string' ? normalizeEmail(data) : '';
    if (!error && isEmail(email)) {
      // Supabase 표준 재설정 링크(만료·일회성 검증 내장)를 가입 이메일로 발송
      await getPublicAuthSupabase().auth.resetPasswordForEmail(
        email,
        redirectTo ? { redirectTo } : undefined,
      );
    }
  } catch {
    // 무시: 아래에서 동일 응답
  }
  return res.json({ ok: true });
});

export default router;
