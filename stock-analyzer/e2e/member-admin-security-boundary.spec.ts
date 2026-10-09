import { test, expect } from '@playwright/test';
import { QueryClient } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import {
  adminMemberStoredTier,
  adminMemberActivityLabel,
  adminMemberMutationStateVerified,
  adminMemberQueryKeys,
} from '../src/lib/member-admin-state';
import { MEMBER_PERMISSION_MATRIX } from '../../packages/member-access/src/index.js';

const epoch = '2026-10-09T12:00:00.000Z';
const associate = { status: 'approved', role: 'associate', membership_level: 'associate', is_active: true, permissions_updated_at: epoch };

test('pending, rejected and revoked members cannot display or default to legacy admin tier', () => {
  for (const status of ['pending', 'rejected', 'revoked', 'withdrawn', 'disabled', 'inactive']) {
    const row = { status, role: 'admin', membership_level: 'admin', is_active: false, permissions_updated_at: epoch };
    expect(adminMemberStoredTier(row)).toBe('pending');
    expect(adminMemberMutationStateVerified(row)).toBe(true);
  }
  expect(adminMemberStoredTier({ ...associate, membership_level: 'admin' })).toBe('admin');
  expect(adminMemberStoredTier({ ...associate, membership_level: null, role: 'admin' })).toBe('pending');
});

test('unknown active flags, inconsistent states and unversioned member mutations fail closed', () => {
  expect(adminMemberActivityLabel(true)).toBe('활성');
  expect(adminMemberActivityLabel(false)).toBe('비활성');
  expect(adminMemberActivityLabel(null)).toBe('미확인');
  expect(adminMemberActivityLabel(undefined)).toBe('미확인');
  expect(adminMemberMutationStateVerified(associate)).toBe(true);
  expect(adminMemberMutationStateVerified({ ...associate, is_active: null })).toBe(false);
  expect(adminMemberMutationStateVerified({ ...associate, status: 'approved', is_active: false })).toBe(false);
  expect(adminMemberMutationStateVerified({ ...associate, status: 'pending', membership_level: 'pending', is_active: true })).toBe(false);
  expect(adminMemberMutationStateVerified({ ...associate, permissions_updated_at: null })).toBe(false);
  expect(adminMemberMutationStateVerified({ ...associate, permissions_updated_at: 'invalid' })).toBe(false);
  expect(adminMemberMutationStateVerified({ ...associate, status: 'suspended', is_active: false })).toBe(true);
});

test('separate administrators and privilege epochs never reuse cached member lists or audits', () => {
  const params = { permissionVersion: epoch, search: 'kim', memberPage: 0, auditPage: 0 };
  const a = adminMemberQueryKeys({ ...params, userId: 'ADMIN-A' });
  const b = adminMemberQueryKeys({ ...params, userId: 'ADMIN-B' });
  const revoked = adminMemberQueryKeys({ ...params, userId: 'ADMIN-A', permissionVersion: '2026-10-09T12:01:00Z' });
  const cache = new QueryClient();
  cache.setQueryData(a.members, { members: [{ id: 'PRIVATE_A' }] });
  cache.setQueryData(a.audits, { logs: [{ id: 'PRIVATE_A_AUDIT' }] });
  expect(cache.getQueryData(b.members)).toBeUndefined();
  expect(cache.getQueryData(b.audits)).toBeUndefined();
  expect(cache.getQueryData(revoked.members)).toBeUndefined();
  expect(cache.getQueryData(revoked.audits)).toBeUndefined();
  expect(a.members.join('|')).not.toContain('Bearer');
  cache.clear();
});

test('associate S-grade/chart/AI review remains read-only while admin-only capability stays separated', () => {
  expect(MEMBER_PERMISSION_MATRIX.associate.canAccessAiChart).toBe(true);
  expect(MEMBER_PERMISSION_MATRIX.associate.canAccessTradingAnalytics).toBe(true);
  expect(MEMBER_PERMISSION_MATRIX.associate.canAccessAiTradingReview).toBe(true);
  expect(MEMBER_PERMISSION_MATRIX.associate.canManageMembers).toBe(false);
  expect(MEMBER_PERMISSION_MATRIX.associate.canPlaceOrders).toBe(false);
  expect(MEMBER_PERMISSION_MATRIX.pending.canAccessAiChart).toBe(false);
});

test('admin UI enforces identity-scoped cache and no-store HTTP contract', () => {
  const ui = readFileSync(new URL('../src/pages/admin.tsx', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../../api-server/src/routes/admin.ts', import.meta.url), 'utf8');
  expect(ui).toContain('queryKey: keys.members');
  expect(ui).toContain('queryKey: keys.audits');
  expect(ui.match(/gcTime: 0/g)?.length).toBe(2);
  expect(ui).toContain("cache: 'no-store'");
  expect(ui).toContain('adminMemberMutationStateVerified(member)');
  expect(ui).toContain('admin-member-state-unverified');
  expect(ui).toContain('adminMemberActivityLabel(member.is_active)');
  expect(ui).toContain("member.status !== 'pending'");
  expect(ui).toContain("auth.profile?.permissions_updated_at");
  expect(server).toContain("router.use(requireAuthenticated, requireAdmin)");
  expect(server).toContain("res.setHeader('Cache-Control', 'private, no-store, max-age=0')");
});
