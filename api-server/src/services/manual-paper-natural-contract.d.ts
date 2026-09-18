declare module '*natural-paper-position-settlement-lifecycle-v1.js' {
  export const NATURAL_SETTLEMENT_COST_COMPONENTS: readonly string[];
  export function adaptNaturalPaperSettlementFullCost(input: unknown): any;
  export function advanceNaturalPaperPositionLifecycle(input: unknown): any;
}
declare module '*natural-paper-trigger-bound-settlement-cost-producer-v1.js' {
  export function validateNaturalPaperTriggerBoundSettlementEvidence(input: unknown): any;
}
declare module '*four-market-paper-sampler-v1.js' {
  export function buildFourMarketPaperSample(input: unknown): any;
}
declare module '*four-market-paper-settlement-v1.js' {
  export function settleFourMarketPaperSample(input: unknown): any;
}
declare module '*recurring-paper-loop-v1.js' {
  export function buildRecurringPaperSettlementRecord(input: unknown): any;
  export function runRecurringPaperCycle(input: unknown): Promise<any>;
}
declare module '*canonical-paper-admission-bridge-v1.js' {
  export function resolveCanonicalPaperAdmissionBridgeCandidate(input: unknown): any;
}
declare module '*canonical-paper-simulation-authority-v1.js' {
  export function resolveCanonicalPaperSimulationAuthority(input: unknown): any;
}
