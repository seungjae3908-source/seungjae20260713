export {
  createScannerCryptoFuturesPaperAdmissionEvidenceProducer,
  SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_EVIDENCE_PRODUCER_VERSION,
} from './scanner-crypto-futures-paper-admission-evidence-producer.service';

export {
  createImmutablePaperTradingStateSnapshot,
  validateImmutablePaperTradingStateSnapshot,
  PAPER_TRADING_STATE_SNAPSHOT_VERSION,
} from './paper-trading-state-snapshot.service';

export {
  AUTHORITATIVE_PAPER_CALLBACK_OWNER_CONTRACT_VERSION,
  AUTHORITATIVE_PAPER_BLOCKED_DATA_SOURCE_CONTRACT_VERSION,
  AUTHORITATIVE_PAPER_EVIDENCE_SOURCES_SAFETY,
  AUTHORITATIVE_PAPER_EVIDENCE_SOURCES_VERSION,
  createAuthoritativePaperEvidenceSourceWiring,
  createAuthoritativePaperNaturalCycleEvidenceSourceWiring,
} from './authoritative-paper-evidence-sources.service';

export {
  AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_PRODUCER_SAFETY,
  AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_PRODUCER_VERSION,
  AUTHORITATIVE_PAPER_GENERIC_RISK_POLICY_RECORD_VERSION,
  AUTHORITATIVE_PAPER_GENERIC_RISK_SIZING_BRIDGE_VERSION,
  buildAuthoritativePaperRiskSizingFromGenericRiskPolicySource,
  createAuthoritativePaperGenericRiskPolicyProducer,
} from './authoritative-paper-generic-risk-policy-producer.service';

export {
  AUTHORITATIVE_PAPER_RISK_SIZING_SOURCE_SAFETY,
  AUTHORITATIVE_PAPER_RISK_SIZING_SOURCE_VERSION,
  buildAuthoritativePaperRiskSizingEvidence,
} from './authoritative-paper-risk-sizing-source.service';

export {
  AUTHORITATIVE_PAPER_CALLBACK_OWNERS_SAFETY,
  AUTHORITATIVE_PAPER_CALLBACK_OWNERS_VERSION,
  buildAuthoritativePaperExecutionObservation,
  buildAuthoritativeSizedContractRules,
  buildAuthoritativeSupplementalCostEvidence,
  paperStateFromAuthoritativeSnapshot,
} from './authoritative-paper-callback-owners.service';

export {
  AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY,
  AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_VERSION,
  bindAuthoritativePaperLatencyToSupplementalCostInput,
  buildAuthoritativePaperLatencyCostEvidence,
  collectAuthoritativePaperLatencyCostEvidence,
  readBitgetPublicLatencyMidpointQuote,
} from './authoritative-paper-latency-cost-evidence.service';

export {
  buildPaperSimulatedExecutionEvidence,
  PAPER_SIMULATED_EXECUTION_EVIDENCE_SAFETY,
  PAPER_SIMULATED_EXECUTION_EVIDENCE_VERSION,
} from './paper-simulated-execution-evidence.service';

export const AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_SAFETY = Object.freeze({
  schemaVersion: 'authoritative-paper-runtime-package-safety-v1',
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  scheduleActivationAuthority: false,
  financialMutationAllowed: false,
});
