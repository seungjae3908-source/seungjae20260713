import {
  MEMBER_TIERS,
  deriveMemberTier,
  type MemberTier,
} from '../../../packages/member-access/src/index.js';

export type MemberAdministrationProfile = {
  id: string;
  role?: string | null;
  status?: string | null;
  membership_level?: MemberTier | string | null;
  is_active?: boolean | null;
  permissions_updated_at?: string | null;
  updated_at?: string | null;
};

export type MemberChangeRequest = {
  membershipLevel?: MemberTier;
  isActive?: boolean;
  reason: string;
};

export type MemberChangePlan = {
  changes: {
    membership_level: MemberTier;
    is_active: boolean;
    role: 'pending' | 'associate' | 'full' | 'admin';
    status: 'pending' | 'approved' | 'suspended';
    approved_at: string | null;
    approved_by: string | null;
    permissions_updated_at: string;
    updated_at: string;
  };
  action: 'member.approve' | 'member.membership.change' | 'member.active.change' | 'member.status.change';
  beforeValue: Record<string, unknown>;
  afterValue: Record<string, unknown>;
  reason: string;
};

export class MemberAdministrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'MemberAdministrationError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorText(cause: unknown) {
  if (cause instanceof Error) return cause.message;
  if (isObject(cause) && typeof cause.message === 'string') return cause.message;
  return '';
}

export function classifyAtomicMemberChangeFailure(cause: unknown): MemberAdministrationError {
  const message = errorText(cause);
  if (message.includes('LAST_ACTIVE_ADMIN_PROTECTED')) {
    return new MemberAdministrationError(
      'LAST_ACTIVE_ADMIN_PROTECTED',
      '마지막 활성 관리자의 등급을 내리거나 비활성화할 수 없습니다.',
      409,
    );
  }
  if (message.includes('MEMBER_STATE_CONFLICT')) {
    return new MemberAdministrationError(
      'MEMBER_STATE_CONFLICT',
      '회원 상태가 다른 요청에 의해 변경되었습니다. 새 상태를 확인한 뒤 다시 시도하세요.',
      409,
    );
  }
  if (message.includes('MEMBER_NOT_FOUND')) {
    return new MemberAdministrationError('MEMBER_NOT_FOUND', '회원을 찾을 수 없습니다.', 404);
  }
  if (message.includes('MEMBER_ADMIN_REQUIRED')) {
    return new MemberAdministrationError('MEMBER_ADMIN_REQUIRED', '관리자 권한이 필요합니다.', 403);
  }
  if (message.includes('CHANGE_REASON_REQUIRED')) {
    return new MemberAdministrationError('CHANGE_REASON_REQUIRED', '변경 사유를 3~500자로 입력하세요.', 400);
  }
  if (message.includes('INVALID_MEMBER_CHANGE')) {
    return new MemberAdministrationError('INVALID_MEMBER_CHANGE', '회원 변경 요청을 확인하세요.', 400);
  }
  return new MemberAdministrationError(
    'MEMBER_UPDATE_FAILED',
    '회원 권한 변경을 원자적으로 저장하지 못했습니다.',
    500,
  );
}

function legacyStoredTier(profile: MemberAdministrationProfile): MemberTier {
  if (profile.role === 'admin' || profile.role === 'master') return 'admin';
  if (profile.role === 'associate') return 'associate';
  if (profile.role === 'full' || profile.role === 'regular') return 'regular';
  return 'pending';
}

function storedMemberTier(profile: MemberAdministrationProfile): MemberTier {
  const status = typeof profile.status === 'string' ? profile.status : null;
  // Only an already-approved member, or a deliberately suspended member being
  // reactivated, may preserve a stored tier. Missing/rejected/revoked/pending/
  // disabled rows must not regain a stale privileged tier through an active-state-only change.
  if (status !== 'approved' && status !== 'suspended') return 'pending';

  if (typeof profile.membership_level === 'string' && MEMBER_TIERS.includes(profile.membership_level as MemberTier)) {
    return profile.membership_level as MemberTier;
  }
  if (status === 'suspended') return legacyStoredTier(profile);
  return deriveMemberTier(profile);
}

export function sanitizeMemberSearch(value: unknown) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _.\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export function parseMemberChangeRequest(value: unknown): MemberChangeRequest {
  if (!isObject(value)) {
    throw new MemberAdministrationError('INVALID_MEMBER_CHANGE', '회원 변경 요청 형식을 확인하세요.');
  }
  if ('role' in value || 'user_id' in value || 'userId' in value || 'actor_id' in value) {
    throw new MemberAdministrationError('CLIENT_AUTHORITY_FORBIDDEN', '권한 식별자는 서버가 결정합니다.');
  }

  const membershipLevel = typeof value.membershipLevel === 'string'
    && MEMBER_TIERS.includes(value.membershipLevel as MemberTier)
    ? value.membershipLevel as MemberTier
    : undefined;
  const isActive = typeof value.isActive === 'boolean' ? value.isActive : undefined;
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';

  if (membershipLevel == null && isActive == null) {
    throw new MemberAdministrationError('NO_VALID_CHANGE', '변경할 등급 또는 활성 상태가 필요합니다.');
  }
  if (reason.length < 3 || reason.length > 500) {
    throw new MemberAdministrationError('CHANGE_REASON_REQUIRED', '변경 사유를 3~500자로 입력하세요.');
  }

  return { membershipLevel, isActive, reason };
}

export function isActiveAdmin(profile: MemberAdministrationProfile) {
  return profile.status === 'approved'
    && profile.is_active === true
    && storedMemberTier(profile) === 'admin';
}

function legacyRoleForTier(tier: MemberTier): 'pending' | 'associate' | 'full' | 'admin' {
  switch (tier) {
    case 'admin':
      return 'admin';
    case 'associate':
      return 'associate';
    case 'regular':
      return 'full';
    default:
      return 'pending';
  }
}

export function planMemberChange(
  current: MemberAdministrationProfile,
  request: MemberChangeRequest,
  actorId: string,
  activeAdminCount: number,
  now = new Date(),
): MemberChangePlan {
  // Preserve stored tier only for approved/suspended members. Other non-approved
  // states require an explicit membershipLevel change before they can be approved.
  const currentTier = storedMemberTier(current);
  const currentActive = current.is_active === true;
  const nextTier = request.membershipLevel ?? currentTier;
  const nextActive = request.isActive ?? currentActive;

  if (isActiveAdmin(current) && (nextTier !== 'admin' || !nextActive) && activeAdminCount <= 1) {
    throw new MemberAdministrationError(
      'LAST_ACTIVE_ADMIN_PROTECTED',
      '마지막 활성 관리자의 등급을 내리거나 비활성화할 수 없습니다.',
      409,
    );
  }

  const timestamp = now.toISOString();
  const status = !nextActive ? 'suspended' : nextTier === 'pending' ? 'pending' : 'approved';
  const role = legacyRoleForTier(nextTier);
  const action = currentTier === 'pending' && nextTier === 'associate' && nextActive
    ? 'member.approve'
    : currentTier !== nextTier
      ? 'member.membership.change'
      : currentActive !== nextActive
        ? 'member.active.change'
        : 'member.status.change';
  const beforeValue = {
    membershipLevel: currentTier,
    isActive: currentActive,
    role: current.role ?? null,
    status: current.status ?? null,
  };
  const afterValue = {
    membershipLevel: nextTier,
    isActive: nextActive,
    role,
    status,
  };

  return {
    changes: {
      membership_level: nextTier,
      is_active: nextActive,
      role,
      status,
      approved_at: status === 'approved' ? timestamp : null,
      approved_by: status === 'approved' ? actorId : null,
      permissions_updated_at: timestamp,
      updated_at: timestamp,
    },
    action,
    beforeValue,
    afterValue,
    reason: request.reason,
  };
}
