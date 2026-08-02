import { Router } from 'express';
import {
  requireAdmin,
  requireAuthenticated,
  type AuthenticatedRequest,
} from '../middleware/auth';
import { getSupabase, getUserSupabase, hasSupabaseServerKey } from '../lib/supabase';
import {
  MemberAdministrationError,
  isActiveAdmin,
  parseMemberChangeRequest,
  planMemberChange,
  sanitizeMemberSearch,
  type MemberAdministrationProfile,
  type MemberChangeRequest,
} from '../services/member-administration.service';

const router = Router();
router.use(requireAuthenticated, requireAdmin);

const PROFILE_FIELDS = [
  'id', 'login_name', 'display_name', 'membership_level', 'is_active',
  'status', 'role', 'approved_at', 'approved_by', 'created_at',
  'updated_at', 'permissions_updated_at',
].join(',');

type AdminProfileRow = MemberAdministrationProfile & {
  login_name?: string | null;
  display_name?: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
  created_at?: string | null;
};

function adminDb(req: AuthenticatedRequest) {
  return hasSupabaseServerKey() ? getSupabase() : getUserSupabase(req.accessToken!);
}

function routeId(value: string | string[] | undefined) {
  const id = Array.isArray(value) ? value[0] : value;
  if (!id || !/^[A-Za-z0-9._:-]{1,160}$/.test(id)) {
    throw new MemberAdministrationError('INVALID_MEMBER_ID', '회원 ID를 확인하세요.');
  }
  return id;
}

function sendAdminError(res: any, cause: unknown, fallback: string) {
  if (cause instanceof MemberAdministrationError) {
    return res.status(cause.statusCode).json({ error: cause.code, message: cause.message });
  }
  return res.status(500).json({ error: fallback, message: '관리자 요청을 처리하지 못했습니다.' });
}

async function activeAdminCount(req: AuthenticatedRequest) {
  const { data, error } = await adminDb(req)
    .from('profiles')
    .select('id,role,status,membership_level,is_active');
  if (error) throw new Error('ACTIVE_ADMIN_COUNT_FAILED');
  const profiles = (data ?? []) as unknown as AdminProfileRow[];
  return profiles.filter((profile) => isActiveAdmin(profile)).length;
}

async function applyMemberChange(
  req: AuthenticatedRequest,
  res: any,
  targetId: string,
  requested: MemberChangeRequest,
) {
  try {
    const db = adminDb(req);
    const { data: currentData, error: currentError } = await db
      .from('profiles').select(PROFILE_FIELDS).eq('id', targetId).single();
    if (currentError || !currentData) return res.status(404).json({ error: 'MEMBER_NOT_FOUND' });
    const current = currentData as unknown as AdminProfileRow;
    const plan = planMemberChange(current, requested, req.member!.id, await activeAdminCount(req));
    const rollback = {
      membership_level: current.membership_level,
      is_active: current.is_active,
      role: current.role,
      status: current.status,
      approved_at: current.approved_at,
      approved_by: current.approved_by,
      permissions_updated_at: current.permissions_updated_at,
      updated_at: current.updated_at,
    };

    const { data: memberData, error: updateError } = await db
      .from('profiles').update(plan.changes).eq('id', targetId)
      .select(PROFILE_FIELDS).single();
    if (updateError || !memberData) throw new Error('MEMBER_UPDATE_FAILED');
    const member = memberData as unknown as AdminProfileRow;

    const { error: auditError } = await db.from('member_permission_audit').insert({
      actor_id: req.member!.id,
      target_user_id: targetId,
      action: plan.action,
      before_value: plan.beforeValue,
      after_value: plan.afterValue,
      reason: plan.reason,
    });
    if (auditError) {
      await db.from('profiles').update(rollback).eq('id', targetId);
      throw new Error('MEMBER_AUDIT_REQUIRED');
    }

    return res.json({
      ok: true,
      member,
      permissionsUpdatedAt: member.permissions_updated_at ?? member.updated_at,
      audit: {
        action: plan.action,
        targetUserId: targetId,
        actorId: req.member!.id,
        beforeValue: plan.beforeValue,
        afterValue: plan.afterValue,
        reason: plan.reason,
      },
    });
  } catch (cause) {
    return sendAdminError(res, cause, 'MEMBER_UPDATE_FAILED');
  }
}

router.get('/members', async (req: AuthenticatedRequest, res) => {
  const search = sanitizeMemberSearch(req.query.search);
  const requestedTier = sanitizeMemberSearch(req.query.membershipLevel);
  const membershipLevel = ['pending', 'associate', 'regular', 'admin'].includes(requestedTier)
    ? requestedTier
    : '';
  try {
    let query = adminDb(req)
      .from('profiles').select(PROFILE_FIELDS)
      .order('created_at', { ascending: false }).limit(500);
    if (membershipLevel) query = query.eq('membership_level', membershipLevel);
    if (search) query = query.or(`login_name.ilike.%${search}%,display_name.ilike.%${search}%`);
    const { data, error } = await query;
    if (error) throw new Error('MEMBER_LIST_FAILED');
    return res.json({ ok: true, members: (data ?? []) as unknown as AdminProfileRow[] });
  } catch (cause) {
    return sendAdminError(res, cause, 'MEMBER_LIST_FAILED');
  }
});

router.get('/members/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const id = routeId(req.params.id);
    const { data, error } = await adminDb(req)
      .from('profiles').select(PROFILE_FIELDS).eq('id', id).single();
    if (error || !data) return res.status(404).json({ error: 'MEMBER_NOT_FOUND' });
    return res.json({ ok: true, member: data as unknown as AdminProfileRow });
  } catch (cause) {
    return sendAdminError(res, cause, 'MEMBER_DETAIL_FAILED');
  }
});

router.post('/members/:id/approve', async (req: AuthenticatedRequest, res) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    const requested = parseMemberChangeRequest({ membershipLevel: 'associate', isActive: true, reason });
    return applyMemberChange(req, res, routeId(req.params.id), requested);
  } catch (cause) {
    return sendAdminError(res, cause, 'MEMBER_APPROVAL_FAILED');
  }
});

router.patch('/members/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const requested = parseMemberChangeRequest(req.body);
    return applyMemberChange(req, res, routeId(req.params.id), requested);
  } catch (cause) {
    return sendAdminError(res, cause, 'MEMBER_UPDATE_FAILED');
  }
});

router.get('/audit-logs', async (req: AuthenticatedRequest, res) => {
  const targetUserId = sanitizeMemberSearch(req.query.targetUserId);
  try {
    let query = adminDb(req)
      .from('member_permission_audit')
      .select('id,actor_id,target_user_id,action,before_value,after_value,reason,created_at')
      .order('created_at', { ascending: false }).limit(500);
    if (targetUserId) query = query.eq('target_user_id', targetUserId);
    const { data, error } = await query;
    if (error) throw new Error('AUDIT_LIST_FAILED');
    return res.json({ ok: true, logs: data ?? [] });
  } catch (cause) {
    return sendAdminError(res, cause, 'AUDIT_LIST_FAILED');
  }
});

router.get('/system', (req: AuthenticatedRequest, res) => {
  const maskHost = (value?: string) => {
    if (!value) return null;
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.hostname.replace(/^[^.]+/, '***')}${url.port ? `:${url.port}` : ''}`;
    } catch {
      return 'configured';
    }
  };
  return res.json({
    appVersion: process.env.APP_VERSION ?? 'development',
    environment: process.env.NODE_ENV ?? 'development',
    apiBase: maskHost(process.env.PUBLIC_API_URL),
    serverBase: maskHost(process.env.SERVER_URL),
    databaseConfigured: Boolean(process.env.SUPABASE_URL),
    actualTradingEnabled: false,
    requestedBy: req.member?.id,
    checkedAt: new Date().toISOString(),
  });
});

export default router;
