import { MEMBER_TIERS, type MemberTier } from '../../../packages/member-access/src/index.js';
export type AdminMemberReadState = {
  status?: string | null;
  role?: string | null;
  membership_level?: string | null;
  is_active?: boolean | null;
  membership_expires_at?: string | null;
};
export function adminMemberEditableTier(member: AdminMemberReadState): MemberTier {
  if (member.status !== 'approved' && member.status !== 'suspended') return 'pending';
  const explicit = member.membership_level;
  if (typeof explicit === 'string' && MEMBER_TIERS.includes(explicit as MemberTier)) return explicit as MemberTier;
  if (member.status !== 'suspended') return 'pending';
  if (member.role === 'admin' || member.role === 'master') return 'admin';
  if (member.role === 'associate') return 'associate';
  if (member.role === 'full' || member.role === 'regular') return 'regular';
  return 'pending';
}
export function adminMemberIsActive(member: AdminMemberReadState): boolean {
  return member.is_active === true;
}
export function adminMemberAccessLabel(member: AdminMemberReadState): string {
  if (member.status !== 'approved') return '이용 차단';
  if (!adminMemberIsActive(member)) return '비활성';
  if (adminMemberEditableTier(member) === 'pending') return '등급 확인 필요';
  const expiry = member.membership_expires_at;
  if (expiry != null) {
    if (typeof expiry !== 'string' || !expiry.trim()) return '만료일 확인 필요';
    const ms = Date.parse(expiry);
    if (!Number.isFinite(ms)) return '만료일 확인 필요';
    if (ms <= Date.now()) return '만료';
  }
  return '활성';
}
