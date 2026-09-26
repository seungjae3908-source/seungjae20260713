import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  FORWARD_OBSERVATION_MINIMUM_SAMPLE_SIZE,
  buildForwardObservationProfitCalibration,
} from './forward-recommendation-observer.service';
import {
  validateForwardObserverRuntimeState,
  type ForwardObserverRuntimeState,
  type ForwardObserverRuntimeSummary,
} from './forward-recommendation-observer-runtime.service';
import {
  manualPaperEvidenceSha256,
  type ManualPaperCanonicalIdentity,
  type ManualPaperCanonicalReceiptVerification,
  type ManualPaperCanonicalValidationReceipt,
} from './manual-paper-canonical-contract.service';
import { PaperTradingError } from './paper-trading-core.service';
import {
  StrategyPromotionService,
  strategyCandidateId,
  type StrategyDirection,
} from './strategy-promotion.service';

export const FORWARD_OBSERVER_VALIDATION_RECEIPT_OWNER_VERSION =
  'forward-observer-validation-receipt-owner-v1' as const;

const SOURCE = 'FORWARD_RECOMMENDATION_OBSERVER' as const;
const PROVENANCE = 'PROSPECTIVE_PUBLIC_FORWARD' as const;
const SHA256 = /^[0-9a-f]{64}$/u;
const SHA40 = /^[0-9a-f]{40}$/u;
const SUPPORTED_MARKETS = Object.freeze([
  'KR_STOCK',
  'US_STOCK',
  'CRYPTO_SPOT',
  'CRYPTO_FUTURES',
] as const);

type SupportedMarket = typeof SUPPORTED_MARKETS[number];

type ExpectedForwardIdentity = Readonly<{
  strategyId: string;
  strategyVersion: string;
  parameterHash: string;
  researchCodeSha: string;
  market: SupportedMarket;
  symbol: string;
  timeframe: string;
  direction: StrategyDirection;
}>;

export type ForwardObserverValidationEvidence = Readonly<{
  source: typeof SOURCE;
  provenance: typeof PROVENANCE;
  observedAtMs: number;
  prospectiveBoundaryMs: number;
  oosBoundaryProven: true;
  sampleSize: number;
  minimumSampleSize: number;
  datasetDigest: string;
  resultArtifactDigest: string;
}>;

export type ForwardObserverValidationEvidenceReader = (
  identity: ManualPaperCanonicalIdentity,
) => Promise<ForwardObserverValidationEvidence>;

export type ForwardObserverValidationReceiptReadback = Readonly<{
  receipt: ManualPaperCanonicalValidationReceipt;
  verification: ManualPaperCanonicalReceiptVerification;
}>;

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireCondition(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new PaperTradingError(code, message, 409);
}

function supportedMarket(value: string): SupportedMarket {
  requireCondition(
    (SUPPORTED_MARKETS as readonly string[]).includes(value),
    'FORWARD_VALIDATION_MARKET_UNSUPPORTED',
    'Forward validation이 지원하는 canonical market identity가 필요합니다.',
  );
  return value as SupportedMarket;
}

function forwardDirection(identity: ManualPaperCanonicalIdentity): StrategyDirection {
  if (identity.market === 'CRYPTO_FUTURES') return identity.side;
  requireCondition(
    identity.side === 'LONG',
    'FORWARD_VALIDATION_CASH_SHORT_UNSUPPORTED',
    'Cash-market Forward validation은 BUY/LONG candidate만 지원합니다.',
  );
  return 'BUY';
}

function expectedForwardIdentity(identity: ManualPaperCanonicalIdentity): ExpectedForwardIdentity {
  const direction = forwardDirection(identity);
  const market = supportedMarket(identity.market);
  const service = new StrategyPromotionService({ sourceSha: identity.researchCodeSha });
  const records = service.list({ market }).items;
  const matches = records.filter((record) => record.identity.strategyId === identity.strategyId
    && record.identity.parameterHash === identity.parameterHash
    && record.identity.researchCodeSha === identity.researchCodeSha
    && record.identity.market === market
    && record.identity.timeframe === identity.timeframe
    && record.identity.direction === direction);
  requireCondition(
    matches.length === 1,
    'FORWARD_VALIDATION_PROMOTION_IDENTITY_REQUIRED',
    '동일한 immutable Promotion identity를 하나로 확정할 수 없습니다.',
  );
  const record = matches[0]!;
  requireCondition(
    strategyCandidateId(record.identity) === identity.candidateId,
    'FORWARD_VALIDATION_CANDIDATE_ID_MISMATCH',
    'Forward validation candidateId가 canonical Promotion identity와 일치하지 않습니다.',
  );
  return Object.freeze({
    strategyId: record.identity.strategyId,
    strategyVersion: record.identity.strategyVersion,
    parameterHash: record.identity.parameterHash,
    researchCodeSha: record.identity.researchCodeSha,
    market,
    symbol: identity.symbol,
    timeframe: record.identity.timeframe,
    direction,
  });
}

type ObserverManifest = Readonly<{
  schemaVersion?: unknown;
  kind?: unknown;
  researchCodeSha?: unknown;
  stateSha256?: unknown;
  summarySha256?: unknown;
  safety?: Readonly<Record<string, unknown>>;
}>;

function validateManifest(
  manifest: ObserverManifest,
  researchCodeSha: string,
  stateText: string,
  summaryText: string,
): void {
  requireCondition(
    manifest.schemaVersion === 1
      && manifest.kind === 'forward-recommendation-observer-state'
      && manifest.researchCodeSha === researchCodeSha
      && manifest.stateSha256 === sha256Text(stateText)
      && manifest.summarySha256 === sha256Text(summaryText),
    'FORWARD_VALIDATION_ARTIFACT_MANIFEST_INVALID',
    'Forward observer immutable artifact manifest/digest가 일치하지 않습니다.',
  );
  const safety = manifest.safety ?? {};
  requireCondition(
    safety.publicDataOnly === true
      && safety.artifactOnly === true
      && safety.executionAuthority === 'NONE'
      && safety.financialMutationAllowed === false
      && safety.liveOrderAllowed === false
      && safety.privateTradingApiAllowed === false
      && safety.profitabilityClaimAllowed === false,
    'FORWARD_VALIDATION_ARTIFACT_SAFETY_INVALID',
    'Forward observer artifact safety contract가 유효하지 않습니다.',
  );
}

export function createForwardObserverArtifactValidationEvidenceReader(input: Readonly<{
  artifactRoot: string;
}>): ForwardObserverValidationEvidenceReader {
  const root = path.resolve(input.artifactRoot);
  requireCondition(nonEmpty(root), 'FORWARD_VALIDATION_ARTIFACT_ROOT_REQUIRED', 'Forward validation artifact root가 필요합니다.');

  return async (manualIdentity) => {
    requireCondition(SHA40.test(manualIdentity.researchCodeSha), 'FORWARD_VALIDATION_RESEARCH_SHA_REQUIRED', '정확한 immutable research SHA가 필요합니다.');
    const expected = expectedForwardIdentity(manualIdentity);
    let stateText: string;
    let summaryText: string;
    let manifestText: string;
    try {
      [stateText, summaryText, manifestText] = await Promise.all([
        readFile(path.join(root, 'state.json'), 'utf8'),
        readFile(path.join(root, 'summary.json'), 'utf8'),
        readFile(path.join(root, 'manifest.json'), 'utf8'),
      ]);
    } catch {
      throw new PaperTradingError(
        'FORWARD_VALIDATION_ARTIFACT_READBACK_UNAVAILABLE',
        '검증된 Forward observer artifact를 읽을 수 없습니다.',
        503,
      );
    }

    let state: ForwardObserverRuntimeState;
    let summary: ForwardObserverRuntimeSummary;
    let manifest: ObserverManifest;
    try {
      state = JSON.parse(stateText) as ForwardObserverRuntimeState;
      summary = JSON.parse(summaryText) as ForwardObserverRuntimeSummary;
      manifest = JSON.parse(manifestText) as ObserverManifest;
      validateManifest(manifest, manualIdentity.researchCodeSha, stateText, summaryText);
      validateForwardObserverRuntimeState(state, manualIdentity.researchCodeSha);
    } catch (error) {
      if (error instanceof PaperTradingError) throw error;
      throw new PaperTradingError(
        'FORWARD_VALIDATION_ARTIFACT_INVALID',
        'Forward observer artifact 검증에 실패했습니다.',
        409,
      );
    }

    const prospectiveBoundaryMs = Date.parse(state.createdAt);
    requireCondition(
      Number.isSafeInteger(prospectiveBoundaryMs) && prospectiveBoundaryMs >= 0,
      'FORWARD_VALIDATION_PROSPECTIVE_BOUNDARY_REQUIRED',
      'Forward observer immutable state 생성 경계를 OOS boundary로 검증할 수 없습니다.',
    );
    requireCondition(
      summary.schemaVersion === 1
        && summary.researchCodeSha === manualIdentity.researchCodeSha
        && summary.counts?.total === state.observations.length
        && summary.counts?.settled === state.observations.filter((row) => row.status === 'SETTLED').length
        && summary.safety?.executionAuthority === 'NONE'
        && summary.safety?.profitabilityClaimAllowed === false,
      'FORWARD_VALIDATION_SUMMARY_INVALID',
      'Forward observer summary identity/safety/counts가 state와 일치하지 않습니다.',
    );

    const rows = state.observations.filter((row) => {
      if (row.status !== 'SETTLED'
        || row.identity.strategyId !== expected.strategyId
        || row.identity.strategyVersion !== expected.strategyVersion
        || row.identity.parameterHash !== expected.parameterHash
        || row.identity.researchCodeSha !== expected.researchCodeSha
        || row.identity.market !== expected.market
        || row.identity.symbol !== expected.symbol
        || row.identity.timeframe !== expected.timeframe
        || row.identity.direction !== expected.direction) return false;
      const signalAtMs = Date.parse(row.snapshot.timestamp);
      const dataAtMs = Date.parse(row.dataTimestamp);
      const settledAtMs = Date.parse(row.settledAt ?? '');
      return Number.isFinite(signalAtMs)
        && Number.isFinite(dataAtMs)
        && Number.isFinite(settledAtMs)
        && signalAtMs > prospectiveBoundaryMs
        && dataAtMs <= signalAtMs
        && settledAtMs >= signalAtMs;
    });
    const calibration = buildForwardObservationProfitCalibration(rows);
    requireCondition(
      calibration.status === 'READY'
        && calibration.calibration.status === 'READY'
        && calibration.calibration.sampleSize >= FORWARD_OBSERVATION_MINIMUM_SAMPLE_SIZE,
      'FORWARD_VALIDATION_GENUINE_SAMPLE_INSUFFICIENT',
      'immutable observer boundary 이후 동일 candidate의 genuine prospective OOS 표본이 아직 충분하지 않습니다.',
    );

    const settledTimes = rows.map((row) => Date.parse(row.settledAt ?? '')).filter(Number.isFinite);
    requireCondition(
      settledTimes.length === rows.length && settledTimes.length > 0,
      'FORWARD_VALIDATION_SETTLED_TIME_REQUIRED',
      'Forward validation settled timestamp가 완전하지 않습니다.',
    );
    const observedAtMs = Math.max(...settledTimes);
    const datasetDigest = manualPaperEvidenceSha256(rows);
    const resultArtifactDigest = manualPaperEvidenceSha256({
      immutableResearchSha: manualIdentity.researchCodeSha,
      prospectiveBoundaryMs,
      manifest: {
        researchCodeSha: manifest.researchCodeSha,
        stateSha256: manifest.stateSha256,
        summarySha256: manifest.summarySha256,
      },
      calibration,
    });
    requireCondition(
      SHA256.test(datasetDigest) && SHA256.test(resultArtifactDigest),
      'FORWARD_VALIDATION_ARTIFACT_DIGEST_INVALID',
      'Forward validation artifact digest를 확정할 수 없습니다.',
    );
    return Object.freeze({
      source: SOURCE,
      provenance: PROVENANCE,
      observedAtMs,
      prospectiveBoundaryMs,
      oosBoundaryProven: true as const,
      sampleSize: calibration.calibration.sampleSize,
      minimumSampleSize: FORWARD_OBSERVATION_MINIMUM_SAMPLE_SIZE,
      datasetDigest,
      resultArtifactDigest,
    });
  };
}

function receiptFileName(identity: ManualPaperCanonicalIdentity): string {
  return `${sha256Text(manualPaperEvidenceSha256(identity))}.json`;
}

export function createForwardObserverValidationReceiptOwner(input: Readonly<{
  receiptRoot: string;
  maximumAgeMs: number;
  readValidationEvidence: ForwardObserverValidationEvidenceReader;
}>): (identity: ManualPaperCanonicalIdentity, nowMs: number) => Promise<ForwardObserverValidationReceiptReadback> {
  const root = path.resolve(input.receiptRoot);
  requireCondition(Number.isSafeInteger(input.maximumAgeMs) && input.maximumAgeMs > 0,
    'FORWARD_VALIDATION_MAX_AGE_REQUIRED', 'Forward validation receipt maximumAgeMs가 필요합니다.');
  requireCondition(typeof input.readValidationEvidence === 'function',
    'FORWARD_VALIDATION_EVIDENCE_READER_REQUIRED', 'Forward validation evidence reader가 필요합니다.');

  return async (identity, nowMs) => {
    requireCondition(Number.isSafeInteger(nowMs) && nowMs > 0,
      'FORWARD_VALIDATION_CLOCK_INVALID', 'Forward validation readback 시각이 유효하지 않습니다.');
    const evidence = await input.readValidationEvidence(identity);
    requireCondition(evidence.source === SOURCE && evidence.provenance === PROVENANCE
      && evidence.oosBoundaryProven === true
      && Number.isSafeInteger(evidence.prospectiveBoundaryMs)
      && evidence.prospectiveBoundaryMs >= 0
      && evidence.observedAtMs > evidence.prospectiveBoundaryMs
      && evidence.sampleSize >= evidence.minimumSampleSize
      && evidence.minimumSampleSize === FORWARD_OBSERVATION_MINIMUM_SAMPLE_SIZE
      && SHA256.test(evidence.datasetDigest)
      && SHA256.test(evidence.resultArtifactDigest)
      && Number.isSafeInteger(evidence.observedAtMs)
      && evidence.observedAtMs <= nowMs,
    'FORWARD_VALIDATION_GENUINE_EVIDENCE_INVALID', 'Forward validation genuine OOS evidence가 유효하지 않습니다.');
    requireCondition(nowMs - evidence.observedAtMs <= input.maximumAgeMs,
      'FORWARD_VALIDATION_EVIDENCE_STALE', 'Forward validation evidence가 허용된 freshness를 초과했습니다.');

    const receiptId = `forward-validation-v1:${manualPaperEvidenceSha256({
      identity,
      prospectiveBoundaryMs: evidence.prospectiveBoundaryMs,
      datasetDigest: evidence.datasetDigest,
      resultArtifactDigest: evidence.resultArtifactDigest,
    })}`;
    const receipt: ManualPaperCanonicalValidationReceipt = Object.freeze({
      identity: structuredClone(identity),
      receiptId,
      receiptVersion: 'manual-paper-forward-validation-receipt-v1',
      source: evidence.source,
      provenance: evidence.provenance,
      status: 'VALIDATED',
      observedAtMs: evidence.observedAtMs,
      maximumAgeMs: input.maximumAgeMs,
      synthetic: false,
      replay: false,
      backfill: false,
      historical: false,
      testOnly: false,
      datasetDigest: evidence.datasetDigest,
      resultArtifactDigest: evidence.resultArtifactDigest,
      prospectiveBoundaryMs: evidence.prospectiveBoundaryMs,
      oosBoundaryProven: true,
      sampleSize: evidence.sampleSize,
      minimumSampleSize: evidence.minimumSampleSize,
    });

    await mkdir(root, { recursive: true });
    const target = path.join(root, receiptFileName(identity));
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);

    let readback: ManualPaperCanonicalValidationReceipt;
    try {
      readback = JSON.parse(await readFile(target, 'utf8')) as ManualPaperCanonicalValidationReceipt;
    } catch {
      throw new PaperTradingError(
        'FORWARD_VALIDATION_RECEIPT_READBACK_UNAVAILABLE',
        '발행된 Forward validation receipt readback을 확인할 수 없습니다.',
        503,
      );
    }
    const issuedDigest = manualPaperEvidenceSha256(receipt);
    const readbackDigest = manualPaperEvidenceSha256(readback);
    requireCondition(
      issuedDigest === readbackDigest && readback.receiptId === receiptId,
      'FORWARD_VALIDATION_RECEIPT_READBACK_MISMATCH',
      '발행된 Forward validation receipt가 durable readback과 일치하지 않습니다.',
    );
    const verification: ManualPaperCanonicalReceiptVerification = Object.freeze({
      ownerId: FORWARD_OBSERVER_VALIDATION_RECEIPT_OWNER_VERSION,
      source: SOURCE,
      provenance: PROVENANCE,
      verifiedAtMs: nowMs,
      readbackVerified: true,
      validationPassed: true,
      receiptSha256: readbackDigest,
    });
    return Object.freeze({ receipt: structuredClone(readback), verification });
  };
}
