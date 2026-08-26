import type { NextFunction, Response } from 'express';
import { hasSupabaseServerKey } from '../../lib/supabase';
import { requireAuthenticated, type AuthenticatedRequest } from '../../middleware/auth';
import { runtimeDeviceTrustService } from './device-trust.route';
import {
  DEVICE_SESSION_HEADER,
  DeviceTrustError,
  deviceTrustEnforcement,
} from './device-trust.service';

function isPublicDeviceTrustBypass(req: AuthenticatedRequest): boolean {
  if (req.method === 'OPTIONS') return true;
  const path = req.path || '/';
  return path === '/'
    || path === '/healthz'
    || path.startsWith('/health/')
    || path === '/health'
    || path.startsWith('/telegram/webhook')
    || path.startsWith('/device-trust/');
}

async function authenticateForGate(req: AuthenticatedRequest, res: Response): Promise<boolean> {
  let passed = false;
  await requireAuthenticated(req, res, () => {
    passed = true;
  });
  return passed;
}

export async function deviceTrustAppGate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  if (deviceTrustEnforcement() !== 'required' || isPublicDeviceTrustBypass(req)) {
    next();
    return;
  }

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!hasSupabaseServerKey()) {
    res.status(503).json({ ok: false, error: 'DEVICE_TRUST_UNAVAILABLE' });
    return;
  }

  const authenticated = await authenticateForGate(req, res);
  if (!authenticated || res.headersSent || !req.member?.id) return;

  try {
    await runtimeDeviceTrustService.requireValidSession(
      req.member.id,
      req.header(DEVICE_SESSION_HEADER) ?? null,
    );
    next();
  } catch (error) {
    if (error instanceof DeviceTrustError) {
      res.status(428).json({
        ok: false,
        error: 'DEVICE_TRUST_REQUIRED',
        reason: error.code,
      });
      return;
    }
    res.status(503).json({ ok: false, error: 'DEVICE_TRUST_UNAVAILABLE' });
  }
}
