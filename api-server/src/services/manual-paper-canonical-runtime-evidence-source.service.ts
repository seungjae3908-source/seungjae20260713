import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { restoreRecurringPaperLoopState } from '../../../market-prediction-lab/src/recurring-paper-loop-v1.js';
import {
  createForwardObserverArtifactValidationEvidenceReader,
  createForwardObserverValidationReceiptOwner,
} from './forward-observer-validation-receipt-owner.service';
import {
  createManualPaperCanonicalEvidenceSource,
  type ManualPaperCanonicalEvidenceSource,
  type ManualPaperCanonicalIdentity,
  type ManualPaperCanonicalOwnerEvidencePacket,
} from './manual-paper-canonical-evidence-source.service';
import { PaperTradingError } from './paper-trading-core.service';
import { readAuthenticatedPaperTradingState } from './paper-trading-state-publisher.service';
import type { PaperTradingAction, PaperTradingState } from './paper-trading.types';

export const MANUAL_PAPER_CANONICAL_RUNTIME_BRIDGE_VERSION =
  'manual-paper-canonical-runtime-evidence-bridge-v1' as const;

const DEFAULT_PAPER_FORWARD_ROOT = '/opt/stock-app-data/paper-forward-v1/runtime-state';
const ENTRY_COMPONENTS = Object.freeze([
  'commission',
  'tax',
  'spread',
  'slippage',
  'funding',
  'latency',
  'liquidityImpact',
  'partialFillImpact',
] as const);
const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enabled']);

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
type RecurringState = Readonly<{
  identity?: Readonly<{ researchCodeSha?: unknown }>;
  positions?: readonly Record<string, any>[];
}>;

type RuntimeBridgeDependencies = Readonly<{
  readPaperState(input: Readonly<{
    authenticatedPublisherAccountId: string;
    sourceSha: string;
    nowMs: number;
  }>, dependencies?: Readonly<{ env?: RuntimeEnvironment }>): Promise<PaperTradingState>;
  readRecurringState(env: RuntimeEnvironment): Promise<RecurringState>;
  issueValidationReceipt(
    identity: ManualPaperCanonicalIdentity,
    nowMs: number,
    env: RuntimeEnvironment,
  ): Promise<Readonly<{
    receipt: unknown;
    verification: ManualPaperCanonicalOwnerEvidencePacket['receiptVerification'];
  }>>;
}>;

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function exactSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function truthy(value: unknown): boolean {
  return TRUTHY.has(String(value ?? '').trim().toLowerCase());
}

function paperForwardRoot(env: RuntimeEnvironment): string {
  const configured = String(env.PAPER_FORWARD_ROOT ?? '').trim();
  return resolve(configured || DEFAULT_PAPER_FORWARD_ROOT);
}

function deployedResearchSha(env: RuntimeEnvironment): string {
  const value = String(env.DEPLOY_SHA ?? '').trim().toLowerCase();
  if (!exactSha(value)) {
    throw new PaperTradingError(
      'CANONICAL_PAPER_RUNTIME_RESEARCH_SHA_UNAVAILABLE',
      'Canonical Paper runtime bridge에 exact DEPLOY_SHA가 필요합니다.',
      503,
    );
  }
  return value;
}

function requireExplicitAbsolutePath(env: RuntimeEnvironment, key: string, code: string): string {
  const value = String(env[key] ?? '').trim();
  if (!value || !isAbsolute(value)) {
    throw new PaperTradingError(code, `${key} absolute path가 필요합니다.`, 503);
  }
  return resolve(value);
}

function receiptMaximumAgeMs(env: RuntimeEnvironment): number {
  const value = Number(env.PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_MS);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PaperTradingError(
      'CANONICAL_PAPER_VALIDATION_RECEIPT_MAXIMUM_AGE_UNCONFIGURED',
      'Validation receipt freshness policy가 명시적으로 설정되지 않았습니다.',
      503,
    );
  }
  return value;
}

async function readRecurringStateFromRuntime(env: RuntimeEnvironment): Promise<RecurringState> {
  const statePath = join(paperForwardRoot(env), 'state', 'recurring-paper-loop.json');
  let raw: string;
  try {
    raw = await readFile(statePath, 'utf8');
  } catch {
    throw new PaperTradingError(
      'CANONICAL_PAPER_NATURAL_STATE_UNAVAILABLE',
      'Natural Paper durable state를 읽을 수 없습니다.',
      503,
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
    parsed = restoreRecurringPaperLoopState(parsed, parsed?.identity);
  } catch {
    throw new PaperTradingError(
      'CANONICAL_PAPER_NATURAL_STATE_INVALID',
      'Natural Paper durable state 검증에 실패했습니다.',
      503,
    );
  }
  return parsed as RecurringState;
}

function canonicalIdentityFromPosition(position: Record<string, any>): ManualPaperCanonicalIdentity {
  const sampleIdentity = position?.sample?.identity;
  const executionDirection = sampleIdentity?.executionDirection;
  const leverage = position?.accountingEvidence?.leverage;
  const side = executionDirection === 'SHORT' ? 'SHORT' : executionDirection === 'LONG' || executionDirection === 'BUY'
    ? 'LONG'
    : null;
  if (position?.market !== 'CRYPTO_FUTURES'
    || !side
    || !positive(leverage)
    || !nonEmpty(position?.candidateId)
    || !nonEmpty(position?.strategyId)
    || !nonEmpty(position?.parameterHash)
    || !nonEmpty(position?.parameterDigest)
    || !nonEmpty(position?.symbol)
    || !nonEmpty(sampleIdentity?.timeframe)
    || !nonEmpty(sampleIdentity?.signalDirection)
    || position?.accountMode !== 'PAPER'
    || !exactSha(position?.researchCodeSha)) {
    throw new PaperTradingError(
      'CANONICAL_PAPER_NATURAL_POSITION_IDENTITY_INCOMPLETE',
      'Natural Paper position의 immutable canonical identity가 완전하지 않습니다.',
      503,
    );
  }

  return Object.freeze({
    candidateId: position.candidateId,
    strategyId: position.strategyId,
    parameterHash: position.parameterHash,
    market: position.market,
    symbol: position.symbol,
    timeframe: sampleIdentity.timeframe,
    side,
    leverage,
    parameterDigest: position.parameterDigest,
    signalDirection: sampleIdentity.signalDirection,
    accountMode: 'PAPER' as const,
    researchCodeSha: position.researchCodeSha,
  });
}

function entryCostEvidenceFromPosition(
  position: Record<string, any>,
  identity: ManualPaperCanonicalIdentity,
): Record<string, unknown> {
  const candidate = position?.entryCandidate;
  const provenance = position?.entryCostProvenance;
  const maximumAgeMs = candidate?.execution?.dataEvidence?.maxAgeMs;
  if (!candidate || !provenance || !positive(maximumAgeMs)
    || provenance.policyId !== position.costPolicyVersion
    || !nonEmpty(provenance.providerProvenance)) {
    throw new PaperTradingError(
      'CANONICAL_PAPER_ENTRY_COST_PROVENANCE_INCOMPLETE',
      'Natural Paper entry Full Cost provenance가 완전하지 않습니다.',
      503,
    );
  }

  const components: Record<string, unknown> = {};
  for (const name of ENTRY_COMPONENTS) {
    const component = provenance?.components?.[name];
    if (!component
      || !Number.isFinite(component.valuePercent)
      || component.valuePercent < 0
      || !nonEmpty(component.source)
      || !['OBSERVED', 'DOCUMENTED', 'ESTIMATED', 'NOT_APPLICABLE'].includes(component.quality)
      || !Number.isSafeInteger(component.observedAtMs)
      || component.observedAtMs <= 0
      || component.observedAtMs > position.entryTimestampMs
      || position.entryTimestampMs - component.observedAtMs > maximumAgeMs) {
      throw new PaperTradingError(
        `CANONICAL_PAPER_ENTRY_${name.toUpperCase()}_PROVENANCE_INCOMPLETE`,
        `Natural Paper entry ${name} evidence가 완전하지 않습니다.`,
        503,
      );
    }
    components[name] = Object.freeze({
      status: 'PRESENT' as const,
      source: component.source,
      provenance: provenance.providerProvenance,
      quality: component.quality,
      valuePercent: component.valuePercent,
      observedAtMs: component.observedAtMs,
      policyIdentity: Object.freeze({ version: position.costPolicyVersion }),
      identity,
      paperSampleId: position.paperSampleId,
      positionId: position.positionId,
    });
  }

  return Object.freeze({
    schemaVersion: 'manual-paper-canonical-entry-cost-evidence-v1',
    status: 'PRESENT' as const,
    fullCostReady: true as const,
    unknownIsZero: false as const,
    unavailableCostConvertedToZero: false as const,
    maximumAgeMs,
    components: Object.freeze(components),
  });
}

function findNaturalPosition(state: RecurringState, candidateId: string, researchCodeSha: string): Record<string, any> {
  if (state.identity?.researchCodeSha !== researchCodeSha) {
    throw new PaperTradingError(
      'CANONICAL_PAPER_NATURAL_STATE_RESEARCH_SHA_MISMATCH',
      'Natural Paper durable state가 현재 research SHA와 일치하지 않습니다.',
      503,
    );
  }
  const matches = (state.positions ?? []).filter((position) => (
    position?.candidateId === candidateId && position?.researchCodeSha === researchCodeSha
  ));
  if (matches.length !== 1) {
    throw new PaperTradingError(
      matches.length === 0
        ? 'CANONICAL_PAPER_NATURAL_POSITION_NOT_FOUND'
        : 'CANONICAL_PAPER_NATURAL_POSITION_AMBIGUOUS',
      '동일 candidate의 Natural Paper open position을 하나로 확정할 수 없습니다.',
      503,
    );
  }
  return matches[0]!;
}

async function issueValidationReceiptFromConfiguredOwner(
  identity: ManualPaperCanonicalIdentity,
  nowMs: number,
  env: RuntimeEnvironment,
) {
  const artifactRoot = requireExplicitAbsolutePath(
    env,
    'PAPER_CANONICAL_FORWARD_OBSERVER_ARTIFACT_ROOT',
    'CANONICAL_PAPER_FORWARD_OBSERVER_ARTIFACT_ROOT_UNCONFIGURED',
  );
  const receiptRoot = requireExplicitAbsolutePath(
    env,
    'PAPER_CANONICAL_VALIDATION_RECEIPT_ROOT',
    'CANONICAL_PAPER_VALIDATION_RECEIPT_ROOT_UNCONFIGURED',
  );
  const owner = createForwardObserverValidationReceiptOwner({
    receiptRoot,
    maximumAgeMs: receiptMaximumAgeMs(env),
    readValidationEvidence: createForwardObserverArtifactValidationEvidenceReader({ artifactRoot }),
  });
  return owner(identity, nowMs);
}

const defaultDependencies: RuntimeBridgeDependencies = Object.freeze({
  readPaperState: readAuthenticatedPaperTradingState,
  readRecurringState: readRecurringStateFromRuntime,
  issueValidationReceipt: issueValidationReceiptFromConfiguredOwner,
});

export function createManualPaperCanonicalRuntimeEvidenceSource(
  input: Readonly<{
    env?: RuntimeEnvironment;
    dependencies?: Partial<RuntimeBridgeDependencies>;
  }> = {},
): ManualPaperCanonicalEvidenceSource {
  const env = input.env ?? process.env;
  const dependencies = Object.freeze({
    ...defaultDependencies,
    ...(input.dependencies ?? {}),
  }) as RuntimeBridgeDependencies;

  const source = createManualPaperCanonicalEvidenceSource({
    readPaperState: ({ authenticatedAccountId, nowMs }) => {
      const researchCodeSha = deployedResearchSha(env);
      return dependencies.readPaperState({
        authenticatedPublisherAccountId: authenticatedAccountId,
        sourceSha: researchCodeSha,
        nowMs,
      }, { env });
    },
    readOwnerEvidence: async ({ candidateId, action, nowMs }): Promise<ManualPaperCanonicalOwnerEvidencePacket> => {
      if (action.type === 'close_position') {
        throw new PaperTradingError(
          'CANONICAL_PAPER_RUNTIME_SETTLEMENT_EVIDENCE_NOT_CONNECTED',
          'Canonical Paper trigger-bound settlement evidence의 제품 readback 연결이 아직 필요합니다.',
          503,
        );
      }
      const researchCodeSha = deployedResearchSha(env);
      const state = await dependencies.readRecurringState(env);
      const position = findNaturalPosition(state, candidateId, researchCodeSha);
      const candidate = position.entryCandidate;
      if (!candidate || candidate.candidateId !== candidateId) {
        throw new PaperTradingError(
          'CANONICAL_PAPER_ENTRY_CANDIDATE_NOT_PRESERVED',
          'Natural Paper durable entry candidate가 보존되지 않았습니다.',
          503,
        );
      }
      const identity = canonicalIdentityFromPosition(position);
      const entryCostEvidence = entryCostEvidenceFromPosition(position, identity);
      const validation = await dependencies.issueValidationReceipt(identity, nowMs, env);
      return Object.freeze({
        candidate: structuredClone(candidate),
        position: structuredClone(position),
        entryCostEvidence,
        validationReceipt: structuredClone(validation.receipt),
        receiptVerification: structuredClone(validation.verification),
      });
    },
  });

  return async (request) => {
    if (request.candidateId === null) return undefined;
    if (!truthy(env.PAPER_CANONICAL_OWNER_BRIDGE_ENABLED)) {
      throw new PaperTradingError(
        'CANONICAL_PAPER_RUNTIME_OWNER_BRIDGE_NOT_ACTIVATED',
        'Canonical Paper runtime owner bridge가 아직 활성화되지 않았습니다.',
        503,
      );
    }
    return source(request);
  };
}

export const productManualPaperCanonicalEvidenceSource =
  createManualPaperCanonicalRuntimeEvidenceSource();

export const MANUAL_PAPER_CANONICAL_RUNTIME_BRIDGE_SAFETY = Object.freeze({
  enabledByDefault: false,
  explicitActivationRequired: true,
  genuineNaturalPositionRequired: true,
  genuineForwardValidationReceiptRequired: true,
  allEightEntryCostComponentsRequired: true,
  settlementReadbackConnected: false,
  unknownCostIsZero: false,
  replayBackfillSyntheticCredit: 0,
  executionAuthority: 'NONE',
  privateTradingApiAllowed: false,
  liveTrading: false,
  realOrderEnabled: false,
});
