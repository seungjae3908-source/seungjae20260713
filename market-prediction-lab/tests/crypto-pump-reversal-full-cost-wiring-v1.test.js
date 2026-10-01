import assert from "node:assert/strict";
import test from "node:test";

import {
  createPumpProspectiveFullCostSettlementWiringV1,
  PUMP_PROSPECTIVE_FULL_COST_WIRING_SAFETY,
} from "../src/crypto-pump-reversal-full-cost-wiring-v1.js";

test("wiring composes the canonical authoritative collector with the Pump settlement owner", async () => {
  const runtimePackage = { runtime: "authoritative" };
  const readSupplementalCostInput = async () => ({ costPolicyId: "pump-cost-v1" });
  const bitgetClient = { get: async () => ({}) };
  const collectFundingHistory = async () => ({ exhausted: true, records: [] });
  const collectExitSnapshot = async () => ({ status: "PRESENT" });
  const clock = () => 1_800_000_000_000;

  let collectorOptions = null;
  let ownerOptions = null;
  const authoritativeCollector = async (input) => ({ status: "PRESENT", input });
  const settlementOwner = async (input) => ({ status: "SETTLED", input });

  const wiring = createPumpProspectiveFullCostSettlementWiringV1({
    runtimePackage,
    readSupplementalCostInput,
    bitgetClient,
    collectFundingHistory,
    collectExitSnapshot,
    now: clock,
    collectorFactory: (options) => {
      collectorOptions = options;
      return authoritativeCollector;
    },
    settlementOwnerFactory: (options) => {
      ownerOptions = options;
      return settlementOwner;
    },
  });

  assert.equal(collectorOptions.runtimePackage, runtimePackage);
  assert.equal(collectorOptions.readSupplementalCostInput, readSupplementalCostInput);
  assert.equal(collectorOptions.bitgetClient, bitgetClient);
  assert.equal(collectorOptions.collectFundingHistory, collectFundingHistory);
  assert.equal(collectorOptions.collectExitSnapshot, collectExitSnapshot);
  assert.equal(collectorOptions.now, clock);
  assert.equal(ownerOptions.collectAuthoritativeEvidence, authoritativeCollector);
  assert.equal(ownerOptions.clock, clock);
  assert.equal(wiring.settleFullCost, settlementOwner);
  assert.equal(wiring.canonicalEightComponentFullCostRequired, true);
  assert.equal(wiring.missingCostConvertedToZero, false);
  assert.equal(wiring.exactFundingBoundaryUpgradePath, "EXACT_MINUTE_MARK_FUNDING_OWNER");
  assert.equal(wiring.executionAuthority, "NONE");
  assert.equal(wiring.liveOrderAllowed, false);
  assert.equal(wiring.privateTradingApiAllowed, false);
});

test("wiring refuses to exist without canonical supplemental-cost ownership", () => {
  assert.throws(
    () => createPumpProspectiveFullCostSettlementWiringV1({
      runtimePackage: {},
      readSupplementalCostInput: null,
    }),
    /supplemental cost reader is required/,
  );
});

test("Full Cost wiring safety keeps profitability and all trading authority disabled", () => {
  assert.equal(PUMP_PROSPECTIVE_FULL_COST_WIRING_SAFETY.authoritativeCollectorReused, true);
  assert.equal(PUMP_PROSPECTIVE_FULL_COST_WIRING_SAFETY.canonicalPumpSettlementAdapterReused, true);
  assert.equal(PUMP_PROSPECTIVE_FULL_COST_WIRING_SAFETY.exactFundingBoundaryOwnerRequired, true);
  assert.equal(PUMP_PROSPECTIVE_FULL_COST_WIRING_SAFETY.missingCostConvertedToZero, false);
  assert.equal(PUMP_PROSPECTIVE_FULL_COST_WIRING_SAFETY.delayedExitRepricingAllowed, false);
  assert.equal(PUMP_PROSPECTIVE_FULL_COST_WIRING_SAFETY.profitabilityClaimAllowed, false);
  assert.equal(PUMP_PROSPECTIVE_FULL_COST_WIRING_SAFETY.executionAuthority, "NONE");
  assert.equal(PUMP_PROSPECTIVE_FULL_COST_WIRING_SAFETY.liveOrderAllowed, false);
  assert.equal(PUMP_PROSPECTIVE_FULL_COST_WIRING_SAFETY.privateTradingApiAllowed, false);
});
