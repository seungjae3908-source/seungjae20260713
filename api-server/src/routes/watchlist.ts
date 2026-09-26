import { Router, type IRouter } from 'express';
import memberWatchlistRouter from './member-watchlist';

const router: IRouter = Router();

// Canonical Watchlist identity is the authenticated member only. This router is
// mounted behind the existing authentication/basic-info boundary; the child
// rejects any caller-supplied userId/deviceId override as an additional guard.
router.use('/', memberWatchlistRouter);

function legacyDeviceWatchlistDisabled(
  _req: unknown,
  res: { status: (code: number) => { json: (body: unknown) => unknown }; setHeader: (name: string, value: string) => void },
) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(410).json({
    ok: false,
    error: 'LEGACY_DEVICE_WATCHLIST_DISABLED',
    canonicalReadPath: '/api/member-watchlist',
    canonicalSyncPath: '/api/member-watchlist/sync',
  });
}

// Legacy deviceId storage is intentionally unreachable. Keeping explicit 410
// handlers prevents old clients from silently falling back to shared/default
// device ownership while giving them a deterministic migration error.
router.get('/watchlist', legacyDeviceWatchlistDisabled);
router.post('/watchlist/sync', legacyDeviceWatchlistDisabled);
router.put('/watchlist/:ticker', legacyDeviceWatchlistDisabled);
router.delete('/watchlist/:ticker', legacyDeviceWatchlistDisabled);

export default router;
