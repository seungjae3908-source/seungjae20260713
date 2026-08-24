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
  gateObservability: ScannerCryptoFuturesPaperGateObservability;
  executionAuthority: 'NONE';
  simulatedOnly: true;
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  exchangeRequestSent: false;
  productionMutationAllowed: false;
}>;

export type ScannerCryptoFuturesPaperGateObservation = Readonly<{
  status: 'MEASURED' | 'UNKNOWN';
  evaluated: boolean;
  passed: boolean | null;
  decision: 'PASS' | 'BLOCKED' | 'NOT_REACHED' | 'UNKNOWN';
  provenance: string;
  observedAt: number | null;
  observationId: string | null;
  sourceCodes: readonly string[];
}>;

export type ScannerCryptoFuturesPaperReasonObservation = Readonly<{
  sourceStage: 'QUALITY_GATE' | 'RISK_GATE' | 'EVIDENCE_SOURCE' | 'PAPER_ADMISSION';
  sourceCode: string;
  sourceReason: string;
  canonicalReason: 'QUALITY_GATE' | 'RISK_GATE' | 'DATA_MISSING' | 'UNKNOWN';
  lossless: boolean;
  provenance: string;
  observedAt: number | null;
  identity: Readonly<{ observationId: string | null }>;
  naturalCredit: 0;
  replayCredit: 0;
  duplicateCredit: 0;
}>;

export type ScannerCryptoFuturesPaperGateObservability = Readonly<{
  schemaVersion: 'scanner-crypto-futures-paper-gate-observability-v1';
  qualityGate: ScannerCryptoFuturesPaperGateObservation;
  riskGate: ScannerCryptoFuturesPaperGateObservation;
  reasonObservations: readonly ScannerCryptoFuturesPaperReasonObservation[];
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

function observationId(card: unknown, signal: unknown): string | null {
  const values = [
    (signal as { signalId?: unknown } | null)?.signalId,
    (card as { signalId?: unknown } | null)?.signalId,
    (card as { id?: unknown } | null)?.id,
    (card as { paperCandidate?: { signal?: { signalId?: unknown } } } | null)?.paperCandidate?.signal?.signalId,
  ];
  const value = values.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);
  return typeof value === 'string' ? value.trim() : null;
}

function gateObservation({
  status = 'UNKNOWN', evaluated = false, passed = null, decision = 'UNKNOWN',
  provenance, observedAt = null, observationId: id = null, sourceCodes = [],
}: Readonly<{
  status?: 'MEASURED' | 'UNKNOWN';
  evaluated?: boolean;
  passed?: boolean | null;
  decision?: 'PASS' | 'BLOCKED' | 'NOT_REACHED' | 'UNKNOWN';
  provenance: string;
  observedAt?: number | null;
  observationId?: string | null;
  sourceCodes?: readonly string[];
}>): ScannerCryptoFuturesPaperGateObservation {
  const measured = status === 'MEASURED';
  return Object.freeze({
    status: measured ? 'MEASURED' : 'UNKNOWN',
    evaluated: measured && evaluated,
    passed: measured && typeof passed === 'boolean' ? passed : null,
    decision: measured ? decision : 'UNKNOWN',
    provenance,
    observedAt: finite(observedAt) && observedAt > 0 ? observedAt : null,
    observationId: typeof id === 'string' && id.length > 0 ? id : null,
    sourceCodes: Object.freeze([...new Set(sourceCodes.filter((code) => typeof code === 'string' && code.length > 0))]),
  });
}

function reasonObservations({
  sourceStage, sourceCodes, canonicalReason, lossless, provenance, observedAt, observationId: id,
}: Readonly<{
  sourceStage: ScannerCryptoFuturesPaperReasonObservation['sourceStage'];
  sourceCodes: readonly string[];
  canonicalReason: ScannerCryptoFuturesPaperReasonObservation['canonicalReason'];
  lossless: boolean;
  provenance: string;
  observedAt: number | null;
  observationId: string | null;
}>): readonly ScannerCryptoFuturesPaperReasonObservation[] {
  return Object.freeze([...new Set(sourceCodes)].map((sourceCode) => Object.freeze({
    sourceStage,
    sourceCode,
    sourceReason: sourceCode,
    canonicalReason,
    lossless,
    provenance,
    observedAt: finite(observedAt) && observedAt > 0 ? observedAt : null,
    identity: Object.freeze({ observationId: id }),
    naturalCredit: 0 as const,
    replayCredit: 0 as const,
    duplicateCredit: 0 as const,
  })));
}

function gateObservability({
  qualityGate, riskGate, reasonObservations: reasons = [],
}: Readonly<{
  qualityGate: ScannerCryptoFuturesPaperGateObservation;
  riskGate: ScannerCryptoFuturesPaperGateObservation;
  reasonObservations?: readonly ScannerCryptoFuturesPaperReasonObservation[];
}>): ScannerCryptoFuturesPaperGateObservability {
  return Object.freeze({
    schemaVersion: 'scanner-crypto-futures-paper-gate-observability-v1',
    qualityGate,
    riskGate,
    reasonObservations: Object.freeze([...reasons]),
  });
}

function unknownGateObservability(
  sourceCodes: readonly string[] = [],
  observedAt: number | null = null,
  id: string | null = null,
  sourceStage: ScannerCryptoFuturesPaperReasonObservation['sourceStage'] = 'EVIDENCE_SOURCE',
  canonicalReason: ScannerCryptoFuturesPaperReasonObservation['canonicalReason'] = 'UNKNOWN',
  lossless = false,
): ScannerCryptoFuturesPaperGateObservability {
  return gateObservability({
    qualityGate: gateObservation({ provenance: 'scanner admission Quality gate was not evaluated', observedAt, observationId: id }),
    riskGate: gateObservation({ provenance: 'Trading Risk Engine was not evaluated', observedAt, observationId: id }),
    reasonObservations: reasonObservations({
      sourceStage,
      sourceCodes,
      canonicalReason,
      lossless,
      provenance: 'scanner-crypto-futures-paper-admission-evidence-producer-v1',
      observedAt,
      observationId: id,
    }),
  });
}

function compositionGateObservability(
  composition: ScannerCryptoFuturesPaperAdmissionComposition,
  observedAt: number,
  id: string | null,
): ScannerCryptoFuturesPaperGateObservability {
  const qualityPassed = Boolean(composition.riskInput && composition.riskResult);
  const riskEvaluated = Boolean(composition.riskResult);
  const riskPassed = Boolean(composition.riskResult?.allowed && positive(composition.riskResult?.recommendedQuantity));
  const qualityCodes = qualityPassed ? [] : [...(composition.blockers ?? [])];
  const riskCodes = riskEvaluated && !riskPassed
    ? [...(composition.riskResult?.blockCodes ?? []), ...(composition.blockers ?? [])]
    : [];
  return gateObservability({
    qualityGate: gateObservation({
      status: 'MEASURED', evaluated: true, passed: qualityPassed,
      decision: qualityPassed ? 'PASS' : 'BLOCKED',
      provenance: 'scanner-crypto-futures-paper-admission-composer.service.ts pre-risk validation outcome',
      observedAt, observationId: id, sourceCodes: qualityCodes,
    }),
    riskGate: gateObservation({
      status: 'MEASURED', evaluated: riskEvaluated, passed: riskPassed,
      decision: riskEvaluated ? (riskPassed ? 'PASS' : 'BLOCKED') : 'NOT_REACHED',
      provenance: riskEvaluated
        ? 'scanner-crypto-futures-paper-admission-composer.service.ts riskResult'
        : 'Trading Risk Engine not reached after measured Quality block',
      observedAt, observationId: id, sourceCodes: riskCodes,
    }),
    reasonObservations: [
      ...reasonObservations({
        sourceStage: 'QUALITY_GATE', sourceCodes: qualityCodes, canonicalReason: 'QUALITY_GATE', lossless: true,
        provenance: 'scanner-crypto-futures-paper-admission-composer.service.ts pre-risk blockers', observedAt, observationId: id,
      }),
      ...reasonObservations({
        sourceStage: 'RISK_GATE', sourceCodes: riskCodes, canonicalReason: 'RISK_GATE', lossless: true,
        provenance: 'scanner-crypto-futures-paper-admission-composer.service.ts riskResult.blockCodes', observedAt, observationId: id,
      }),
    ],
  });
}

function withFinalRiskBlock(
  observability: ScannerCryptoFuturesPaperGateObservability,
  blockers: readonly string[],
): ScannerCryptoFuturesPaperGateObservability {
  const risk = observability.riskGate;
  return gateObservability({
    qualityGate: observability.qualityGate,
    riskGate: gateObservation({
      status: 'MEASURED', evaluated: true, passed: false, decision: 'BLOCKED',
      provenance: 'scanner-crypto-futures-paper-admission-evidence-producer-v1 final risk-cost parity decision',
      observedAt: risk.observedAt, observationId: risk.observationId, sourceCodes: blockers,
    }),
    reasonObservations: [
      ...observability.reasonObservations,
      ...reasonObservations({
        sourceStage: 'RISK_GATE', sourceCodes: blockers, canonicalReason: 'RISK_GATE', lossless: true,
        provenance: 'scanner-crypto-futures-paper-admission-evidence-producer-v1 final risk-cost parity decision',
        observedAt: risk.observedAt, observationId: risk.observationId,
      }),
    ],
  });
}

function blocked(
  blockers: readonly string[],
  composerStatus: ScannerCryptoFuturesPaperAdmissionComposition['status'] | null = null,
  observability: ScannerCryptoFuturesPaperGateObservability = unknownGateObservability(blockers),
): ScannerCryptoFuturesPaperAdmissionEvidenceProducerResult {
  return Object.freeze({
    status: 'BLOCKED',
    producerVersion: SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_EVIDENCE_PRODUCER_VERSION,
    bundle: null,
    blockers: Object.freeze([...new Set(blockers)]),
    composerStatus,
    gateObservability: observability,
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
    const id = observationId(card, signal);
    if (market !== 'CRYPTO_FUTURES') {
      return blocked(['P0_C9_MARKET_NOT_OWNED'], null, unknownGateObservability(
        ['P0_C9_MARKET_NOT_OWNED'], null, id, 'EVIDENCE_SOURCE', 'UNKNOWN', false,
      ));
    }

    const nowMs = now();
    if (!finite(nowMs) || nowMs <= 0) return blocked(['P0_C9_EVIDENCE_CLOCK_INVALID'], null, unknownGateObservability(
      ['P0_C9_EVIDENCE_CLOCK_INVALID'], null, id, 'EVIDENCE_SOURCE', 'UNKNOWN', false,
    ));

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
        return blocked(['P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING'], null, unknownGateObservability(
          ['P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING'], nowMs, id, 'EVIDENCE_SOURCE', 'DATA_MISSING', true,
        ));
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
      return blocked(['P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_FAILED'], null, unknownGateObservability(
        ['P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_FAILED'], nowMs, id, 'EVIDENCE_SOURCE', 'UNKNOWN', false,
      ));
    }

    let composition: ScannerCryptoFuturesPaperAdmissionComposition;
    try {
      composition = compose(input);
    } catch {
      return blocked(['P0_C9_ADMISSION_COMPOSER_FAILED'], null, unknownGateObservability(
        ['P0_C9_ADMISSION_COMPOSER_FAILED'], nowMs, id, 'PAPER_ADMISSION', 'UNKNOWN', false,
      ));
    }
    const observedGates = compositionGateObservability(composition, nowMs, id);

    if (composition.status !== 'READY'
      || composition.admissionResult?.status !== 'READY'
      || !composition.admissionResult.bundle) {
      return blocked([
        'P0_C9_ADMISSION_COMPOSER_BLOCKED',
        ...(composition.blockers ?? []),
        ...(composition.admissionResult?.blockers ?? []),
      ], composition.status, observedGates);
    }

    const bundle = composition.admissionResult.bundle;
    if (!validBundleSafety(bundle)) {
      return blocked(['P0_C9_CANONICAL_ADMISSION_BUNDLE_INVALID'], composition.status, observedGates);
    }

    const parityBlockers = riskCostParityBlockers(composition, nowMs, recalculateRisk);
    if (parityBlockers.length > 0) {
      return blocked(parityBlockers, composition.status, withFinalRiskBlock(observedGates, parityBlockers));
    }

    return Object.freeze({
      status: 'READY',
      producerVersion: SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_EVIDENCE_PRODUCER_VERSION,
      bundle,
      blockers: Object.freeze([]),
      composerStatus: composition.status,
      gateObservability: observedGates,
      ...safetyEnvelope(),
    });
  };
}
