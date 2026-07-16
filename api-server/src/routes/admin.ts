import { Router } from 'express';
import { requireAdmin, requireMember, type AuthenticatedRequest } from '../middleware/auth';
import { getSupabase, getUserSupabase, hasSupabaseServerKey } from '../lib/supabase';

const router = Router();
router.use(requireMember, requireAdmin);

// 서비스 역할 키가 없으면 관리자 본인 토큰으로 동작한다.
// RLS의 "admins read/update profiles" 정책이 권한을 보장한다.
function adminDb(req: AuthenticatedRequest) {
  return hasSupabaseServerKey() ? getSupabase() : getUserSupabase(req.accessToken!);
}

router.get('/members', async (req: AuthenticatedRequest, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  let query = adminDb(req).from('profiles').select('*').order('created_at', { ascending: false }).limit(500);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'MEMBER_LIST_FAILED' });
  return res.json({ members: data ?? [] });
});

router.patch('/members/:id', async (req: AuthenticatedRequest, res) => {
  const allowedStatus = ['pending', 'approved', 'rejected', 'suspended', 'withdrawn'];
  const allowedRole = ['user', 'admin'];
  const status = allowedStatus.includes(req.body?.status) ? req.body.status : undefined;
  const role = allowedRole.includes(req.body?.role) ? req.body.role : undefined;
  if (!status && !role) return res.status(400).json({ error: 'NO_VALID_CHANGE' });
  if (req.params.id === req.member?.id && (status && status !== 'approved' || role === 'user')) {
    return res.status(409).json({ error: 'CANNOT_REMOVE_OWN_ADMIN_ACCESS' });
  }
  const changes: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (status) Object.assign(changes, { status, approved_at: status === 'approved' ? new Date().toISOString() : null, approved_by: status === 'approved' ? req.member?.id : null });
  if (role) changes.role = role;
  const { data, error } = await adminDb(req).from('profiles').update(changes).eq('id', req.params.id).select('*').single();
  if (error) return res.status(500).json({ error: 'MEMBER_UPDATE_FAILED' });
  // 감사 로그는 best-effort: 서비스 역할 키가 없으면 RLS로 인해 기록되지 않을 수 있음
  await getSupabase().from('audit_logs').insert({ actor_id: req.member?.id, action: 'member.update', target_type: 'profile', target_id: req.params.id, details: changes, ip_address: req.ip });
  return res.json({ member: data });
});

router.get('/audit-logs', async (req: AuthenticatedRequest, res) => {
  const { data, error } = await adminDb(req).from('audit_logs').select('*').order('created_at', { ascending: false }).limit(500);
  if (error) return res.status(500).json({ error: 'AUDIT_LIST_FAILED' });
  return res.json({ logs: data ?? [] });
});

router.get('/system', (req: AuthenticatedRequest, res) => {
  const maskHost = (value?: string) => { if (!value) return null; try { const url = new URL(value); return `${url.protocol}//${url.hostname.replace(/^[^.]+/, '***')}${url.port ? `:${url.port}` : ''}`; } catch { return 'configured'; } };
  return res.json({ appVersion: process.env.APP_VERSION ?? 'development', environment: process.env.NODE_ENV ?? 'development', kiwoomMode: process.env.KIWOOM_MODE ?? 'disabled', apiBase: maskHost(process.env.PUBLIC_API_URL), serverBase: maskHost(process.env.SERVER_URL), databaseConfigured: Boolean(process.env.SUPABASE_URL), autoTradeEnabled: process.env.KIWOOM_AUTO_TRADE_ENABLED === 'true', checkedAt: new Date().toISOString(), requestedBy: req.member?.id });
});

export default router;
