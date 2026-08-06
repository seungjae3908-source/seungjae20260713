export type MemberTier = 'pending' | 'associate' | 'regular' | 'admin';

export type MemberCapability =
  | 'canAccessBasicInfo'
  | 'canAccessSpot'
  | 'canAccessFutures'
  | 'canAccessSignalScanner'
  | 'canPlaceOrders'
  | 'canAccessTradeAutomation'
  | 'canApprovePaperOrder'
  | 'canAccessRiskPreview'
  | 'canAccessBacktests'
  | 'canAccessPaperTrading'
  | 'canAccessJournalSync'
  | 'canAccessTradingAnalytics'
  | 'canAccessAiTradingReview'
  | 'canManageMembers';

export type MemberAccessProfile = {
  membership_level?: MemberTier | string | null;
  membershipLevel?: MemberTier | string | null;
  role?: string | null;
  status?: string | null;
  is_active?: boolean | null;
  isActive?: boolean | null;
};

export const MEMBER_TIERS: readonly MemberTier[];
export const MEMBER_TIER_LABELS: Readonly<Record<MemberTier, string>>;
export const MEMBER_CAPABILITIES: readonly MemberCapability[];
export const MEMBER_PERMISSION_MATRIX: Readonly<Record<MemberTier, Readonly<Record<MemberCapability, boolean>>>>;

export function deriveMemberTier(profile: MemberAccessProfile | null | undefined): MemberTier;
export function permissionsFor(profileOrTier: MemberAccessProfile | MemberTier | null | undefined): Readonly<Record<MemberCapability, boolean>>;
export function hasCapability(profileOrTier: MemberAccessProfile | MemberTier | null | undefined, capability: MemberCapability): boolean;
export function isActiveMember(profileOrTier: MemberAccessProfile | MemberTier | null | undefined): boolean;
export function memberTierLabel(profileOrTier: MemberAccessProfile | MemberTier | null | undefined): string;
