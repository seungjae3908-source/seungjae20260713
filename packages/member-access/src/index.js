export const MEMBER_TIERS = ['pending', 'associate', 'regular', 'admin'];

export const MEMBER_TIER_LABELS = Object.freeze({
  pending: '일반회원 · 승인대기',
  associate: '준회원',
  regular: '정회원',
  admin: '관리자',
});

export const MEMBER_CAPABILITIES = Object.freeze([
  'canAccessBasicInfo',
  'canAccessSpot',
  'canAccessFutures',
  'canAccessRiskPreview',
  'canAccessBacktests',
  'canAccessPaperTrading',
  'canPlaceOrders',
  'canAccessJournalSync',
  'canAccessTradingAnalytics',
  'canAccessAiTradingReview',
  'canManageMembers',
]);

const NONE = Object.freeze(Object.fromEntries(MEMBER_CAPABILITIES.map((capability) => [capability, false])));
const ASSOCIATE = Object.freeze({
  ...NONE,
  canAccessBasicInfo: true,
  canAccessSpot: true,
});
const REGULAR = Object.freeze({
  ...ASSOCIATE,
  canAccessFutures: true,
  canAccessRiskPreview: true,
  canAccessBacktests: true,
  canAccessPaperTrading: true,
  canAccessJournalSync: true,
  canAccessTradingAnalytics: true,
  canAccessAiTradingReview: true,
});
const ADMIN = Object.freeze({ ...REGULAR, canPlaceOrders: true, canManageMembers: true });

export const MEMBER_PERMISSION_MATRIX = Object.freeze({
  pending: NONE,
  associate: ASSOCIATE,
  regular: REGULAR,
  admin: ADMIN,
});

const inactiveStatuses = new Set(['rejected', 'suspended', 'withdrawn', 'disabled', 'inactive']);

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function deriveMemberTier(profile) {
  const value = asRecord(profile);
  const explicit = typeof value.membership_level === 'string'
    ? value.membership_level
    : typeof value.membershipLevel === 'string'
      ? value.membershipLevel
      : null;
  const active = value.is_active !== false && value.isActive !== false;
  const status = typeof value.status === 'string' ? value.status : null;

  if (!active || (status && inactiveStatuses.has(status))) return 'pending';
  if (explicit && MEMBER_TIERS.includes(explicit)) return explicit;
  if (value.role === 'admin') return status === 'pending' ? 'pending' : 'admin';
  if (value.role === 'associate') return 'associate';
  if (value.role === 'regular') return 'regular';
  if (status === 'approved') return 'regular';
  return 'pending';
}

export function permissionsFor(profileOrTier) {
  const tier = typeof profileOrTier === 'string' && MEMBER_TIERS.includes(profileOrTier)
    ? profileOrTier
    : deriveMemberTier(profileOrTier);
  return MEMBER_PERMISSION_MATRIX[tier];
}

export function hasCapability(profileOrTier, capability) {
  return permissionsFor(profileOrTier)[capability] === true;
}

export function isActiveMember(profileOrTier) {
  return hasCapability(profileOrTier, 'canAccessBasicInfo');
}

export function memberTierLabel(profileOrTier) {
  const tier = typeof profileOrTier === 'string' && MEMBER_TIERS.includes(profileOrTier)
    ? profileOrTier
    : deriveMemberTier(profileOrTier);
  return MEMBER_TIER_LABELS[tier];
}
