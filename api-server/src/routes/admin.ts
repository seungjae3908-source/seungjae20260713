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

// 이메일은 전체를 노출하지 않고 마스킹해 표시한다. (예: se***@gm***.com)
function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const maskedLocal = local.length <= 2 ? `${local.slice(0, 1)}*` : `${local.slice(0, 2)}${'*'.repeat(Math.min(4, local.length - 2))}`;
  const dot = domain.lastIndexOf('.');
  const domainName = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  const maskedDomain = domainName.length <= 2 ? `${domainName.slice(0, 1)}*` : `${domainName.slice(0, 2)}${'*'.repeat(Math.min(4, domainName.length - 2))}`;
  return `${maskedLocal}@${maskedDomain}${tld}`;
}

router.get('/members', async (req: AuthenticatedRequest, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  let query = adminDb(req).from('profiles').select('*').order('created_at', { ascending: false }).limit(500);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'MEMBER_LIST_FAILED' });

  // 이메일(마스킹)을 함께 내려준다. 조회 실패 시에도 목록은 그대로 반환.
  const members = (data ?? []) as Array<Record<string, unknown>>;
  try {
    // is_admin()이 호출자(auth.uid()) 기준으로 동작하므로 관리자 본인 토큰으로 호출한다.
    const { data: emails } = await getUserSupabase(req.accessToken!).rpc('admin_list_member_emails');
    if (Array.isArray(emails)) {
      const emailById = new Map<string, string>(emails.map((row: { id: string; email: string }) => [String(row.id), String(row.email ?? '')]));
      for (const member of members) {
        const email = emailById.get(String(member.id));
        member.masked_email = email ? maskEmail(email) : null;
      }
    }
  } catch {
    // 마이그레이션 전이거나 함수가 없으면 이메일 없이 반환
  }
  return res.json({ members });
});

router.patch('/members/:id', async (req: AuthenticatedRequest, res) => {
  const allowedStatus = ['pending', 'approved', 'rejected', 'suspended', 'withdrawn'];
  const allowedRole = ['associate', 'full', 'admin'];
  const status = allowedStatus.includes(req.body?.status) ? req.body.status : undefined;
  const role = allowedRole.includes(req.body?.role) ? req.body.role : undefined;
  if (!status && !role) return res.status(400).json({ error: 'NO_VALID_CHANGE' });
  if (req.params.id === req.member?.id && (status && status !== 'approved' || Boolean(role && role !== 'admin'))) {
    return res.status(409).json({ error: 'CANNOT_REMOVE_OWN_ADMIN_ACCESS' });
  }

  // 마지막 관리자 보호: 대상이 유일한 승인 관리자면 강등/정지시키지 않는다.
  const demotesRole = Boolean(role && role !== 'admin');
  const removesApproval = Boolean(status && status !== 'approved');
  if (demotesRole || removesApproval) {
    const { data: target } = await adminDb(req).from('profiles').select('role,status').eq('id', req.params.id).maybeSingle();
    if (target?.role === 'admin' && target?.status === 'approved') {
      const { count } = await adminDb(req)
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'admin')
        .eq('status', 'approved');
      if ((count ?? 0) <= 1) {
        return res.status(409).json({ error: 'CANNOT_REMOVE_LAST_ADMIN' });
      }
    }
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


router.get('/recovery-requests', async (req: AuthenticatedRequest, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  let query = adminDb(req).from('account_recovery_requests').select('*').order('created_at', { ascending: false }).limit(500);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'RECOVERY_LIST_FAILED' });
  return res.json({ requests: data ?? [] });
});

router.patch('/recovery-requests/:id', async (req: AuthenticatedRequest, res) => {
  const status = ['resolved', 'rejected'].includes(req.body?.status) ? req.body.status : undefined;
  if (!status) return res.status(400).json({ error: 'INVALID_RECOVERY_STATUS' });
  const { data, error } = await adminDb(req)
    .from('account_recovery_requests')
    .update({ status, resolved_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: 'RECOVERY_UPDATE_FAILED' });
  await getSupabase().from('audit_logs').insert({ actor_id: req.member?.id, action: `recovery.${status}`, target_type: 'account_recovery_request', target_id: req.params.id, details: { status }, ip_address: req.ip });
  return res.json({ request: data });
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