import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { ResearchBundleResolution } from './research-bundle.contract';

const STAGES = ['FORWARD', 'SHADOW', 'PAPER', 'SETTLEMENT'] as const;
type Stage = typeof STAGES[number];
type Row = Record<string, unknown>;

export const RESEARCH_SAME_CANDIDATE_PREWIRE_SCHEMA_VERSION = 'research-same-candidate-prewire-v1' as const;
export const RESEARCH_SAME_CANDIDATE_STAGE_SCHEMA_VERSION = 'research-same-candidate-stage-identity-v1' as const;
export const RESEARCH_SAME_CANDIDATE_RUNTIME_PROOF_SCHEMA_VERSION = 'research-same-candidate-runtime-stage-proof-v1' as const;

const HASH_64 = /^[0-9a-f]{64}$/u;
const SHA_40 = /^[0-9a-f]{40}$/u;
const STAGE_KEY = Object.freeze({ FORWARD: 'forward', SHADOW: 'shadow', PAPER: 'paper', SETTLEMENT: 'settlement' } as const);
const DEFAULT_RESEARCH_RUNTIME_STATE_ROOT = '/var/lib/investment-research-production';

function record(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function digest64(value: unknown): value is string { return typeof value === 'string' && HASH_64.test(value); }
function sha40(value: unknown): value is string { return typeof value === 'string' && SHA_40.test(value); }
function nonNegativeInteger(value: unknown): value is number { return Number.isInteger(value) && Number(value) >= 0; }
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
function frozenStrings(values: string[]): readonly string[] { return Object.freeze(unique(values)); }

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

export type ResearchSameCandidateRuntimeStageProof = Readonly<{
  schemaVersion: typeof RESEARCH_SAME_CANDIDATE_RUNTIME_PROOF_SCHEMA_VERSION;
  stage: Stage;
  source: string;
  runtimeStatus: 'PRESENT' | 'MISSING_EVIDENCE' | 'BLOCKED_DATA';
  sampleCount: number | null;
  strategyIdentityDigest: string | null;
  modelIdentityDigest: string | null;
  researchCodeSha: string | null;
  datasetIdentity: string | null;
  blockers: readonly string[];
  synthetic: false;
  replay: false;
  backfill: false;
  duplicate: false;
  manual: false;
  executionAuthority: 'NONE';
  liveTrading: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
}>;

export type ResearchSameCandidateRuntimeStages = Readonly<{
  forward: ResearchSameCandidateRuntimeStageProof;
  shadow: ResearchSameCandidateRuntimeStageProof;
  paper: ResearchSameCandidateRuntimeStageProof;
  settlement: ResearchSameCandidateRuntimeStageProof;
}>;

export type ResearchSameCandidateRuntimeReaderOptions = Readonly<{
  stateRoot?: string;
}>;

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
    identityAnchorSchemaVersion: 'research-same-candidate-identity-anchor-v1',
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

function runtimeProof(
  stage: Stage,
  source: string,
  input: Partial<Omit<ResearchSameCandidateRuntimeStageProof,
    'schemaVersion' | 'stage' | 'source' | 'synthetic' | 'replay' | 'backfill' | 'duplicate' | 'manual' |
    'executionAuthority' | 'liveTrading' | 'privateTradingApiAllowed' | 'orderSubmitted'>> = {},
): ResearchSameCandidateRuntimeStageProof {
  return Object.freeze({
    schemaVersion: RESEARCH_SAME_CANDIDATE_RUNTIME_PROOF_SCHEMA_VERSION,
    stage,
    source,
    runtimeStatus: input.runtimeStatus ?? 'MISSING_EVIDENCE',
    sampleCount: input.sampleCount ?? null,
    strategyIdentityDigest: input.strategyIdentityDigest ?? null,
    modelIdentityDigest: input.modelIdentityDigest ?? null,
    researchCodeSha: input.researchCodeSha ?? null,
    datasetIdentity: input.datasetIdentity ?? null,
    blockers: frozenStrings([...(input.blockers ?? [])]),
    synthetic: false,
    replay: false,
    backfill: false,
    duplicate: false,
    manual: false,
    executionAuthority: 'NONE',
    liveTrading: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
  });
}

function validateRuntimeProof(stage: Stage, value: Row, anchor: Readonly<Row>): SameCandidateStageResult {
  const blockers = Array.isArray(value.blockers) ? value.blockers.filter(text).map(String) : [];
  if (value.stage !== stage) blockers.push(`${stage}_RUNTIME_STAGE_MISMATCH`);
  if (value.executionAuthority !== 'NONE' || value.synthetic !== false || value.replay !== false || value.backfill !== false
    || value.duplicate !== false || value.manual !== false || value.liveTrading !== false
    || value.privateTradingApiAllowed !== false || value.orderSubmitted !== false) blockers.push(`${stage}_RUNTIME_SAFETY_ENVELOPE_INVALID`);

  if (value.runtimeStatus === 'MISSING_EVIDENCE') {
    return Object.freeze({ stage, status: 'MISSING_EVIDENCE', matched: false,
      blockers: frozenStrings(blockers.length ? blockers : [`${stage}_RUNTIME_EVIDENCE_MISSING`]) });
  }
  if (value.runtimeStatus !== 'PRESENT' && value.runtimeStatus !== 'BLOCKED_DATA') blockers.push(`${stage}_RUNTIME_STATUS_INVALID`);

  const anchorStrategy = anchor.strategyIdentityDigest;
  const anchorModel = anchor.modelIdentityDigest;
  const anchorSha = anchor.researchCodeSha;
  const anchorDataset = anchor.datasetIdentity;
  const actualStrategy = value.strategyIdentityDigest;
  const actualModel = value.modelIdentityDigest;
  const actualSha = value.researchCodeSha;
  const actualDataset = value.datasetIdentity;

  if (digest64(actualStrategy) && actualStrategy !== anchorStrategy) blockers.push(`${stage}_IDENTITY_MISMATCH:strategyIdentityDigest`);
  if (digest64(actualModel) && actualModel !== anchorModel) blockers.push(`${stage}_IDENTITY_MISMATCH:modelIdentityDigest`);
  if (sha40(actualSha) && actualSha !== anchorSha) blockers.push(`${stage}_IDENTITY_MISMATCH:researchCodeSha`);
  if (text(actualDataset) && actualDataset !== anchorDataset) blockers.push(`${stage}_IDENTITY_MISMATCH:datasetIdentity`);

  const mismatch = blockers.some(code => code.includes('IDENTITY_MISMATCH'));
  if (mismatch) return Object.freeze({ stage, status: 'IDENTITY_MISMATCH', matched: false, blockers: frozenStrings(blockers) });

  if (!nonNegativeInteger(value.sampleCount) || value.sampleCount === 0) {
    blockers.push(`${stage}_RUNTIME_SAMPLE_NOT_PRESENT`);
    return Object.freeze({ stage, status: 'MISSING_EVIDENCE', matched: false, blockers: frozenStrings(blockers) });
  }

  if (!digest64(actualStrategy)) blockers.push(`${stage}_RUNTIME_STRATEGY_IDENTITY_DIGEST_MISSING`);
  if (!digest64(actualModel)) blockers.push(`${stage}_RUNTIME_MODEL_IDENTITY_DIGEST_MISSING`);
  if (value.runtimeStatus === 'BLOCKED_DATA') blockers.push(`${stage}_RUNTIME_BLOCKED_DATA`);
  if (blockers.length) return Object.freeze({ stage, status: 'BLOCKED_DATA', matched: false, blockers: frozenStrings(blockers) });

  return Object.freeze({ stage, status: 'IDENTITY_MATCHED', matched: true, blockers: Object.freeze([]) });
}

function validateStage(stage: Stage, raw: unknown, anchor: Readonly<Row>, anchorDigest: string): SameCandidateStageResult {
  if (raw == null) return Object.freeze({ stage, status: 'MISSING_EVIDENCE', matched: false, blockers: Object.freeze([`${stage}_EVIDENCE_MISSING`]) });
  const value = record(raw);
  if (!value) return Object.freeze({ stage, status: 'BLOCKED_DATA', matched: false, blockers: Object.freeze([`${stage}_EVIDENCE_INVALID`]) });
  if (value.schemaVersion === RESEARCH_SAME_CANDIDATE_RUNTIME_PROOF_SCHEMA_VERSION) return validateRuntimeProof(stage, value, anchor);

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

async function readJson(path: string): Promise<{ value: Row | null; blocker: string | null }> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return { value: record(parsed), blocker: record(parsed) ? null : 'RUNTIME_JSON_NOT_OBJECT' };
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException)?.code ?? '');
    if (code === 'ENOENT') return { value: null, blocker: 'RUNTIME_FILE_MISSING' };
    if (code === 'EACCES' || code === 'EPERM') return { value: null, blocker: 'RUNTIME_FILE_NOT_READABLE' };
    return { value: null, blocker: 'RUNTIME_JSON_INVALID' };
  }
}

function shadowCanonicalEvidence(root: Row): Row[] {
  const groups = record(root.groups);
  const candidates = groups ? Object.values(groups) : Object.values(root);
  return candidates.map(record).filter((value): value is Row => Boolean(value))
    .map(value => record(value.canonicalEvidence)).filter((value): value is Row => Boolean(value));
}

async function readShadowProof(stateRoot: string, anchor: Readonly<Row>): Promise<ResearchSameCandidateRuntimeStageProof> {
  const path = join(stateRoot, 'forward', 'shadow-state.json');
  const loaded = await readJson(path);
  if (!loaded.value) return runtimeProof('SHADOW', path, {
    runtimeStatus: loaded.blocker === 'RUNTIME_FILE_MISSING' ? 'MISSING_EVIDENCE' : 'BLOCKED_DATA',
    blockers: [loaded.blocker ?? 'SHADOW_RUNTIME_STATE_UNAVAILABLE'],
  });
  const candidates = shadowCanonicalEvidence(loaded.value);
  const identified = candidates.filter(value => digest64(value.strategyIdentityDigest) || digest64(value.modelIdentityDigest));
  if (!identified.length) return runtimeProof('SHADOW', path, {
    runtimeStatus: 'MISSING_EVIDENCE', blockers: ['SHADOW_CANONICAL_RUNTIME_IDENTITY_MISSING'],
  });
  const exact = identified.find(value => value.strategyIdentityDigest === anchor.strategyIdentityDigest
    && value.modelIdentityDigest === anchor.modelIdentityDigest);
  const selected = exact ?? identified[0];
  const observations = Array.isArray(selected.observations) ? selected.observations : [];
  const sampleCount = nonNegativeInteger(selected.currentRunObservationCount)
    ? selected.currentRunObservationCount
    : observations.length;
  return runtimeProof('SHADOW', path, {
    runtimeStatus: 'PRESENT',
    sampleCount,
    strategyIdentityDigest: digest64(selected.strategyIdentityDigest) ? selected.strategyIdentityDigest : null,
    modelIdentityDigest: digest64(selected.modelIdentityDigest) ? selected.modelIdentityDigest : null,
    blockers: selected.runtimeStatus === 'IDENTITY_MISMATCH' ? ['SHADOW_RUNTIME_REPORTED_IDENTITY_MISMATCH'] : [],
  });
}

async function readPaperNaturalResult(stateRoot: string): Promise<{ value: Row | null; blocker: string | null; source: string }> {
  const cyclePath = join(stateRoot, 'latest', 'forward.json');
  const cycle = await readJson(cyclePath);
  if (!cycle.value) return { value: null, blocker: cycle.blocker ?? 'FORWARD_CYCLE_UNAVAILABLE', source: cyclePath };
  const results = Array.isArray(cycle.value.results) ? cycle.value.results.map(record).filter((value): value is Row => Boolean(value)) : [];
  const paper = results.find(value => value.id === 'paper-forward');
  const stdoutPath = paper?.stdoutPath;
  if (!text(stdoutPath) || !isAbsolute(stdoutPath)) return { value: null, blocker: 'PAPER_FORWARD_STDOUT_PATH_UNAVAILABLE', source: cyclePath };
  const resolvedRoot = resolve(stateRoot);
  const runsRoot = `${join(resolvedRoot, 'runs')}${sep}`;
  const resolvedStdout = resolve(stdoutPath);
  if (!resolvedStdout.startsWith(runsRoot) || !resolvedStdout.endsWith(`${sep}paper-forward${sep}stdout.log`)) {
    return { value: null, blocker: 'PAPER_FORWARD_STDOUT_PATH_OUTSIDE_STATE_ROOT', source: cyclePath };
  }
  let raw: string;
  try { raw = await readFile(resolvedStdout, 'utf8'); }
  catch (error) {
    const code = String((error as NodeJS.ErrnoException)?.code ?? '');
    return { value: null, blocker: code === 'ENOENT' ? 'PAPER_FORWARD_STDOUT_MISSING' : 'PAPER_FORWARD_STDOUT_NOT_READABLE', source: resolvedStdout };
  }
  const lines = raw.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed: unknown = JSON.parse(lines[index]);
      const value = record(parsed);
      if (value?.schemaVersion === 'paper-forward-schedule-cli-v5') return { value, blocker: null, source: resolvedStdout };
    } catch { /* read-only scan: ignore non-JSON log lines */ }
  }
  return { value: null, blocker: 'PAPER_FORWARD_CLI_V5_RESULT_UNAVAILABLE', source: resolvedStdout };
}

function paperProof(
  stage: 'FORWARD' | 'PAPER' | 'SETTLEMENT',
  result: Row | null,
  source: string,
  blocker: string | null,
): ResearchSameCandidateRuntimeStageProof {
  if (!result) return runtimeProof(stage, source, {
    runtimeStatus: blocker?.includes('MISSING') || blocker?.includes('UNAVAILABLE') ? 'MISSING_EVIDENCE' : 'BLOCKED_DATA',
    blockers: [blocker ?? `${stage}_RUNTIME_RESULT_UNAVAILABLE`],
  });
  const canonical = record(result.canonicalNaturalStageEvidence);
  const identity = record(canonical?.identity);
  const stageCounts = record(canonical?.stageCounts);
  const field = stage === 'FORWARD' ? 'signalCandidate' : stage === 'PAPER' ? 'entry' : 'settlement';
  const measurement = record(stageCounts?.[field]);
  const measured = measurement?.status === 'MEASURED' && nonNegativeInteger(measurement.count);
  const sampleCount = measured ? Number(measurement?.count) : null;
  const blockers: string[] = [];
  if (!canonical || canonical.schemaVersion !== 'canonical-natural-paper-stage-evidence-v1') blockers.push(`${stage}_CANONICAL_NATURAL_STAGE_EVIDENCE_MISSING`);
  if (!identity) blockers.push(`${stage}_CANONICAL_NATURAL_IDENTITY_MISSING`);
  if (!measured) blockers.push(`${stage}_RUNTIME_STAGE_NOT_MEASURED`);
  return runtimeProof(stage, source, {
    runtimeStatus: canonical && identity ? 'PRESENT' : 'MISSING_EVIDENCE',
    sampleCount,
    strategyIdentityDigest: digest64(identity?.strategyIdentityDigest) ? identity?.strategyIdentityDigest : null,
    modelIdentityDigest: digest64(identity?.modelIdentityDigest) ? identity?.modelIdentityDigest : null,
    researchCodeSha: sha40(identity?.runtimeSha) ? identity?.runtimeSha : (sha40(result.naturalRuntimeSha) ? result.naturalRuntimeSha : null),
    datasetIdentity: text(identity?.datasetIdentity) ? identity?.datasetIdentity : (text(result.naturalDatasetIdentity) ? result.naturalDatasetIdentity : null),
    blockers,
  });
}

export async function readResearchSameCandidateRuntimeStages(
  research: ResearchBundleResolution,
  options: ResearchSameCandidateRuntimeReaderOptions = {},
): Promise<ResearchSameCandidateRuntimeStages> {
  const resolved = resolveAnchor(research);
  const configuredRoot = options.stateRoot ?? process.env.RESEARCH_STATE_ROOT ?? DEFAULT_RESEARCH_RUNTIME_STATE_ROOT;
  if (!isAbsolute(configuredRoot)) {
    const blocker = ['RESEARCH_RUNTIME_STATE_ROOT_INVALID'];
    return Object.freeze({
      forward: runtimeProof('FORWARD', configuredRoot, { runtimeStatus: 'BLOCKED_DATA', blockers: blocker }),
      shadow: runtimeProof('SHADOW', configuredRoot, { runtimeStatus: 'BLOCKED_DATA', blockers: blocker }),
      paper: runtimeProof('PAPER', configuredRoot, { runtimeStatus: 'BLOCKED_DATA', blockers: blocker }),
      settlement: runtimeProof('SETTLEMENT', configuredRoot, { runtimeStatus: 'BLOCKED_DATA', blockers: blocker }),
    });
  }
  const stateRoot = resolve(configuredRoot);
  if (!resolved.anchor) {
    const blocker = resolved.blockers.length ? resolved.blockers : ['RESEARCH_IDENTITY_ANCHOR_UNAVAILABLE'];
    return Object.freeze({
      forward: runtimeProof('FORWARD', stateRoot, { blockers: blocker }),
      shadow: runtimeProof('SHADOW', stateRoot, { blockers: blocker }),
      paper: runtimeProof('PAPER', stateRoot, { blockers: blocker }),
      settlement: runtimeProof('SETTLEMENT', stateRoot, { blockers: blocker }),
    });
  }
  const [shadow, paperNatural] = await Promise.all([
    readShadowProof(stateRoot, resolved.anchor),
    readPaperNaturalResult(stateRoot),
  ]);
  return Object.freeze({
    forward: paperProof('FORWARD', paperNatural.value, paperNatural.source, paperNatural.blocker),
    shadow,
    paper: paperProof('PAPER', paperNatural.value, paperNatural.source, paperNatural.blocker),
    settlement: paperProof('SETTLEMENT', paperNatural.value, paperNatural.source, paperNatural.blocker),
  });
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
