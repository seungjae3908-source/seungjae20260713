import type { MemberTier } from '../../../packages/member-access/src/index.js';

type MemberAdminRow = {
  status?: string | null;
  role?: string | null;
  membership_level?: string | null;
  is_active?: boolean | null;
  permissions_updated_at?: string | null;
};
const TIERS: readonly MemberTier[] = ['pending', 'associate', 'regular', 'admin'];
const STATUSES = new Set(['pending', 'approved', 'suspended', 'rejected', 'revoked', 'withdrawn', 'disabled', 'inactive']);

function validTier(value: unknown): value is MemberTier {
  return typeof value === 'string' && TIERS.includes(value as MemberTier);
}

/** An unapproved member cannot inherit a stale legacy admin role as the UI's
 * suggested new tier. The server's versioned atomic RPC remains authoritative.
 */
export function adminMemberStoredTier(row: MemberAdminRow): MemberTier {
  if (row.status !== 'approved' && row.status !== 'suspended') return 'pending';
  return validTier(row.membership_level) ? row.membership_level : 'pending';
}

export function adminMemberActivityLabel(value: boolean | null | undefined): '활성' | '비활성' | '미확인' {
  return value === true ? '활성' : value === false ? '비활성' : '미확인';
}

/** Never permit a privileged UI mutation from missing, contradictory or
 * unversioned membership data. It must first be repaired/read back from DB.
 */
export function adminMemberMutationStateVerified(row: MemberAdminRow): boolean {
  if (!STATUSES.has(row.status ?? '')) return false;
  if (typeof row.is_active !== 'boolean') return false;
  if (!row.permissions_updated_at || !Number.isFinite(Date.parse(row.permissions_updated_at))) return false;
  if (row.status === 'approved') {
    return row.is_active && validTier(row.membership_level) && row.membership_level !== 'pending';
  }
  if (row.status === 'suspended') {
    return !row.is_active && validTier(row.membership_level) && row.membership_level !== 'pending';
  }
  return row.is_active === false;
}

/** Identity and DB permission epoch isolate private member/audit caches.
 * No token, secret or temporary password is present in any query key.
 */
export function adminMemberQueryKeys(input: {
  userId: string | null;
  permissionVersion: string | null;
  search: string;
  memberPage: number;
  auditPage: number;
}) {
  const user = input.userId ?? 'UNAUTHENTICATED';
  const epoch = input.permissionVersion ?? 'UNVERIFIED_PERMISSION_VERSION';
  return {
    members: ['admin-members', user, epoch, input.search, input.memberPage] as const,
    audits: ['admin-audit', user, epoch, input.auditPage] as const,
  };
}
