import { Router, type IRouter } from 'express';

import {
  requireAuthenticated,
  type AuthenticatedRequest,
} from '../middleware/auth';
import {
  deleteTossReadonlyCredentials,
  getTossReadonlyConnectionStatus,
  getTossReadonlyCredentials,
  saveTossReadonlyCredentials,
} from '../features/toss-readonly/toss-readonly.repository';
import {
  HttpTossReadonlyTransport,
  readTossAccountSnapshot,
} from '../features/toss-readonly/toss-readonly.service';

const router: IRouter = Router();

router.use(requireAuthenticated);
router.use((req: AuthenticatedRequest, res, next) => {
  if (req.membershipLevel !== 'regular' && req.membershipLevel !== 'admin') {
    return res.status(403).json({
      ok: false,
      error: 'TOSS_READONLY_REGULAR_MEMBERSHIP_REQUIRED',
      readOnly: true,
      orderRequests: 0,
      cancelRequests: 0,
    });
  }
  return next();
});

function owner(req: AuthenticatedRequest) {
  const userId = req.member?.id?.trim() ?? '';
  if (!userId) throw new Error('LOGIN_REQUIRED');
  return userId;
}

function errorResponse(error: unknown) {
  const code = error instanceof Error && error.message ? error.message : 'TOSS_READONLY_FAILED';
  const status = code === 'LOGIN_REQUIRED'
    ? 401
    : code.includes('MEMBERSHIP') || code.includes('USER_SCOPE')
      ? 403
      : code === 'TOSS_CONNECTION_NOT_CONFIGURED'
        ? 409
        : code.startsWith('TOSS_HTTP_') || code.includes('TOKEN')
          ? 502
          : 503;
  return { status, code };
}

router.get('/status', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const status = await getTossReadonlyConnectionStatus(owner(req));
    return res.json({
      ok: true,
      provider: 'toss',
      readOnly: true,
      configured: status.configured,
      connected: false,
      liveConnectivityChecked: false,
      updatedAt: status.updatedAt,
      credentialsReturned: false,
      fullAccountNumberReturned: false,
      providerRequests: 0,
      orderRequests: 0,
      cancelRequests: 0,
      amendRequests: 0,
      transferRequests: 0,
      withdrawalRequests: 0,
      liveTradingEnabled: false,
      autoTradingEnabled: false,
    });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({
      ok: false,
      error: failure.code,
      readOnly: true,
      providerRequests: 0,
      orderRequests: 0,
      cancelRequests: 0,
    });
  }
});

router.post('/connection', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId : '';
    const clientSecret = typeof req.body?.clientSecret === 'string' ? req.body.clientSecret : '';
    const saved = await saveTossReadonlyCredentials(owner(req), { clientId, clientSecret });
    return res.status(201).json({
      ok: true,
      provider: 'toss',
      readOnly: true,
      configured: saved.configured,
      updatedAt: saved.updatedAt,
      credentialsReturned: false,
      providerRequests: 0,
      orderRequests: 0,
      cancelRequests: 0,
      liveTradingEnabled: false,
      autoTradingEnabled: false,
    });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({
      ok: false,
      error: failure.code,
      readOnly: true,
      credentialsReturned: false,
      providerRequests: 0,
      orderRequests: 0,
      cancelRequests: 0,
    });
  }
});

router.delete('/connection', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    await deleteTossReadonlyCredentials(owner(req));
    return res.json({
      ok: true,
      provider: 'toss',
      readOnly: true,
      configured: false,
      credentialsReturned: false,
      providerRequests: 0,
      orderRequests: 0,
      cancelRequests: 0,
      liveTradingEnabled: false,
      autoTradingEnabled: false,
    });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({
      ok: false,
      error: failure.code,
      readOnly: true,
      providerRequests: 0,
      orderRequests: 0,
      cancelRequests: 0,
    });
  }
});

router.get('/snapshot', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    if (req.header('x-toss-readonly-intent') !== 'account-snapshot') {
      return res.status(428).json({
        ok: false,
        error: 'TOSS_READONLY_EXPLICIT_INTENT_REQUIRED',
        readOnly: true,
        providerRequests: 0,
        orderRequests: 0,
        cancelRequests: 0,
      });
    }
    const userId = owner(req);
    const credentials = await getTossReadonlyCredentials(userId);
    if (!credentials) throw new Error('TOSS_CONNECTION_NOT_CONFIGURED');
    const snapshot = await readTossAccountSnapshot({
      userId,
      credentials,
      transport: new HttpTossReadonlyTransport(),
    });
    return res.json({
      ...snapshot,
      credentialsReturned: false,
      fullAccountNumberReturned: false,
      liveTradingEnabled: false,
      autoTradingEnabled: false,
    });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({
      ok: false,
      error: failure.code,
      readOnly: true,
      credentialsReturned: false,
      fullAccountNumberReturned: false,
      orderRequests: 0,
      cancelRequests: 0,
      amendRequests: 0,
      transferRequests: 0,
      withdrawalRequests: 0,
      liveTradingEnabled: false,
      autoTradingEnabled: false,
    });
  }
});

export default router;
