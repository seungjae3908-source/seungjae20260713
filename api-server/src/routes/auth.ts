import { createHash } from 'node:crypto';
import { Router, type IRouter } from 'express';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase';

const router: IRouter = Router();

function normalizeIdentifier(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

function internalEmail(identifier: string): string {
  const normalized = normalizeIdentifier(identifier);
  const token = createHash('sha256')
    .update(`seungjae-stock-account:${normalized}`)
    .digest()
    .subarray(0, 20)
    .toString('hex');
  return `${token}@accounts.seungjae-stock.com`;
}

function isInvalidCredentials(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('invalid login credentials') ||
    normalized.includes('invalid credentials') ||
    normalized.includes('email not confirmed')
  );
}

router.post('/login', async (req, res) => {
  const identifier = typeof req.body?.identifier === 'string'
    ? req.body.identifier.trim()
    : '';
  const password = typeof req.body?.password === 'string'
    ? req.body.password
    : '';

  if (!identifier || !password) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_LOGIN_REQUEST',
    });
  }

  if (!isSupabaseConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'AUTH_NOT_CONFIGURED',
    });
  }

  try {
    const { data, error } = await getSupabase().auth.signInWithPassword({
      email: internalEmail(identifier),
      password,
    });

    if (error || !data.session) {
      const message = error?.message ?? '';
      if (isInvalidCredentials(message)) {
        return res.status(401).json({
          ok: false,
          error: 'INVALID_CREDENTIALS',
        });
      }

      if (message.toLowerCase().includes('rate limit')) {
        return res.status(429).json({
          ok: false,
          error: 'AUTH_RATE_LIMITED',
        });
      }

      return res.status(502).json({
        ok: false,
        error: 'AUTH_PROVIDER_ERROR',
      });
    }

    return res.status(200).json({
      ok: true,
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at ?? null,
        token_type: data.session.token_type,
      },
      user: {
        id: data.user.id,
      },
    });
  } catch {
    return res.status(503).json({
      ok: false,
      error: 'AUTH_TEMPORARILY_UNAVAILABLE',
    });
  }
});

export default router;
