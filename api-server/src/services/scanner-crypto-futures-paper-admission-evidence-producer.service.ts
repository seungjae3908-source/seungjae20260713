import {
  composeScannerCryptoFuturesPaperAdmission,
  type ScannerCryptoFuturesPaperAdmissionComposition,
} from './scanner-crypto-futures-paper-admission-composer.service';
import {
  SCANNER_PAPER_ADMISSION_BUNDLE_VERSION,
  type CanonicalPaperAdmissionEvidenceBundle,
} from './scanner-paper-admission-evidence-bundle.service';
import { calculateTradingRisk } from './trading-risk-engine.service';

export const SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_EVIDENCE_PRODUCER_VERSION =
  'scanner-crypto-futures-paper-admission-evidence-producer-v1' as const;

const SOURCE_KEYS = Object.freeze([
  'paperCandidate',
  'learningSnapshot',
  'paperState',
  'contractRules',
  'publicEvidence',
  'executionObservation',
  'supplementalCostEvidence',
] as const);

type ComposerInput = Parameters<typeof composeScannerCryptoFuturesPaperAdmission>[0];
type SourceKey = typeof SOURCE_KEYS[number];
type RiskRecalculator = typeof calculateTradingRisk;

export type ScannerCryptoFuturesPaperAdmissionEvidenceContext = Readonly<{
  card: unknown;
  market: 'CRYPTO_FUTURES';
  cycle?: unknown;
  signal?: unknown;
}>;

type EvidenceSource<K extends SourceKey> = (
  context: ScannerCryptoFuturesPaperAdmissionEvidenceContext,
) => ComposerInput[K] | Promise<ComposerInput[K]>;

export type ScannerCryptoFuturesPaperAdmissionEvidenceSources = Readonly<{
  [K in SourceKey]: EvidenceSource<K>;
}>;

export type ScannerCryptoFuturesPaperAdmissionEvidenceProducerResult = Readonly<{
  status: 'READY' | 'BLOCKED';
  producerVersion: typeof SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_EVIDENCE_PRODUCER_VERSION;
  bundle: CanonicalPaperAdmissionEvidenceBundle | null;
  blockers: readonly string[];
  composerStatus: ScannerCryptoFuturesPaperAdmissionComposition['status'] | null;
  executionAuthority: 'NONE';
  simulatedOnly: true;
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  exchangeRequestSent: false;
  productionMutationAllowed: false;
}>;

type ProducerOptions = Readonly<{
  sources: ScannerCryptoFuturesPaperAdmissionEvidenceSources;
  compose?: typeof composeScannerCryptoFuturesPaperAdmission;
  recalculateRisk?: RiskRecalculator;
  now?: () => number;
  maxEvidenceAgeMs?: number;
}>;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function nonNegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function safetyEnvelope() {
  return Object.freeze({
    executionAuthority: 'NONE' as const,
    simulatedOnly: true as const,
    liveOrderAllowed: false as const,
    privateTradingApiAllowed: false as const,
    orderSubmitted: false as const,
    exchangeRequestSent: false as const,
    productionMutationAllowed: false as const,
  });
}

function blocked(
  blockers: readonly string[],
  composerStatus: ScannerCryptoFuturesPaperAdmissionComposition['status'] | null = null,
): ScannerCryptoFuturesPaperAdmissionEvidenceProducerResult {
  return Object.freeze({
    status: 'BLOCKED',
    producerVersion: SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_EVIDENCE_PRODUCER_VERSION,
    bundle: null,
    blockers: Object.freeze([...new Set(blockers)]),
    composerStatus,
    ...safetyEnvelope(),
  });
}

function validBundleSafety(bundle: CanonicalPaperAdmissionEvidenceBundle): boolean {
  return bundle.schemaVersion === SCANNER_PAPER_ADMISSION_BUNDLE_VERSION
    && bundle.executionAuthority === 'NONE'
    && bundle.simulatedOnly === true
    && bundle.liveOrderAllowed === false
    && bundle.privateTradingApiAllowed === false
    && bundle.orderSubmitted === false
    && bundle.exchangeRequestSent === false
    && bundle.productionMutationAllowed === false;
}

function riskCostParityBlockers(
  composition: ScannerCryptoFuturesPaperAdmissionComposition,
  nowMs: number,
  recalculateRisk: RiskRecalculator,
): string[] {
  const bundle = composition.admissionResult?.bundle;
  const riskInput = composition.riskInput;
  const originalQuantity = composition.riskResult?.recommendedQuantity;
  const costPolicy = bundle?.executionEvidence?.costPolicy;
  if (!riskInput || !positive(originalQuantity) || !costPolicy) {
    return ['P0_C9_RISK_COST_PARITY_EVIDENCE_REQUIRED'];
  }

  const executionRates = [
    costPolicy.spreadRate,
    costPolicy.slippageRate,
    costPolicy.latencyRate,
    costPolicy.liquidityImpactRate,
    costPolicy.partialFillImpactRate,
  ];
  if (!executionRates.every(nonNegative)) {
    return ['P0_C9_RISK_COST_PARITY_EVIDENCE_INVALID'];
  }

  // Fees and funding are already separate Risk Engine inputs. Conservatively
  // fold every remaining adverse execution-cost component into the Risk Engine
  // slippage slot so the final eight-component policy can never carry a larger
  // quantity than the maximum-loss sizing envelope used for admission.
  const conservativeExecutionRate = executionRates.reduce((sum, value) => sum + value, 0);
  const parityInput = Object.freeze({ ...riskInput, slippageRate: conservativeExecutionRate });
  const parityResult = recalculateRisk(parityInput, new Date(nowMs));
  if (!parityResult.allowed || !positive(parityResult.recommendedQuantity)) {
    return [
      'P0_C9_RISK_COST_PARITY_BLOCKED',
      ...(Array.isArray(parityResult.blockCodes) ? parityResult.blockCodes : []),
    ];
  }

  const tolerance = Math.max(1e-12, originalQuantity * 1e-12);
  if (parityResult.recommendedQuantity + tolerance < originalQuantity) {
    return ['P0_C9_RISK_COST_PARITY_MISMATCH'];
  }
  return [];
}

function assertSources(sources: ScannerCryptoFuturesPaperAdmissionEvidenceSources): void {
  if (!sources || typeof sources !== 'object') {
    throw new TypeError('authoritative Crypto Futures Paper evidence sources are required');
  }
  for (const key of SOURCE_KEYS) {
    if (typeof sources[key] !== 'function') {
      throw new TypeError(`authoritative Paper evidence source is required: ${key}`);
    }
  }
}

export function createScannerCryptoFuturesPaperAdmissionEvidenceProducer({
  sources,
  compose = composeScannerCryptoFuturesPaperAdmission,
  recalculateRisk = calculateTradingRisk,
  now = Date.now,
  maxEvidenceAgeMs,
}: ProducerOptions) {
  assertSources(sources);
  if (typeof compose !== 'function') throw new TypeError('Paper admission composer is required');
  if (typeof recalculateRisk !== 'function') throw new TypeError('Trading Risk Engine parity recalculator is required');
  if (typeof now !== 'function') throw new TypeError('Paper admission evidence clock is required');
  if (maxEvidenceAgeMs != null && (!finite(maxEvidenceAgeMs) || maxEvidenceAgeMs <= 0)) {
    throw new TypeError('positive maxEvidenceAgeMs is required when provided');
  }

  return async function produceScannerCryptoFuturesPaperAdmissionEvidence({
    card,
    market,
    cycle,
    signal,
  }: Readonly<{ card: unknown; market?: string; cycle?: unknown; signal?: unknown }>): Promise<ScannerCryptoFuturesPaperAdmissionEvidenceProducerResult> {
    if (market !== 'CRYPTO_FUTURES') {
      return blocked(['P0_C9_MARKET_NOT_OWNED']);
    }

    const nowMs = now();
    if (!finite(nowMs) || nowMs <= 0) return blocked(['P0_C9_EVIDENCE_CLOCK_INVALID']);

    const context: ScannerCryptoFuturesPaperAdmissionEvidenceContext = Object.freeze({
      card,
      market,
      cycle,
      signal,
    });

    let input: ComposerInput;
    try {
      const paperCandidate = await sources.paperCandidate(context);
      const learningSnapshot = await sources.learningSnapshot(context);
      const paperState = await sources.paperState(context);
      const contractRules = await sources.contractRules(context);
      const publicEvidence = await sources.publicEvidence(context);
      const executionObservation = await sources.executionObservation(context);
      const supplementalCostEvidence = await sources.supplementalCostEvidence(context);

      if ([
        paperCandidate,
        learningSnapshot,
        paperState,
        contractRules,
        publicEvidence,
        executionObservation,
        supplementalCostEvidence,
      ].some((value) => value == null)) {
        return blocked(['P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING']);
      }

      input = {
        paperCandidate,
        learningSnapshot,
        paperState,
        contractRules,
        publicEvidence,
        executionObservation,
        supplementalCostEvidence,
        nowMs,
        ...(maxEvidenceAgeMs == null ? {} : { maxEvidenceAgeMs }),
      };
    } catch {
      return blocked(['P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_FAILED']);
    }

    let composition: ScannerCryptoFuturesPaperAdmissionComposition;
    try {
      composition = compose(input);
    } catch {
      return blocked(['P0_C9_ADMISSION_COMPOSER_FAILED']);
    }

    if (composition.status !== 'READY'
      || composition.admissionResult?.status !== 'READY'
      || !composition.admissionResult.bundle) {
      return blocked([
        'P0_C9_ADMISSION_COMPOSER_BLOCKED',
        ...(composition.blockers ?? []),
        ...(composition.admissionResult?.blockers ?? []),
      ], composition.status);
    }

    const bundle = composition.admissionResult.bundle;
    if (!validBundleSafety(bundle)) {
      return blocked(['P0_C9_CANONICAL_ADMISSION_BUNDLE_INVALID'], composition.status);
    }

    const parityBlockers = riskCostParityBlockers(composition, nowMs, recalculateRisk);
    if (parityBlockers.length > 0) return blocked(parityBlockers, composition.status);

    return Object.freeze({
      status: 'READY',
      producerVersion: SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_EVIDENCE_PRODUCER_VERSION,
      bundle,
      blockers: Object.freeze([]),
      composerStatus: composition.status,
      ...safetyEnvelope(),
    });
  };
}
