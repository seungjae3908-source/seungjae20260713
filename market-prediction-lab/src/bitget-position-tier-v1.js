export const BITGET_POSITION_TIER_CONTRACT = Object.freeze({
  schemaVersion: "bitget-position-tier-v1",
  source: "bitget-public-v2-query-position-lever",
  sizedNotionalRequired: true,
  scalarDefaultAllowed: false,
  unknownIsZero: false,
});

function finite(value, code) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

export function selectBitgetPositionTier(tiers, sizedNotional) {
  if (!Number.isFinite(sizedNotional) || sizedNotional <= 0) {
    throw new Error("BITGET_POSITION_TIER_SIZED_NOTIONAL_REQUIRED");
  }
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error("BITGET_POSITION_TIER_SCHEDULE_REQUIRED");
  }
  const normalized = tiers.map((tier, index) => {
    const startUnit = finite(tier?.startUnit ?? 0, "BITGET_POSITION_TIER_START_INVALID");
    const maintenanceMarginRate = finite(tier?.keepMarginRate, "BITGET_POSITION_TIER_MMR_INVALID");
    if (startUnit < 0 || maintenanceMarginRate < 0 || maintenanceMarginRate >= 1) {
      throw new Error("BITGET_POSITION_TIER_INVALID");
    }
    return Object.freeze({ index, startUnit, maintenanceMarginRate });
  }).sort((left, right) => left.startUnit - right.startUnit);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].startUnit === normalized[index].startUnit) {
      throw new Error("BITGET_POSITION_TIER_DUPLICATE_START");
    }
  }
  const selected = normalized
    .filter((tier) => tier.startUnit <= sizedNotional)
    .at(-1);
  if (!selected) throw new Error("BITGET_POSITION_TIER_NOT_FOUND_FOR_NOTIONAL");
  return Object.freeze({
    ...selected,
    sizedNotional,
    source: BITGET_POSITION_TIER_CONTRACT.source,
    schemaVersion: BITGET_POSITION_TIER_CONTRACT.schemaVersion,
  });
}
