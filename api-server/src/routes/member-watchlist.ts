import { Router, type IRouter } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { listMemberWatchlist, syncMemberWatchlist } from '../services/member-watchlist.service';

const router: IRouter = Router();

function identityOverrideRequested(req: AuthenticatedRequest): boolean {
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : null;
  return req.query.userId !== undefined
    || req.query.deviceId !== undefined
    || body?.userId !== undefined
    || body?.deviceId !== undefined;
}

function memberContext(req: AuthenticatedRequest): { userId: string; accessToken: string } | null {
  const userId = req.member?.id?.trim();
  const accessToken = req.accessToken?.trim();
  return userId && accessToken ? { userId, accessToken } : null;
}

router.get('/member-watchlist', async (req: AuthenticatedRequest, res) => {
  if (identityOverrideRequested(req)) {
    return res.status(400).json({ ok: false, error: 'IDENTITY_OVERRIDE_REJECTED' });
  }
  const context = memberContext(req);
  if (!context) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });

  try {
    const items = await listMemberWatchlist(context.userId, context.accessToken);
    return res.json({
      ok: true,
      items,
      unresolvedCount: items.filter((item) => item.market === 'UNRESOLVED').length,
      identitySource: 'AUTHENTICATED_MEMBER',
    });
  } catch {
    return res.status(503).json({
      ok: false,
      error: 'MEMBER_WATCHLIST_UNAVAILABLE',
      items: [],
    });
  }
});

router.post('/member-watchlist/sync', async (req: AuthenticatedRequest, res) => {
  if (identityOverrideRequested(req)) {
    return res.status(400).json({ ok: false, error: 'IDENTITY_OVERRIDE_REJECTED' });
  }
  const context = memberContext(req);
  if (!context) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
  const items = req.body?.items;
  if (!Array.isArray(items)) {
    return res.status(400).json({ ok: false, error: 'ITEMS_REQUIRED' });
  }
  if (items.length > 200) {
    return res.status(400).json({ ok: false, error: 'WATCHLIST_TOO_LARGE' });
  }

  try {
    const result = await syncMemberWatchlist(context.userId, context.accessToken, items);
    return res.json({
      ok: true,
      items: result.items,
      unresolvedCount: result.unresolvedCount,
      identitySource: 'AUTHENTICATED_MEMBER',
    });
  } catch {
    return res.status(503).json({
      ok: false,
      error: 'MEMBER_WATCHLIST_UNAVAILABLE',
      items: [],
    });
  }
});

export default router;
