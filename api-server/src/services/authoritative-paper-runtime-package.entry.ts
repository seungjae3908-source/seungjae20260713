export {
  createScannerCryptoFuturesPaperAdmissionEvidenceProducer,
  SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_EVIDENCE_PRODUCER_VERSION,
} from './scanner-crypto-futures-paper-admission-evidence-producer.service';

export {
  createImmutablePaperTradingStateSnapshot,
  validateImmutablePaperTradingStateSnapshot,
  PAPER_TRADING_STATE_SNAPSHOT_VERSION,
} from './paper-trading-state-snapshot.service';

export const AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_SAFETY = Object.freeze({
  schemaVersion: 'authoritative-paper-runtime-package-safety-v1',
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  scheduleActivationAuthority: false,
  financialMutationAllowed: false,
});
