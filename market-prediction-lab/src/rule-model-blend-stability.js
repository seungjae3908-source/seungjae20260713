export function evaluateRuleWeightSnapshotStability(snapshots, { minimumSnapshots = 2 } = {}) {
  if (!Array.isArray(snapshots) || snapshots.length < minimumSnapshots) {
    throw new TypeError(`at least ${minimumSnapshots} snapshots are required`);
  }
  const normalized = snapshots.map((snapshot, index) => {
    if (!snapshot || typeof snapshot !== "object" || typeof snapshot.id !== "string" || snapshot.id.length === 0) {
      throw new TypeError(`snapshots[${index}].id is required`);
    }
    const ruleWeight = snapshot.ruleWeight;
    if (!(typeof ruleWeight === "number" && Number.isFinite(ruleWeight) && ruleWeight >= 0 && ruleWeight <= 0.65)) {
      throw new RangeError(`snapshots[${index}].ruleWeight must be in [0, 0.65]`);
    }
    return Object.freeze({ id: snapshot.id, ruleWeight: Math.round(ruleWeight * 1000) / 1000 });
  });
  const selectedWeights = Object.freeze(normalized.map((snapshot) => snapshot.ruleWeight));
  const stable = selectedWeights.every((weight) => weight === selectedWeights[0]);
  return Object.freeze({
    stable,
    status: stable ? "stable_shadow_challenger_candidate" : "research_hold",
    reason: stable ? null : "validation_selected_rule_weight_unstable_across_snapshots",
    selectedRuleWeight: stable ? selectedWeights[0] : null,
    selectedWeights,
    snapshots: Object.freeze(normalized),
    safety: Object.freeze({
      exactGridAgreementRequired: true,
      toleranceIntroducedAfterObservation: false,
      runtimeChanged: false,
      thresholdChanged: false,
      classWeightChanged: false,
      labelChanged: false,
      liveAuthority: false,
      promotionAuthority: false,
    }),
  });
}
