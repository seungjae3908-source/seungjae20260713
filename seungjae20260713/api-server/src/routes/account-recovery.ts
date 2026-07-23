import { createHash, createHmac } from 'node:crypto';
import { Router, type Request } from 'express';
import { getSupabase, hasSupabaseServerKey } from '../lib/supabase';

const router = Router();
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

function rateKey(req: Request, action: string): string {
  return `${action}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
}

function allowAttempt(req: Request, action: string): boolean {
  const key = rateKey(req, action);
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (current.count >= MAX_ATTEMPTS) return false;
  current.count += 1;
  return true;
}

function normalizeLoginName(value: unknown): string | null {
  const name = String(value ?? '').trim().normalize('NFKC').toLowerCase();
  return name.length >= 2 && name.length <= 20 && /^[가-힣a-z0-9 _.-]+$/i.test(name) ? name : null;
}

function normalizeDisplayName(value: unknown): string | null {
  const name = String(value ?? '').trim().normalize('NFKC');
  return name.length >= 2 && name.length <= 40 && /^[가-힣a-zA-Z ]+$/.test(name) ? name : null;
}

function normalizeBirthDate(value: unknown): string | null {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const year = 2000 + Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const day = Number(digits.slice(4, 6));
  if (month < 1 || month > 12 || day < 1) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth ? digits : null;
}

function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 72;
}

function pepper(): string | null {
  const value = String(process.env.ACCOUNT_RECOVERY_PEPPER ?? '').trim();
  return value.length >= 32 ? value : null;
}

function birthDigest(birthDate: string, secret: string): string {
  return createHmac('sha256', secret).update(`birth-date:${birthDate}`).digest('hex');
}

function internalEmail(loginName: string): string {
  const token = createHash('sha256')
    .update(`seungjae-stock-account:${loginName}`)
    .digest('hex')
    .slice(0, 40);
  return `${token}@accounts.seungjae-stock.com`;
}

function maskLoginName(value: string): string {
  if (value.length <= 2) return `${value[0] ?? '*'}*`;
  return `${value.slice(0, 2)}${'*'.repeat(Math.max(2, value.length - 2))}`;
}

function guardConfiguration(res: { status: (code: number) => { json: (body: unknown) => unknown } }): string | null {
  const secret = pepper();
  if (!hasSupabaseServerKey() || !secret) {
    res.status(503).json({
      error: 'ACCOUNT_RECOVERY_NOT_CONFIGURED',
      message: 'SUPABASE 서비스 키와 32자 이상의 ACCOUNT_RECOVERY_PEPPER 설정이 필요합니다.',
    });
    return null;
  }
  return secret;
}

router.post('/auth/register', async (req, res) => {
  if (!allowAttempt(req, 'register')) return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
  const secret = guardConfiguration(res);
  if (!secret) return;
  const loginName = normalizeLoginName(req.body?.loginName);
  const displayName = normalizeDisplayName(req.body?.displayName);
  const birthDate = normalizeBirthDate(req.body?.birthDate);
  const password = req.body?.password;
  if (!loginName || !displayName || !birthDate || !validPassword(password)) {
    return res.status(400).json({ error: 'INVALID_REGISTRATION' });
  }

  const { data, error } = await getSupabase().auth.admin.createUser({
    email: internalEmail(loginName),
    password,
    email_confirm: true,
    user_metadata: {
      login_name: loginName,
      display_name: displayName,
      birth_date_digest: birthDigest(birthDate, secret),
    },
  });
  if (error || !data.user) {
    const duplicate = error?.message.toLowerCase().includes('already');
    return res.status(duplicate ? 409 : 500).json({ error: duplicate ? 'LOGIN_NAME_EXISTS' : 'REGISTRATION_FAILED' });
  }
  return res.status(201).json({ ok: true, status: 'pending' });
});

router.post('/auth/find-id', async (req, res) => {
  if (!allowAttempt(req, 'find-id')) return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
  const secret = guardConfiguration(res);
  if (!secret) return;
  const displayName = normalizeDisplayName(req.body?.displayName);
  const birthDate = normalizeBirthDate(req.body?.birthDate);
  if (!displayName || !birthDate) return res.status(400).json({ error: 'INVALID_RECOVERY_INPUT' });

  const { data, error } = await getSupabase()
    .from('profiles')
    .select('login_name')
    .eq('display_name', displayName)
    .eq('birth_date_digest', birthDigest(birthDate, secret))
    .limit(1)
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'ACCOUNT_LOOKUP_FAILED' });
  if (!data) return res.status(404).json({ error: 'ACCOUNT_NOT_FOUND' });
  return res.json({ maskedLoginName: maskLoginName(String(data.login_name)) });
});

router.post('/auth/reset-password', async (req, res) => {
  if (!allowAttempt(req, 'reset-password')) return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
  const secret = guardConfiguration(res);
  if (!secret) return;
  const loginName = normalizeLoginName(req.body?.loginName);
  const birthDate = normalizeBirthDate(req.body?.birthDate);
  const newPassword = req.body?.newPassword;
  if (!loginName || !birthDate || !validPassword(newPassword)) {
    return res.status(400).json({ error: 'INVALID_RECOVERY_INPUT' });
  }

  const { data: profile, error: profileError } = await getSupabase()
    .from('profiles')
    .select('id')
    .eq('login_name', loginName)
    .eq('birth_date_digest', birthDigest(birthDate, secret))
    .maybeSingle();
  if (profileError) return res.status(500).json({ error: 'ACCOUNT_LOOKUP_FAILED' });
  if (!profile) return res.status(404).json({ error: 'ACCOUNT_NOT_FOUND' });

  const { error } = await getSupabase().auth.admin.updateUserById(String(profile.id), { password: newPassword });
  if (error) return res.status(500).json({ error: 'PASSWORD_RESET_FAILED' });
  return res.json({ ok: true });
});

export default router;
