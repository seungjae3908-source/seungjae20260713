import { createHash } from 'node:crypto';
import type { ResearchBundleResolution } from './research-bundle.contract';

const STAGES = ['FORWARD', 'SHADOW', 'PAPER', 'SETTLEMENT'] as const;
type Stage = typeof STAGES[number];
type Row = Record<string, unknown>;

export const RESEARCH_SAME_CANDIDATE_PREWIRE_SCHEMA_VERSION = 'research-same-candidate-prewire-v1' as const;
export const RESEARCH_SAME_CANDIDATE_STAGE_SCHEMA_VERSION = 'research-same-candidate-stage-identity-v1' as const;

const HASH_64 = /^[0-9a-f]{64}$/u;
const SHA_40 = /^[0-9a-f]{40}$/u;
const STAGE_KEY = Object.freeze({ FORWARD: 'forward', SHADOW: 'shadow', PAPER: 'paper', SETTLEMENT: 'settlement' } as const);

function record(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function digest64(value: unknown): value is string { return typeof value === 'string' && HASH_64.test(value); }
function sha40(value: unknown): value is string { return typeof value === 'string' && SHA_40.test(value); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const source = value as Row;
    return `{${Object.keys(source).sort().map(key => `${JSON.stringify(key)}:${stable(source[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
function hash(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
function unique(values: string[]): string[] { return [...new Set(values)]; }

export type SameCandidateStageStatus = 'MISSING_EVIDENCE' | 'IDENTITY_MATCHED' | 'IDENTITY_MISMATCH' | 'BLOCKED_DATA';
export interface SameCandidateStageResult {
  stage: Stage;
  status: SameCandidateStageStatus;
  matched: boolean;
  blockers: readonly string[];
}
export interface ResearchSameCandidatePrewireResult {
  schemaVersion: typeof RESEARCH_SAME_CANDIDATE_PREWIRE_SCHEMA_VERSION;
  status: 'BLOCKED_DATA' | 'IDENTITY_MISMATCH' | 'PREWIRED_WAITING_EVIDENCE' | 'PREWIRED_IDENTITY_MATCHED';
  identityAnchor: Readonly<Row> | null;
  identityAnchorDigest: string | null;
  stages: Readonly<Record<Stage, SameCandidateStageResult>>;
  allIdentityStagesMatched: boolean;
  evidenceCredit: 0;
  profitabilityProven: false;
  champion: null;
  executionAuthority: 'NONE';
  liveTrading: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  productionMutationAllowed: false;
  blockers: readonly string[];
}

function safeResult(input: Omit<ResearchSameCandidatePrewireResult,
  'schemaVersion' | 'evidenceCredit' | 'profitabilityProven' | 'champion' | 'executionAuthority' |
  'liveTrading' | 'privateTradingApiAllowed' | 'orderSubmitted' | 'productionMutationAllowed'>): ResearchSameCandidatePrewireResult {
  return Object.freeze({
    schemaVersion: RESEARCH_SAME_CANDIDATE_PREWIRE_SCHEMA_VERSION,
    ...input,
    evidenceCredit: 0,
    profitabilityProven: false,
    champion: null,
    executionAuthority: 'NONE',
    liveTrading: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    productionMutationAllowed: false,
  });
}

function missingStages(blocker = 'RESEARCH_IDENTITY_ANCHOR_UNAVAILABLE'): Readonly<Record<Stage, SameCandidateStageResult>> {
  return Object.freeze(Object.fromEntries(STAGES.map(stage => [stage, Object.freeze({
    stage, status: 'MISSING_EVIDENCE' as const, matched: false, blockers: Object.freeze([blocker]),
  })])) as Record<Stage, SameCandidateStageResult>);
}

function resolveAnchor(research: ResearchBundleResolution): { anchor: Readonly<Row> | null; digest: string | null; blockers: string[] } {
  const blockers: string[] = [];
  const receipt = research.receipt;
  if (research.publicationStatus !== 'READBACK_VERIFIED' || research.backtestCompleted !== true || !receipt) {
    blockers.push('RESEARCH_DURABLE_READBACK_REQUIRED');
  }
  if (research.executionAuthority !== 'NONE' || research.evidenceCredit !== 0 || research.promotionEligible !== false
    || research.profitabilityProven !== false || research.champion !== null) blockers.push('RESEARCH_AUTHORITY_ENVELOPE_INVALID');
  if (!digest64(research.bundleDigest) || !digest64(research.strategyIdentityDigest) || !digest64(research.modelIdentityDigest)
    || !digest64(research.featureOrderDigest) || !digest64(research.resultArtifactDigest)) blockers.push('RESEARCH_IDENTITY_DIGEST_MISSING');
  if (!receipt) return { anchor: null, digest: null, blockers: unique(blockers) };
  if (!digest64(receipt.bundleDigest) || receipt.bundleDigest !== research.bundleDigest
    || !digest64(receipt.strategyIdentityDigest) || receipt.strategyIdentityDigest !== research.strategyIdentityDigest
    || !digest64(receipt.modelIdentityDigest) || receipt.modelIdentityDigest !== research.modelIdentityDigest
    || !digest64(receipt.featureOrderDigest) || receipt.featureOrderDigest !== research.featureOrderDigest
    || !digest64(receipt.datasetDigest) || !text(receipt.datasetIdentity) || !text(receipt.preprocessingVersion)
    || !text(receipt.riskPolicyId) || !text(receipt.riskPolicyVersion) || !text(receipt.costPolicyIdentity)
    || !sha40(receipt.researchCodeSha)) blockers.push('RESEARCH_RECEIPT_IDENTITY_INVALID');
  if (blockers.length) return { anchor: null, digest: null, blockers: unique(blockers) };
  const anchor = Object.freeze({
    schemaVersion: 'research-same-candidate-identity-anchor-v1',
    researchBundleDigest: receipt.bundleDigest,
    resultArtifactDigest: research.resultArtifactDigest,
    strategyIdentityDigest: receipt.strategyIdentityDigest,
    datasetIdentity: receipt.datasetIdentity,
    datasetDigest: receipt.datasetDigest,
    modelIdentityDigest: receipt.modelIdentityDigest,
    featureOrderDigest: receipt.featureOrderDigest,
    preprocessingVersion: receipt.preprocessingVersion,
    riskPolicyId: receipt.riskPolicyId,
    riskPolicyVersion: receipt.riskPolicyVersion,
    costPolicyIdentity: receipt.costPolicyIdentity,
    researchCodeSha: receipt.researchCodeSha,
  });
  return { anchor, digest: hash(anchor), blockers: [] };
}

function validateStage(stage: Stage, raw: unknown, anchor: Readonly<Row>, anchorDigest: string): SameCandidateStageResult {
  if (raw == null) return Object.freeze({ stage, status: 'MISSING_EVIDENCE', matched: false, blockers: Object.freeze([`${stage}_EVIDENCE_MISSING`]) });
  const value = record(raw);
  if (!value) return Object.freeze({ stage, status: 'BLOCKED_DATA', matched: false, blockers: Object.freeze([`${stage}_EVIDENCE_INVALID`]) });
  const blockers: string[] = [];
  if (value.schemaVersion !== RESEARCH_SAME_CANDIDATE_STAGE_SCHEMA_VERSION || value.stage !== stage) blockers.push(`${stage}_STAGE_SCHEMA_MISMATCH`);
  if (value.identityAnchorDigest !== anchorDigest) blockers.push(`${stage}_IDENTITY_ANCHOR_DIGEST_MISMATCH`);
  for (const [key, expected] of Object.entries(anchor)) {
    if (value[key] !== expected) blockers.push(`${stage}_IDENTITY_MISMATCH:${key}`);
  }
  if (value.executionAuthority !== 'NONE' || value.evidenceCredit !== 0
    || value.synthetic !== false || value.replay !== false || value.backfill !== false
    || value.duplicate !== false || value.manual !== false || value.liveTrading !== false
    || value.privateTradingApiAllowed !== false || value.orderSubmitted !== false) blockers.push(`${stage}_PREWIRE_AUTHORITY_OR_PROVENANCE_INVALID`);
  if (blockers.length) {
    const mismatch = blockers.some(code => code.includes('IDENTITY') || code.includes('SCHEMA'));
    return Object.freeze({ stage, status: mismatch ? 'IDENTITY_MISMATCH' : 'BLOCKED_DATA', matched: false, blockers: Object.freeze(unique(blockers)) });
  }
  return Object.freeze({ stage, status: 'IDENTITY_MATCHED', matched: true, blockers: Object.freeze([]) });
}

export function validateResearchSameCandidatePrewire(
  research: ResearchBundleResolution,
  rawStages: unknown,
): ResearchSameCandidatePrewireResult {
  const resolved = resolveAnchor(research);
  if (!resolved.anchor || !resolved.digest) return safeResult({
    status: 'BLOCKED_DATA', identityAnchor: null, identityAnchorDigest: null, stages: missingStages(),
    allIdentityStagesMatched: false, blockers: Object.freeze(resolved.blockers),
  });
  const stagesInput = record(rawStages) ?? {};
  const allowedKeys = new Set(Object.values(STAGE_KEY));
  const unsupportedKeys = Object.keys(stagesInput).filter(key => !allowedKeys.has(key as typeof STAGE_KEY[Stage]));
  if (unsupportedKeys.length) return safeResult({
    status: 'BLOCKED_DATA', identityAnchor: resolved.anchor, identityAnchorDigest: resolved.digest, stages: missingStages('UNSUPPORTED_STAGE_KEY'),
    allIdentityStagesMatched: false, blockers: Object.freeze(unsupportedKeys.map(key => `UNSUPPORTED_STAGE_KEY:${key}`)),
  });
  const stageResults = Object.freeze(Object.fromEntries(STAGES.map(stage => [
    stage, validateStage(stage, stagesInput[STAGE_KEY[stage]], resolved.anchor!, resolved.digest!),
  ])) as Record<Stage, SameCandidateStageResult>);
  const results = STAGES.map(stage => stageResults[stage]);
  const blockers = unique(results.flatMap(result => [...result.blockers]));
  const allMatched = results.every(result => result.matched);
  const hasBlocked = results.some(result => result.status === 'BLOCKED_DATA');
  const hasMismatch = results.some(result => result.status === 'IDENTITY_MISMATCH');
  const status = hasBlocked ? 'BLOCKED_DATA'
    : hasMismatch ? 'IDENTITY_MISMATCH'
      : allMatched ? 'PREWIRED_IDENTITY_MATCHED'
        : 'PREWIRED_WAITING_EVIDENCE';
  return safeResult({
    status, identityAnchor: resolved.anchor, identityAnchorDigest: resolved.digest, stages: stageResults,
    allIdentityStagesMatched: allMatched, blockers: Object.freeze(blockers),
  });
}
