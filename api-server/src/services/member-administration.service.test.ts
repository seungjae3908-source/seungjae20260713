import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MemberAdministrationError,
  isActiveAdmin,
  parseMemberChangeRequest,
  planMemberChange,
  sanitizeMemberSearch,
} from './member-administration.service';

const NOW = new Date('2026-08-02T08:00:00.000Z');
const ADMIN = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    role: 'user', status: 'pending', membership_level: 'pending', is_active: true,
    ...overrides,
  };
}

const rejectionCases: Array<[string, unknown, string]> = [
  ['rejects null body', null, 'INVALID_MEMBER_CHANGE'],
  ['rejects empty change', { reason: 'valid reason' }, 'NO_VALID_CHANGE'],
  ['rejects missing reason', { membershipLevel: 'associate' }, 'CHANGE_REASON_REQUIRED'],
  ['rejects short reason', { membershipLevel: 'associate', reason: 'no' }, 'CHANGE_REASON_REQUIRED'],
  ['rejects long reason', { membershipLevel: 'associate', reason: 'x'.repeat(501) }, 'CHANGE_REASON_REQUIRED'],
  ['rejects client role', { role: 'admin', membershipLevel: 'admin', reason: 'attempted role injection' }, 'CLIENT_AUTHORITY_FORBIDDEN'],
  ['rejects client user_id', { user_id: 'other', membershipLevel: 'regular', reason: 'attempted identity injection' }, 'CLIENT_AUTHORITY_FORBIDDEN'],
  ['rejects actor_id', { actor_id: 'other', isActive: false, reason: 'attempted actor injection' }, 'CLIENT_AUTHORITY_FORBIDDEN'],
];

for (const [name, input, code] of rejectionCases) {
  test(name, () => {
    assert.throws(
      () => parseMemberChangeRequest(input),
      (cause: unknown) => cause instanceof MemberAdministrationError && cause.code === code,
    );
  });
}

test('parses valid associate approval', () => {
  assert.deepEqual(parseMemberChangeRequest({ membershipLevel: 'associate', isActive: true, reason: '신규 회원 승인' }), {
    membershipLevel: 'associate', isActive: true, reason: '신규 회원 승인',
  });
});

test('pending to associate is recorded as approval', () => {
  const plan = planMemberChange(profile(), { membershipLevel: 'associate', isActive: true, reason: '회원 승인 처리' }, ADMIN, 1, NOW);
  assert.equal(plan.action, 'member.approve');
  assert.equal(plan.changes.membership_level, 'associate');
  assert.equal(plan.changes.status, 'approved');
  assert.equal(plan.changes.role, 'user');
  assert.equal(plan.changes.approved_by, ADMIN);
});

test('regular to admin changes legacy compatibility role', () => {
  const plan = planMemberChange(profile({ membership_level: 'regular', status: 'approved' }), { membershipLevel: 'admin', reason: '관리자 승격' }, ADMIN, 2, NOW);
  assert.equal(plan.action, 'member.membership.change');
  assert.equal(plan.changes.role, 'admin');
  assert.equal(plan.changes.status, 'approved');
});

test('deactivation records suspended compatibility status', () => {
  const plan = planMemberChange(profile({ membership_level: 'regular', status: 'approved' }), { isActive: false, reason: '계정 비활성화' }, ADMIN, 1, NOW);
  assert.equal(plan.action, 'member.active.change');
  assert.equal(plan.changes.is_active, false);
  assert.equal(plan.changes.status, 'suspended');
  assert.equal(plan.changes.approved_at, null);
});

test('reactivation restores stored associate tier and approved state', () => {
  const plan = planMemberChange(profile({ membership_level: 'associate', is_active: false, status: 'suspended' }), { isActive: true, reason: '계정 재활성화' }, ADMIN, 1, NOW);
  assert.equal(plan.changes.membership_level, 'associate');
  assert.equal(plan.changes.status, 'approved');
  assert.equal(plan.changes.is_active, true);
});

test('pending state does not create approved timestamp', () => {
  const plan = planMemberChange(profile({ membership_level: 'associate', status: 'approved' }), { membershipLevel: 'pending', reason: '승인 대기로 전환' }, ADMIN, 1, NOW);
  assert.equal(plan.changes.status, 'pending');
  assert.equal(plan.changes.approved_at, null);
});

test('last active admin cannot be demoted', () => {
  assert.throws(
    () => planMemberChange(profile({ membership_level: 'admin', role: 'admin', status: 'approved' }), { membershipLevel: 'regular', reason: '관리자 해제' }, ADMIN, 1, NOW),
    (cause: unknown) => cause instanceof MemberAdministrationError && cause.code === 'LAST_ACTIVE_ADMIN_PROTECTED' && cause.statusCode === 409,
  );
});

test('last active admin cannot be deactivated', () => {
  assert.throws(
    () => planMemberChange(profile({ membership_level: 'admin', role: 'admin', status: 'approved' }), { isActive: false, reason: '관리자 비활성화' }, ADMIN, 1, NOW),
    (cause: unknown) => cause instanceof MemberAdministrationError && cause.code === 'LAST_ACTIVE_ADMIN_PROTECTED',
  );
});

test('admin may be demoted when another active admin exists', () => {
  const plan = planMemberChange(profile({ membership_level: 'admin', role: 'admin', status: 'approved' }), { membershipLevel: 'regular', reason: '관리자 역할 조정' }, ADMIN, 2, NOW);
  assert.equal(plan.changes.membership_level, 'regular');
});

test('audit values include actor-independent before and after data', () => {
  const plan = planMemberChange(profile(), { membershipLevel: 'associate', reason: '회원 승인 처리' }, ADMIN, 1, NOW);
  assert.deepEqual(plan.beforeValue, { membershipLevel: 'pending', isActive: true, role: 'user', status: 'pending' });
  assert.deepEqual(plan.afterValue, { membershipLevel: 'associate', isActive: true, role: 'user', status: 'approved' });
  assert.equal(plan.reason, '회원 승인 처리');
});

test('permission timestamp uses server time', () => {
  const plan = planMemberChange(profile(), { membershipLevel: 'associate', reason: '회원 승인 처리' }, ADMIN, 1, NOW);
  assert.equal(plan.changes.permissions_updated_at, NOW.toISOString());
  assert.equal(plan.changes.updated_at, NOW.toISOString());
});

test('active admin detection uses stored tier and active flag', () => {
  assert.equal(isActiveAdmin(profile({ membership_level: 'admin', status: 'approved' })), true);
  assert.equal(isActiveAdmin(profile({ membership_level: 'admin', status: 'approved', is_active: false })), false);
  assert.equal(isActiveAdmin(profile({ role: 'admin', status: 'approved', membership_level: null })), true);
});

test('member search preserves Korean, letters, digits and safe punctuation', () => {
  assert.equal(sanitizeMemberSearch('  승재 User_01-test.name  '), '승재 User_01-test.name');
});

test('member search removes PostgREST filter injection delimiters', () => {
  const sanitized = sanitizeMemberSearch('x%),role.eq.admin,(display_name.ilike.*');
  assert.doesNotMatch(sanitized, /[%(),*]/);
  assert.equal(sanitized, 'xrole.eq.admindisplay_name.ilike.');
});

test('member search removes SQL quotes and comment syntax', () => {
  const sanitized = sanitizeMemberSearch("' OR 1=1; -- 관리자");
  assert.doesNotMatch(sanitized, /[';=]/);
  assert.equal(sanitized, 'OR 11 -- 관리자');
});

test('member search applies Unicode normalization and maximum length', () => {
  const sanitized = sanitizeMemberSearch('Ａ'.repeat(100));
  assert.equal(sanitized, 'A'.repeat(80));
});

test('non-string member search becomes empty', () => {
  assert.equal(sanitizeMemberSearch({ malicious: true }), '');
});
