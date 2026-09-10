export const BITGET_POSITION_TIER_CONTRACT: Readonly<{
  schemaVersion: 'bitget-position-tier-v1';
  source: 'bitget-public-v2-query-position-lever';
  sizedNotionalRequired: true;
  scalarDefaultAllowed: false;
  unknownIsZero: false;
}>;

export type BitgetPositionTier = Readonly<{
  index: number;
  startUnit: number;
  maintenanceMarginRate: number;
  sizedNotional: number;
  source: 'bitget-public-v2-query-position-lever';
  schemaVersion: 'bitget-position-tier-v1';
}>;

export function selectBitgetPositionTier(
  tiers: readonly unknown[],
  sizedNotional: number,
): BitgetPositionTier;
