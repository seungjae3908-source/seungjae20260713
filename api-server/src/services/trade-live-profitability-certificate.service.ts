import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateUnifiedProfitabilityPromotion } from '../../../market-prediction-lab/src/unified-profitability-promotion-gate-v1.js';
import type { StrategyPromotionRecord } from './strategy-promotion.service';

export const LIVE_PROFITABILITY_CERTIFICATE_SCHEMA =
  'live-profitability-promotion-certificate-v1' as const;

const SHA40 = /^[0-9a-f]{40}$/iu;
const HASH64 = /^[0-9a-f]{64}$/iu;
const MAX_CERTIFICATE_BYTES = 4 * 1024 * 1024;

type AnyRecord = Record<string, any>;

export type LiveProfitabilityPromotionReader = Readonly<{
  get(strategyId: string): StrategyPromotionRecord | null;
}>;

export type LiveProfitabilityPromotionCertificate = Readonly<{
  schemaVersion: typeof LIVE_PROFITABILITY_CERTIFICATE_SCHEMA;
  status: 'PROMOTION_REVIEW_READY';
  targetSha: string;
  strategyFingerprint: string;
  strategyId: string;
  parameterHash: string;
  costPolicyVersion: string;
  createdAt: string;
  record: StrategyPromotionRecord;
  gateInput: Readonly<{
    strategyFingerprint: string;
    policy: AnyRecord;
    backtest: AnyRecord;
    selectionBias: AnyRecord;
    shadow: AnyRecord;
    paper: AnyRecord;
  }>;
  gateVerdict: AnyRecord;
  safety: Readonly<{
    certificateOnly: true;
    orderAuthorityGranted: false;
    liveTradingActivated: false;
    automaticTradingActivated: false;
    privateTradingApiActivated: false;
    realOrderSubmitted: false;
  }>;
  certificateDigest: string;
}>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as AnyRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function exactSha(value: unknown, code: string): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!SHA40.test(normalized)) throw new Error(code);
  return normalized;
}

function exactHash(value: unknown, code: string): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!HASH64.test(normalized)) throw new Error(code);
  return normalized;
}

function exactIso(value: unknown, code: string): string {
  const normalized = String(value ?? '').trim();
  const parsed = Date.parse(normalized);
  if (!normalized || !Number.isFinite(parsed)) throw new Error(code);
  return normalized;
}

function recordIdentityFingerprint(record: StrategyPromotionRecord): string {
  return digest({
    strategyFamily: record.identity.strategyFamily,
    strategyId: record.identity.strategyId,
    strategyVersion: record.identity.strategyVersion,
    parameterHash: record.identity.parameterHash,
    market: record.identity.market,
    assetClass: record.identity.assetClass,
    symbol: record.identity.symbol,
    universe: record.identity.universe,
    timeframe: record.identity.timeframe,
    direction: record.identity.direction,
    researchCodeSha: record.identity.researchCodeSha.toLowerCase(),
    costPolicyVersion: record.identity.costPolicyVersion,
    riskPolicyVersion: record.identity.riskPolicyVersion,
  });
}

function assertPromotionRecord(record: StrategyPromotionRecord, targetSha: string): void {
  if (!record
    || record.promotionEligible !== true
    || record.promotionState !== 'PROMOTION_CANDIDATE'
    || record.executionAuthority !== 'NONE'
    || record.liveTradingAuthority !== false
    || record.privateTradingApiCount !== 0) {
    throw new Error('LIVE_PROFITABILITY_PROMOTION_RECORD_NOT_READY');
  }
  if (exactSha(record.identity.researchCodeSha, 'LIVE_PROFITABILITY_RESEARCH_SHA_INVALID') !== targetSha) {
    throw new Error('LIVE_PROFITABILITY_RESEARCH_SHA_MISMATCH');
  }
  exactHash(record.identity.parameterHash, 'LIVE_PROFITABILITY_PARAMETER_HASH_INVALID');
  if (!String(record.identity.costPolicyVersion ?? '').trim()) {
    throw new Error('LIVE_PROFITABILITY_COST_POLICY_VERSION_REQUIRED');
  }
}

function withFingerprint(value: unknown, strategyFingerprint: string, label: string): AnyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`LIVE_PROFITABILITY_${label}_EVIDENCE_REQUIRED`);
  }
  return Object.freeze({
    ...(structuredClone(value) as AnyRecord),
    strategyFingerprint,
  });
}

function certificateCore(input: Readonly<{
  targetSha: string;
  record: StrategyPromotionRecord;
  policy: AnyRecord;
  backtest: AnyRecord;
  selectionBias: AnyRecord;
  shadow: AnyRecord;
  paper: AnyRecord;
  createdAt: string;
}>) {
  const targetSha = exactSha(input.targetSha, 'LIVE_PROFITABILITY_TARGET_SHA_INVALID');
  assertPromotionRecord(input.record, targetSha);
  const strategyFingerprint = recordIdentityFingerprint(input.record);
  const gateInput = Object.freeze({
    strategyFingerprint,
    policy: structuredClone(input.policy),
    backtest: withFingerprint(input.backtest, strategyFingerprint, 'BACKTEST'),
    selectionBias: withFingerprint(input.selectionBias, strategyFingerprint, 'SELECTION_BIAS'),
    shadow: withFingerprint(input.shadow, strategyFingerprint, 'SHADOW'),
    paper: withFingerprint(input.paper, strategyFingerprint, 'PAPER'),
  });
  const gateVerdict = evaluateUnifiedProfitabilityPromotion(gateInput);
  if (gateVerdict?.promotionEligible !== true
    || gateVerdict?.status !== 'PROMOTION_REVIEW_READY'
    || gateVerdict?.safety?.liveTradingAllowed !== false
    || gateVerdict?.safety?.privateTradingApiAllowed !== false
    || gateVerdict?.safety?.orderAuthority !== false) {
    throw new Error(
      `LIVE_PROFITABILITY_UNIFIED_GATE_BLOCKED:${(gateVerdict?.reasons ?? []).join(',') || 'UNKNOWN'}`,
    );
  }
  const createdAt = exactIso(input.createdAt, 'LIVE_PROFITABILITY_CREATED_AT_INVALID');
  return Object.freeze({
    schemaVersion: LIVE_PROFITABILITY_CERTIFICATE_SCHEMA,
    status: 'PROMOTION_REVIEW_READY' as const,
    targetSha,
    strategyFingerprint,
    strategyId: input.record.identity.strategyId,
    parameterHash: input.record.identity.parameterHash.toLowerCase(),
    costPolicyVersion: input.record.identity.costPolicyVersion,
    createdAt,
    record: structuredClone(input.record),
    gateInput,
    gateVerdict: structuredClone(gateVerdict),
    safety: Object.freeze({
      certificateOnly: true as const,
      orderAuthorityGranted: false as const,
      liveTradingActivated: false as const,
      automaticTradingActivated: false as const,
      privateTradingApiActivated: false as const,
      realOrderSubmitted: false as const,
    }),
  });
}

export function buildLiveProfitabilityPromotionCertificate(input: Readonly<{
  targetSha: string;
  record: StrategyPromotionRecord;
  policy: AnyRecord;
  backtest: AnyRecord;
  selectionBias: AnyRecord;
  shadow: AnyRecord;
  paper: AnyRecord;
  createdAt?: string;
}>): LiveProfitabilityPromotionCertificate {
  const core = certificateCore({
    ...input,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  return Object.freeze({
    ...core,
    certificateDigest: digest(core),
  });
}

export function verifyLiveProfitabilityPromotionCertificate(
  value: unknown,
  expectedTargetSha: string,
): LiveProfitabilityPromotionCertificate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('LIVE_PROFITABILITY_CERTIFICATE_REQUIRED');
  }
  const certificate = value as LiveProfitabilityPromotionCertificate;
  const targetSha = exactSha(expectedTargetSha, 'LIVE_PROFITABILITY_EXPECTED_TARGET_SHA_INVALID');
  if (certificate.schemaVersion !== LIVE_PROFITABILITY_CERTIFICATE_SCHEMA
    || certificate.status !== 'PROMOTION_REVIEW_READY'
    || certificate.targetSha !== targetSha
    || certificate.strategyId !== certificate.record?.identity?.strategyId
    || certificate.parameterHash !== String(certificate.record?.identity?.parameterHash ?? '').toLowerCase()
    || certificate.costPolicyVersion !== certificate.record?.identity?.costPolicyVersion
    || certificate.strategyFingerprint !== recordIdentityFingerprint(certificate.record)
    || certificate.gateInput?.strategyFingerprint !== certificate.strategyFingerprint) {
    throw new Error('LIVE_PROFITABILITY_CERTIFICATE_IDENTITY_INVALID');
  }
  exactIso(certificate.createdAt, 'LIVE_PROFITABILITY_CREATED_AT_INVALID');
  assertPromotionRecord(certificate.record, targetSha);
  const { certificateDigest, ...core } = certificate as any;
  if (exactHash(certificateDigest, 'LIVE_PROFITABILITY_CERTIFICATE_DIGEST_INVALID') !== digest(core)) {
    throw new Error('LIVE_PROFITABILITY_CERTIFICATE_DIGEST_MISMATCH');
  }

  const recomputed = evaluateUnifiedProfitabilityPromotion(certificate.gateInput);
  if (recomputed?.promotionEligible !== true
    || recomputed?.status !== 'PROMOTION_REVIEW_READY'
    || digest(recomputed) !== digest(certificate.gateVerdict)
    || recomputed?.safety?.liveTradingAllowed !== false
    || recomputed?.safety?.privateTradingApiAllowed !== false
    || recomputed?.safety?.orderAuthority !== false
    || certificate.safety?.certificateOnly !== true
    || certificate.safety?.orderAuthorityGranted !== false
    || certificate.safety?.liveTradingActivated !== false
    || certificate.safety?.automaticTradingActivated !== false
    || certificate.safety?.privateTradingApiActivated !== false
    || certificate.safety?.realOrderSubmitted !== false) {
    throw new Error('LIVE_PROFITABILITY_CERTIFICATE_GATE_INVALID');
  }
  return Object.freeze(structuredClone(certificate));
}

function readCertificateFile(filePath: string): unknown {
  const resolved = path.resolve(filePath);
  if (!path.isAbsolute(resolved) || resolved === path.parse(resolved).root) {
    throw new Error('LIVE_PROFITABILITY_CERTIFICATE_PATH_INVALID');
  }
  const metadata = lstatSync(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('LIVE_PROFITABILITY_CERTIFICATE_FILE_INVALID');
  }
  if (metadata.size <= 0 || metadata.size > MAX_CERTIFICATE_BYTES) {
    throw new Error('LIVE_PROFITABILITY_CERTIFICATE_SIZE_INVALID');
  }
  return JSON.parse(readFileSync(resolved, 'utf8'));
}

export function createLiveProfitabilityPromotionReader(input: Readonly<{
  certificatePath: string;
  targetSha: string;
}>): LiveProfitabilityPromotionReader {
  const targetSha = exactSha(input.targetSha, 'LIVE_PROFITABILITY_READER_TARGET_SHA_INVALID');
  const filePath = String(input.certificatePath ?? '').trim();
  if (!filePath) throw new Error('LIVE_PROFITABILITY_CERTIFICATE_PATH_REQUIRED');
  return Object.freeze({
    get(strategyId: string): StrategyPromotionRecord | null {
      const certificate = verifyLiveProfitabilityPromotionCertificate(
        readCertificateFile(filePath),
        targetSha,
      );
      return certificate.strategyId === strategyId
        ? structuredClone(certificate.record)
        : null;
    },
  });
}
