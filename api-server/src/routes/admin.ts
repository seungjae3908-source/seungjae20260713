import { Router } from 'express';
import {
  requireAdmin,
  requireAuthenticated,
  type AuthenticatedRequest,
} from '../middleware/auth';
import { getUserSupabase } from '../lib/supabase';
import {
  MemberAdministrationError,
  classifyAtomicMemberChangeFailure,
  parseMemberChangeRequest,
  sanitizeMemberSearch,
  type MemberAdministrationProfile,
  type MemberChangeRequest,
} from '../services/member-administration.service';
import { bindCanonicalStrategyHealth } from '../services/strategy-health-research-adapter.service';
import { sanitizeResearchCenterOverview } from '../services/research-center-readonly-contract.service';

const router = Router();
router.use(requireAuthenticated, requireAdmin);

const PROFILE_FIELDS = [
  'id', 'login_name', 'display_name', 'membership_level', 'is_active',
  'status', 'role', 'approved_at', 'approved_by', 'created_at',
  'updated_at', 'permissions_updated_at',
].join(',');

const RESEARCH_OVERVIEW_URL = 'http://127.0.0.1:18090/api/research/overview';
// The genuine loopback Dashboard readback can complete after the old 4s proxy
// deadline while still succeeding inside the dedicated 8s diagnostic bound.
// Keep the browser-facing proxy bounded, but leave enough room for that healthy path.
export const RESEARCH_OVERVIEW_TIMEOUT_MS = 10_000;
const MEMBER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AdminProfileRow = MemberAdministrationProfile & {
  login_name?: string | null;
  display_name?: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
  created_at?: string | null;
};

type AdminReadFailure = {
  statusCode: 503;
  error: 'ADMIN_MEMBER_STORAGE_UNAVAILABLE' | 'ADMIN_AUDIT_STORAGE_UNAVAILABLE';
  message: string;
};

type AtomicMemberChangePayload = {
  member: AdminProfileRow;
  audit: {
    action: string;
    targetUserId: string;
    actorId: string;
    beforeValue: Record<string, unknown>;
    afterValue: Record<string, unknown>;
    reason: string;
  };
};

export function classifyAdminReadFailure(
  fallback: 'MEMBER_LIST_FAILED' | 'AUDIT_LIST_FAILED',
): AdminReadFailure {
  if (fallback === 'MEMBER_LIST_FAILED') {
    return {
      statusCode: 503,
      error: 'ADMIN_MEMBER_STORAGE_UNAVAILABLE',
      message: '회원 목록 저장소를 확인할 수 없습니다.',
    };
  }
  return {
    statusCode: 503,
    error: 'ADMIN_AUDIT_STORAGE_UNAVAILABLE',
    message: '권한 변경 감사 저장소를 확인할 수 없습니다.',
  };
}

function adminDb(req: AuthenticatedRequest) {
  return getUserSupabase(req.accessToken!);
}

function routeId(value: string | string[] | undefined) {
  const id = Array.isArray(value) ? value[0] : value;
  if (!id || !MEMBER_ID_PATTERN.test(id)) {
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

function sendAdminReadError(
  res: any,
  fallback: 'MEMBER_LIST_FAILED' | 'AUDIT_LIST_FAILED',
) {
  const failure = classifyAdminReadFailure(fallback);
  return res.status(failure.statusCode).json({
    error: failure.error,
    message: failure.message,
    dataState: 'unavailable',
    retryable: true,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function atomicMemberChangePayload(value: unknown): AtomicMemberChangePayload | null {
  const payload = isRecord(value) ? value : null;
  const member = isRecord(payload?.member) ? payload.member : null;
  const audit = isRecord(payload?.audit) ? payload.audit : null;
  if (!member || !audit || typeof member.id !== 'string' || typeof audit.action !== 'string') return null;
  return {
    member: member as unknown as AdminProfileRow,
    audit: audit as unknown as AtomicMemberChangePayload['audit'],
  };
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
      .from('profiles').select(PROFILE_FIELDS).eq('id', targetId).maybeSingle();
    if (currentError) throw new Error('MEMBER_READ_FAILED');
    if (!currentData) return res.status(404).json({ error: 'MEMBER_NOT_FOUND' });
    const current = currentData as unknown as AdminProfileRow;
    if (!current.permissions_updated_at) {
      throw new MemberAdministrationError(
        'MEMBER_STATE_CONFLICT',
        '회원 권한 상태의 기준 시점을 확인할 수 없습니다. 새 상태를 불러온 뒤 다시 시도하세요.',
        409,
      );
    }

    const { data, error } = await db.rpc('apply_member_permission_change', {
      p_target_user_id: targetId,
      p_membership_level: requested.membershipLevel ?? null,
      p_is_active: requested.isActive ?? null,
      p_reason: requested.reason,
      p_expected_permissions_updated_at: current.permissions_updated_at,
    });
    if (error) throw classifyAtomicMemberChangeFailure(error);

    const payload = atomicMemberChangePayload(data);
    if (!payload) throw new Error('ATOMIC_MEMBER_CHANGE_INVALID_RESPONSE');

    return res.json({
      ok: true,
      member: payload.member,
      permissionsUpdatedAt: payload.member.permissions_updated_at ?? payload.member.updated_at,
      audit: payload.audit,
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
  } catch {
    return sendAdminReadError(res, 'MEMBER_LIST_FAILED');
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
  } catch {
    return sendAdminReadError(res, 'AUDIT_LIST_FAILED');
  }
});

router.get('/research/overview', async (_req: AuthenticatedRequest, res) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESEARCH_OVERVIEW_TIMEOUT_MS);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const upstream = await fetch(RESEARCH_OVERVIEW_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!upstream.ok) {
      return res.status(503).json({
        error: 'RESEARCH_DASHBOARD_UNAVAILABLE',
        message: 'Research Production 상태를 불러오지 못했습니다.',
      });
    }
    const upstreamPayload = await upstream.json() as unknown;
    const payload = sanitizeResearchCenterOverview(upstreamPayload);
    if (!payload) {
      return res.status(503).json({
        error: 'RESEARCH_DASHBOARD_SAFETY_CONTRACT_INVALID',
        message: 'Research Dashboard 안전 계약을 확인할 수 없습니다.',
      });
    }
    return res.json({
      ...payload,
      strategyHealth: bindCanonicalStrategyHealth(upstreamPayload),
    });
  } catch {
    return res.status(503).json({
      error: 'RESEARCH_DASHBOARD_UNAVAILABLE',
      message: 'Research Production 상태를 불러오지 못했습니다.',
    });
  } finally {
    clearTimeout(timeout);
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