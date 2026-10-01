import {
  createNaturalPaperAuthoritativeSettlementCostCollector,
} from "./natural-paper-authoritative-settlement-cost-collector-v1.js";
import {
  createPumpProspectiveFullCostSettlementOwnerV1,
} from "./crypto-pump-reversal-full-cost-settlement-v1.js";

export const PUMP_PROSPECTIVE_FULL_COST_WIRING_VERSION =
  "crypto-pump-reversal-full-cost-wiring-v1";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function createPumpProspectiveFullCostSettlementWiringV1({
  runtimePackage,
  readSupplementalCostInput,
  bitgetClient,
  collectFundingHistory,
  collectExitSnapshot,
  now = Date.now,
  collectorFactory = createNaturalPaperAuthoritativeSettlementCostCollector,
  settlementOwnerFactory = createPumpProspectiveFullCostSettlementOwnerV1,
} = {}) {
  if (!runtimePackage || typeof runtimePackage !== "object") {
    throw new TypeError("Pump Full Cost authoritative runtime package is required");
  }
  if (typeof readSupplementalCostInput !== "function") {
    throw new TypeError("Pump Full Cost supplemental cost reader is required");
  }
  if (typeof now !== "function"
    || typeof collectorFactory !== "function"
    || typeof settlementOwnerFactory !== "function") {
    throw new TypeError("Pump Full Cost wiring dependencies must be functions");
  }

  const collectorOptions = {
    runtimePackage,
    readSupplementalCostInput,
    now,
  };
  if (bitgetClient != null) collectorOptions.bitgetClient = bitgetClient;
  if (collectFundingHistory != null) collectorOptions.collectFundingHistory = collectFundingHistory;
  if (collectExitSnapshot != null) collectorOptions.collectExitSnapshot = collectExitSnapshot;

  const collectAuthoritativeEvidence = collectorFactory(collectorOptions);
  if (typeof collectAuthoritativeEvidence !== "function") {
    throw new TypeError("Pump authoritative Full Cost collector factory returned no collector");
  }
  const settleFullCost = settlementOwnerFactory({
    collectAuthoritativeEvidence,
    clock: now,
  });
  if (typeof settleFullCost !== "function") {
    throw new TypeError("Pump Full Cost settlement owner factory returned no owner");
  }

  return deepFreeze({
    schemaVersion: PUMP_PROSPECTIVE_FULL_COST_WIRING_VERSION,
    settleFullCost,
    collectorOwner: "NATURAL_PAPER_PUBLIC_SETTLEMENT_COST_COLLECTOR_V1",
    exactFundingBoundaryUpgradePath: "PR_1549_EXACT_MINUTE_MARK_OWNER",
    canonicalEightComponentFullCostRequired: true,
    missingCostConvertedToZero: false,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
  });
}

export const PUMP_PROSPECTIVE_FULL_COST_WIRING_SAFETY = Object.freeze({
  schemaVersion: PUMP_PROSPECTIVE_FULL_COST_WIRING_VERSION,
  authoritativeCollectorReused: true,
  canonicalPumpSettlementAdapterReused: true,
  exactFundingBoundaryOwnerExpectedFromPr1549: true,
  missingCostConvertedToZero: false,
  delayedExitRepricingAllowed: false,
  profitabilityClaimAllowed: false,
  executionAuthority: "NONE",
  liveOrderAllowed: false,
  privateTradingApiAllowed: false,
});
