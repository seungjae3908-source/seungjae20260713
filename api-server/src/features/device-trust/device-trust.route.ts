import { Router, type Response } from 'express';
import { hasSupabaseServerKey } from '../../lib/supabase';
import { requireAuthenticated, type AuthenticatedRequest } from '../../middleware/auth';
import {
  DEVICE_SESSION_HEADER,
  DeviceTrustError,
  DeviceTrustService,
} from './device-trust.service';
import { SupabaseDeviceTrustRepository } from './device-trust.store';

const router = Router();
const service = new DeviceTrustService(new SupabaseDeviceTrustRepository());

function memberId(req: AuthenticatedRequest): string {
  if (!req.member?.id) throw new DeviceTrustError('LOGIN_REQUIRED', 401);
  return req.member.id;
}

function deviceSession(req: AuthenticatedRequest): string | null {
  return req.header(DEVICE_SESSION_HEADER) ?? null;
}

function sendFailure(res: Response, error: unknown) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (error instanceof DeviceTrustError) {
    return res.status(error.status).json({ ok: false, error: error.code });
  }
  return res.status(503).json({ ok: false, error: 'DEVICE_TRUST_UNAVAILABLE' });
}

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  next();
});
router.use(requireAuthenticated);
router.use((_req, res, next) => {
  if (!hasSupabaseServerKey()) {
    res.status(503).json({ ok: false, error: 'DEVICE_TRUST_SERVER_DATABASE_NOT_CONFIGURED' });
    return;
  }
  next();
});

router.get('/status', async (req: AuthenticatedRequest, res) => {
  try {
    const status = await service.status(memberId(req), deviceSession(req));
    res.json({ ok: true, ...status });
  } catch (error) {
    sendFailure(res, error);
  }
});

router.post('/enroll/challenge', async (req: AuthenticatedRequest, res) => {
  try {
    const result = await service.issueEnrollmentChallenge({
      userId: memberId(req),
      publicKeyJwk: req.body?.publicKeyJwk,
      label: req.body?.label,
      platform: req.body?.platform,
      pairingToken: req.body?.pairingToken,
    });
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    sendFailure(res, error);
  }
});

router.post('/verify/challenge', async (req: AuthenticatedRequest, res) => {
  try {
    const deviceId = String(req.body?.deviceId ?? '').trim();
    const result = await service.issueVerificationChallenge(memberId(req), deviceId);
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    sendFailure(res, error);
  }
});

router.post('/challenge/complete', async (req: AuthenticatedRequest, res) => {
  try {
    const result = await service.completeChallenge({
      userId: memberId(req),
      deviceId: String(req.body?.deviceId ?? '').trim(),
      challengeId: String(req.body?.challengeId ?? '').trim(),
      challenge: String(req.body?.challenge ?? '').trim(),
      signature: String(req.body?.signature ?? '').trim(),
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    sendFailure(res, error);
  }
});

router.post('/pairing-token', async (req: AuthenticatedRequest, res) => {
  try {
    const result = await service.createPairingToken(memberId(req), deviceSession(req));
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    sendFailure(res, error);
  }
});

router.get('/devices', async (req: AuthenticatedRequest, res) => {
  try {
    const devices = await service.listDevices(memberId(req), deviceSession(req));
    res.json({ ok: true, devices });
  } catch (error) {
    sendFailure(res, error);
  }
});

router.delete('/devices/:deviceId', async (req: AuthenticatedRequest, res) => {
  try {
    const result = await service.revokeDevice(
      memberId(req),
      String(req.params.deviceId ?? '').trim(),
      deviceSession(req),
    );
    res.json({ ok: true, ...result });
  } catch (error) {
    sendFailure(res, error);
  }
});

export { service as runtimeDeviceTrustService };
export default router;
