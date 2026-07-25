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
  if (normalized === 'admin') return '최고관리자';
  if (normalized === 'master') return '관리자';
  if (normalized === 'full') return '정회원';
  if (normalized === 'associate') return '준회원';
  return '일반회원';
}

// 상태까지 반영한 회원 등급 표시 (승인 전에는 "일반회원")
export function memberGradeLabel(
  profile: Pick<MemberProfile, 'role' | 'status'> | null | undefined,
): string {
  if (!profile) return '비회원';
  if (profile.status !== 'approved') return '일반회원 (승인 대기)';
  return roleLabel(profile.role);
}

// 각 기능을 사용하기 위해 필요한 최소 등급 안내 문구
export function featureRequiredGradeLabel(feature: AppFeature): string {
  if (feature === 'admin') return '최고관리자';
  if (feature === 'autoTrading') return '관리자';
  if (feature === 'basicChart' || feature === 'newsInfo') return '준회원';
  return '정회원';
}

export function hasMemberFeature(
  profile: Pick<MemberProfile, 'role' | 'status'> | null | undefined,
  feature: AppFeature,
): boolean {
  if (!profile || profile.status !== 'approved') return false;

  const role = normalizeMembershipRole(profile.role);
  if (feature === 'basicChart' || feature === 'newsInfo') return true;
  if (
    feature === 'advancedAnalysis'
    || feature === 'aiRealtimeChart'
    || feature === 'watchlist'
    || feature === 'portfolio'
    || feature === 'signals'
    || feature === 'futures'
  ) {
    return role === 'full' || role === 'master' || role === 'admin';
  }
  if (feature === 'autoTrading') return role === 'master' || role === 'admin';
  if (feature === 'admin') return role === 'admin';
  return false;
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
