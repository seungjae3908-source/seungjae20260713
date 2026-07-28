import { useMemo } from 'react';
import {
  normalizeMembershipRole,
  useAuth,
  type MemberProfile,
  type MembershipRole,
  type StoredMemberRole,
} from '@/lib/auth';

export type AppFeature =
  | 'basicChart'
  | 'newsInfo'
  | 'advancedAnalysis'
  | 'aiRealtimeChart'
  | 'watchlist'
  | 'portfolio'
  | 'signals'
  | 'futures'
  | 'autoTrading'
  | 'admin';

export type MemberPermissions = {
  role: MembershipRole;
  approved: boolean;
  canUseBasicChart: boolean;
  canUseAdvancedAnalysis: boolean;
  canUseAiRealtimeChart: boolean;
  canUseAutoTrading: boolean;
  canUseAdmin: boolean;
  has: (feature: AppFeature) => boolean;
};

export function roleLabel(role?: StoredMemberRole | MembershipRole | null): string {
  const normalized = normalizeMembershipRole(role as StoredMemberRole | null);
  if (normalized === 'admin') return '관리자';
  if (normalized === 'associate') return '준회원';
  return '정회원';
}

export function memberGradeLabel(
  profile: Pick<MemberProfile, 'role' | 'status'> | null | undefined,
): string {
  if (!profile) return '비회원';
  if (profile.status !== 'approved') return '일반회원 (승인 대기)';
  return roleLabel(profile.role);
}

export function featureRequiredGradeLabel(feature: AppFeature): string {
  if (feature === 'autoTrading' || feature === 'admin') return '관리자';
  if (feature === 'futures' || feature === 'portfolio') return '정회원';
  return '준회원';
}

export function hasMemberFeature(
  profile: Pick<MemberProfile, 'role' | 'status'> | null | undefined,
  feature: AppFeature,
): boolean {
  if (!profile || profile.status !== 'approved') return false;

  const role = normalizeMembershipRole(profile.role);

  if (feature === 'autoTrading' || feature === 'admin') {
    return role === 'admin';
  }

  if (feature === 'futures' || feature === 'portfolio') {
    return role === 'full' || role === 'admin';
  }

  // 승인된 준회원·정회원·관리자는 홈·종목·관심·기술·정보·설정의
  // 일반 기능을 모두 사용할 수 있다.
  return true;
}

export function useMemberPermissions(): MemberPermissions {
  const auth = useAuth();

  return useMemo(() => {
    const role = normalizeMembershipRole(auth.profile?.role);
    const approved = auth.profile?.status === 'approved';
    const has = (feature: AppFeature) =>
      hasMemberFeature(auth.profile, feature);

    return {
      role,
      approved,
      canUseBasicChart: has('basicChart'),
      canUseAdvancedAnalysis: has('advancedAnalysis'),
      canUseAiRealtimeChart: has('aiRealtimeChart'),
      canUseAutoTrading: has('autoTrading'),
      canUseAdmin: has('admin'),
      has,
    };
  }, [auth.profile]);
}
