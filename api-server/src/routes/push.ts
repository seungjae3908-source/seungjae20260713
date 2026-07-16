import { Router, type IRouter } from 'express';
import { type AuthenticatedRequest } from '../middleware/auth';
import { getSupabase } from '../lib/supabase';
import {
  DEFAULT_NOTIFICATION_TYPES,
  deliverMemberNotification,
  ensureNotificationPreferences,
  isVapidReady,
  runPriceAlertMonitorOnce,
} from '../services/notification.service';

const router: IRouter = Router();
function getEndpoint(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const endpoint = (body as { endpoint?: unknown }).endpoint;
  return typeof endpoint === 'string' && endpoint.length > 0 ? endpoint : null;
}

router.get('/notifications/preferences', async (req: AuthenticatedRequest, res) => {
  try { return res.json({ preferences: await ensureNotificationPreferences(req.member!.id), vapidReady: isVapidReady() }); }
  catch (error) { console.error('notification preferences read error:', error); return res.status(500).json({ error: 'NOTIFICATION_PREFERENCES_READ_FAILED' }); }
});

router.put('/notifications/preferences', async (req: AuthenticatedRequest, res) => {
  const enabledTypes = Array.isArray(req.body?.enabledTypes) ? [...new Set<string>((req.body.enabledTypes as unknown[]).map(String))].filter((item: string) => DEFAULT_NOTIFICATION_TYPES.includes(item as any)) : [...DEFAULT_NOTIFICATION_TYPES];
  const changes = { member_id: req.member!.id, enabled_types: enabledTypes, app_enabled: req.body?.appEnabled !== false, push_enabled: req.body?.pushEnabled === true, updated_at: new Date().toISOString() };
  const { data, error } = await getSupabase().from('notification_preferences').upsert(changes, { onConflict: 'member_id' }).select('*').single();
  if (error) return res.status(500).json({ error: 'NOTIFICATION_PREFERENCES_SAVE_FAILED' });
  return res.json({ preferences: data });
});

router.post('/push/subscribe', async (req: AuthenticatedRequest, res) => {
  const endpoint = getEndpoint(req.body);
  if (!endpoint) return res.status(400).json({ error: 'INVALID_SUBSCRIPTION' });
  const { error } = await getSupabase().from('push_subscriptions').upsert({ member_id: req.member!.id, endpoint, subscription: req.body, updated_at: new Date().toISOString() }, { onConflict: 'endpoint' });
  if (error) return res.status(500).json({ error: 'PUSH_SUBSCRIPTION_SAVE_FAILED' });
  await getSupabase().from('notification_preferences').upsert({ member_id: req.member!.id, push_enabled: true, updated_at: new Date().toISOString() }, { onConflict: 'member_id' });
  const { count } = await getSupabase().from('push_subscriptions').select('*', { count: 'exact', head: true }).eq('member_id', req.member!.id);
  return res.json({ ok: true, count: count ?? 0, vapidReady: isVapidReady() });
});

router.post('/push/unsubscribe', async (req: AuthenticatedRequest, res) => {
  const endpoint = getEndpoint(req.body);
  if (!endpoint) return res.status(400).json({ error: 'INVALID_ENDPOINT' });
  const { error } = await getSupabase().from('push_subscriptions').delete().eq('member_id', req.member!.id).eq('endpoint', endpoint);
  if (error) return res.status(500).json({ error: 'PUSH_UNSUBSCRIBE_FAILED' });
  return res.json({ ok: true });
});

router.post('/push/test', async (req: AuthenticatedRequest, res) => {
  const body = typeof req.body === 'object' && req.body ? req.body as Record<string, unknown> : {};
  const result = await deliverMemberNotification({
    memberId: req.member!.id,
    type: 'system',
    title: String(body.title ?? '지식정보 테스트 알림'),
    body: String(body.body ?? '회원별 통합 알림 연결 테스트입니다.'),
    url: String(body.url ?? '/alerts'),
    app: true,
    push: true,
  });
  return res.json({ ok: true, ...result, vapidReady: isVapidReady() });
});

router.post('/notifications/price-alerts/check-now', async (_req: AuthenticatedRequest, res) => {
  try {
    return res.json({ ok: true, ...(await runPriceAlertMonitorOnce()) });
  } catch (error) {
    console.error('price alert manual check error:', error);
    return res.status(500).json({ error: 'PRICE_ALERT_CHECK_FAILED' });
  }
});

router.get('/notifications/history', async (req: AuthenticatedRequest, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 100) || 100));
  const { data, error } = await getSupabase().from('notification_history').select('*').eq('member_id', req.member!.id).order('created_at', { ascending: false }).limit(limit);
  if (error) return res.status(500).json({ error: 'NOTIFICATION_HISTORY_READ_FAILED' });
  return res.json({ notifications: data ?? [], count: data?.length ?? 0 });
});

router.patch('/notifications/history/:id/read', async (req: AuthenticatedRequest, res) => {
  const { data, error } = await getSupabase().from('notification_history').update({ read_at: new Date().toISOString() }).eq('id', req.params.id).eq('member_id', req.member!.id).select('*').maybeSingle();
  if (error) return res.status(500).json({ error: 'NOTIFICATION_HISTORY_UPDATE_FAILED' });
  return res.json({ notification: data });
});

router.get('/notifications/price-alerts', async (req: AuthenticatedRequest, res) => {
  const { data, error } = await getSupabase().from('price_alerts').select('*').eq('member_id', req.member!.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'PRICE_ALERT_LIST_FAILED' });
  return res.json({ alerts: data ?? [] });
});

router.post('/notifications/price-alerts', async (req: AuthenticatedRequest, res) => {
  const assetType = ['stock','coin_spot','coin_futures'].includes(String(req.body?.assetType)) ? String(req.body.assetType) : null;
  const direction = ['above','below'].includes(String(req.body?.direction)) ? String(req.body.direction) : null;
  const symbol = String(req.body?.symbol ?? '').trim().toUpperCase();
  const targetPrice = Number(req.body?.targetPrice);
  if (!assetType || !direction || !symbol || !Number.isFinite(targetPrice) || targetPrice <= 0) return res.status(400).json({ error: 'INVALID_PRICE_ALERT' });
  const row = { member_id: req.member!.id, asset_type: assetType, market: String(req.body?.market ?? ''), symbol, direction, target_price: targetPrice, repeat_enabled: req.body?.repeatEnabled === true, app_enabled: req.body?.appEnabled !== false, push_enabled: req.body?.pushEnabled !== false, expires_at: req.body?.expiresAt || null, enabled: true, updated_at: new Date().toISOString() };
  const { data, error } = await getSupabase().from('price_alerts').upsert(row, { onConflict: 'member_id,asset_type,market,symbol,direction,target_price' }).select('*').single();
  if (error) return res.status(500).json({ error: 'PRICE_ALERT_SAVE_FAILED' });
  return res.json({ alert: data });
});

router.delete('/notifications/price-alerts/:id', async (req: AuthenticatedRequest, res) => {
  const { error } = await getSupabase().from('price_alerts').delete().eq('id', req.params.id).eq('member_id', req.member!.id);
  if (error) return res.status(500).json({ error: 'PRICE_ALERT_DELETE_FAILED' });
  return res.json({ ok: true });
});

export default router;
