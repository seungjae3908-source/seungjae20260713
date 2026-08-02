import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMBER_CAPABILITIES,
  MEMBER_PERMISSION_MATRIX,
  deriveMemberTier,
  hasCapability,
  memberTierLabel,
  permissionsFor,
  type MemberCapability,
  type MemberTier,
} from '../../../packages/member-access/src/index.js';

const expected: Record<MemberTier, MemberCapability[]> = {
  pending: [],
  associate: ['canAccessBasicInfo', 'canAccessSpot'],
  regular: [
    'canAccessBasicInfo', 'canAccessSpot', 'canAccessFutures',
    'canAccessRiskPreview', 'canAccessBacktests', 'canAccessPaperTrading',
    'canAccessJournalSync', 'canAccessTradingAnalytics', 'canAccessAiTradingReview',
  ],
  admin: [...MEMBER_CAPABILITIES],
};

for (const tier of ['pending', 'associate', 'regular', 'admin'] as const) {
  for (const capability of MEMBER_CAPABILITIES) {
    test(`${tier} ${capability} matches the shared matrix`, () => {
      assert.equal(hasCapability(tier, capability), expected[tier].includes(capability));
      assert.equal(permissionsFor(tier)[capability], MEMBER_PERMISSION_MATRIX[tier][capability]);
    });
  }
}

test('legacy approved user maps to regular', () => {
  assert.equal(deriveMemberTier({ role: 'user', status: 'approved' }), 'regular');
});

test('legacy approved admin maps to admin', () => {
  assert.equal(deriveMemberTier({ role: 'admin', status: 'approved' }), 'admin');
});

test('legacy pending admin does not gain admin access', () => {
  assert.equal(deriveMemberTier({ role: 'admin', status: 'pending' }), 'pending');
});

test('explicit associate tier is preserved', () => {
  assert.equal(deriveMemberTier({ membership_level: 'associate', role: 'user', status: 'approved' }), 'associate');
});

test('inactive regular is treated as pending', () => {
  assert.equal(deriveMemberTier({ membership_level: 'regular', is_active: false, status: 'approved' }), 'pending');
});

test('suspended admin is treated as pending', () => {
  assert.equal(deriveMemberTier({ membership_level: 'admin', status: 'suspended' }), 'pending');
});

test('unknown client role does not gain capabilities', () => {
  assert.equal(deriveMemberTier({ role: 'superadmin', status: 'pending' }), 'pending');
  assert.equal(hasCapability({ role: 'superadmin', status: 'pending' }, 'canManageMembers'), false);
});

test('membership labels use the requested Korean names', () => {
  assert.equal(memberTierLabel('pending'), '일반회원 · 승인대기');
  assert.equal(memberTierLabel('associate'), '준회원');
  assert.equal(memberTierLabel('regular'), '정회원');
  assert.equal(memberTierLabel('admin'), '관리자');
});
