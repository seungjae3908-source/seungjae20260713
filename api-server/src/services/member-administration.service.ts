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
    role: 'user' | 'admin';
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
  return profile.is_active !== false && deriveMemberTier(profile) === 'admin';
}

export function planMemberChange(
  current: MemberAdministrationProfile,
  request: MemberChangeRequest,
  actorId: string,
  activeAdminCount: number,
  now = new Date(),
): MemberChangePlan {
  const currentTier = deriveMemberTier(current);
  const currentActive = current.is_active !== false;
  const nextTier = request.membershipLevel ?? currentTier;
  const nextActive = request.isActive ?? currentActive;

  if (currentTier === 'admin' && currentActive && (nextTier !== 'admin' || !nextActive) && activeAdminCount <= 1) {
    throw new MemberAdministrationError(
      'LAST_ACTIVE_ADMIN_PROTECTED',
      '마지막 활성 관리자의 등급을 내리거나 비활성화할 수 없습니다.',
      409,
    );
  }

  const timestamp = now.toISOString();
  const status = !nextActive ? 'suspended' : nextTier === 'pending' ? 'pending' : 'approved';
  const role = nextTier === 'admin' ? 'admin' : 'user';
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
