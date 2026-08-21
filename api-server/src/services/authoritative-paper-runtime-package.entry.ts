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
  AUTHORITATIVE_PAPER_BLOCKED_DATA_SOURCE_CONTRACT_VERSION,
  AUTHORITATIVE_PAPER_EVIDENCE_SOURCES_SAFETY,
  AUTHORITATIVE_PAPER_EVIDENCE_SOURCES_VERSION,
  createAuthoritativePaperEvidenceSourceWiring,
} from './authoritative-paper-evidence-sources.service';

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
