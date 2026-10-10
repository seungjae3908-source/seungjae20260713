import test from 'node:test';
import assert from 'node:assert/strict';
import '../features/device-trust/device-trust.service.test';
import {
  MEMBER_CAPABILITIES,
  MEMBER_PERMISSION_MATRIX,
  deriveMemberTier,
  hasCanonicalMemberAccessState,
  hasCapability,
  memberTierLabel,
  permissionsFor,
  type MemberCapability,
  type MemberTier,
} from '../../../packages/member-access/src/index.js';

const expected: Record<MemberTier, MemberCapability[]> = {
  pending: [],
  associate: [
    'canAccessBasicInfo', 'canAccessSpot', 'canAccessAiChart',
    'canAccessPaperTrading', 'canAccessAutoTrading', 'canConnectPersonalTelegram',
    'canAccessTradingAnalytics', 'canAccessAiTradingReview',
  ],
  regular: [
    'canAccessBasicInfo', 'canAccessSpot', 'canAccessFutures', 'canAccessAiChart',
    'canAccessRiskPreview', 'canAccessBacktests', 'canAccessPaperTrading', 'canAccessAutoTrading',
    'canConnectPersonalTelegram', 'canAccessJournalSync', 'canAccessTradingAnalytics', 'canAccessAiTradingReview',
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

test('canonical member access state detects approved legacy schema drift without breaking pending onboarding', () => {
  assert.equal(hasCanonicalMemberAccessState({
    role: 'admin',
    status: 'approved',
  }), false);
  assert.equal(hasCanonicalMemberAccessState({
    membership_level: 'admin',
    role: 'admin',
    status: 'approved',
    is_active: true,
    permissions_updated_at: '2026-10-08T00:00:00.000Z',
  }), true);
  assert.equal(hasCanonicalMemberAccessState({
    role: 'associate',
    status: 'pending',
  }), true);
});

test('legacy approved user requires explicit active state', () => {
  assert.equal(deriveMemberTier({ role: 'user', status: 'approved' }), 'pending');
  assert.equal(deriveMemberTier({ role: 'user', status: 'approved', is_active: true }), 'regular');
});

test('legacy approved admin requires explicit active state', () => {
  assert.equal(deriveMemberTier({ role: 'admin', status: 'approved' }), 'pending');
  assert.equal(deriveMemberTier({ role: 'admin', status: 'approved', is_active: true }), 'admin');
});

test('legacy pending admin does not gain admin access', () => {
  assert.equal(deriveMemberTier({ role: 'admin', status: 'pending' }), 'pending');
});

test('explicit associate tier is preserved', () => {
  assert.equal(deriveMemberTier({ membership_level: 'associate', role: 'user', status: 'approved', is_active: true }), 'associate');
});

test('expired associate is treated as pending and loses AI capabilities', () => {
  const profile = {
    membership_level: 'associate',
    status: 'approved',
    is_active: true,
    membership_expires_at: '2020-01-01T00:00:00.000Z',
  };
  assert.equal(deriveMemberTier(profile), 'pending');
  assert.equal(hasCapability(profile, 'canAccessAiChart'), false);
  assert.equal(hasCapability(profile, 'canAccessRiskPreview'), false);
  assert.equal(hasCapability(profile, 'canAccessTradingAnalytics'), false);
  assert.equal(hasCapability(profile, 'canAccessAiTradingReview'), false);
});

test('future-dated associate keeps S/AI member capabilities', () => {
  const profile = {
    membership_level: 'associate',
    status: 'approved',
    is_active: true,
    membership_expires_at: '2099-01-01T00:00:00.000Z',
  };
  assert.equal(deriveMemberTier(profile), 'associate');
  assert.equal(hasCapability(profile, 'canAccessAiChart'), true);
  assert.equal(hasCapability(profile, 'canAccessRiskPreview'), false);
  assert.equal(hasCapability(profile, 'canAccessTradingAnalytics'), true);
  assert.equal(hasCapability(profile, 'canAccessAiTradingReview'), true);
});

test('inactive regular is treated as pending', () => {
  assert.equal(deriveMemberTier({ membership_level: 'regular', is_active: false, status: 'approved' }), 'pending');
});

test('suspended admin is treated as pending', () => {
  assert.equal(deriveMemberTier({ membership_level: 'admin', status: 'suspended', is_active: false }), 'pending');
});

test('unknown client role does not gain capabilities even when approved and active', () => {
  assert.equal(deriveMemberTier({ role: 'superadmin', status: 'pending', is_active: true }), 'pending');
  assert.equal(deriveMemberTier({ role: 'superadmin', status: 'approved', is_active: true }), 'pending');
  assert.equal(hasCapability({ role: 'superadmin', status: 'approved', is_active: true }, 'canAccessBasicInfo'), false);
  assert.equal(hasCapability({ role: 'superadmin', status: 'approved', is_active: true }, 'canManageMembers'), false);
});

test('membership labels use the requested Korean names', () => {
  assert.equal(memberTierLabel('pending'), '일반회원 · 승인대기');
  assert.equal(memberTierLabel('associate'), '준회원');
  assert.equal(memberTierLabel('regular'), '정회원');
  assert.equal(memberTierLabel('admin'), '관리자');
});

test('conflicting canonical and camelCase active flags never re-enable a disabled member', () => {
  for (const profile of [
    { membership_level: 'admin', status: 'approved', is_active: false, isActive: true },
    { membership_level: 'admin', status: 'approved', is_active: true, isActive: false },
    { membership_level: 'associate', status: 'approved', is_active: false, isActive: true },
    { membership_level: 'regular', status: 'approved', is_active: null, isActive: false },
  ]) {
    assert.equal(deriveMemberTier(profile), 'pending');
    assert.equal(hasCapability(profile, 'canAccessBasicInfo'), false);
    assert.equal(hasCapability(profile, 'canManageMembers'), false);
  }
  assert.equal(deriveMemberTier({
    membership_level: 'associate', status: 'approved', is_active: true, isActive: true,
  }), 'associate');
});
