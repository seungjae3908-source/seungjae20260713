import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { restoreRecurringPaperLoopState } from '../../../market-prediction-lab/src/recurring-paper-loop-v1.js';
import {
  validateImmutablePaperTradingStateSnapshot,
  type PaperTradingStateSnapshot,
} from './paper-trading-state-snapshot.service';

export const MANUAL_PAPER_CANONICAL_RUNTIME_READINESS_VERSION =
  'manual-paper-canonical-runtime-readiness-v1' as const;

const DEFAULT_STATE_ROOT = '/opt/stock-app-data/paper-forward-v1';
const DEFAULT_PAPER_FORWARD_ROOT = '/opt/stock-app-data/paper-forward-v1/runtime-state';
const BINDING_RELATIVE_PATH = 'publisher-binding.json';
const SNAPSHOT_RELATIVE_PATH = 'publisher/paper-state-v2.json';
const RECURRING_STATE_RELATIVE_PATH = 'state/recurring-paper-loop.json';
const ARTIFACT_FILES = Object.freeze(['state.json', 'summary.json', 'manifest.json'] as const);
const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enabled']);

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

type RuntimeReadinessDependencies = Readonly<{
  readText(path: string): Promise<string>;
  accessPath(path: string, mode: number): Promise<void>;
  validateSnapshot(raw: unknown, nowMs: number): PaperTradingStateSnapshot;
  validateRecurringState(raw: unknown): unknown;
}>;

export type ManualPaperCanonicalRuntimeReadinessCheck = Readonly<{
  name: string;
  passed: boolean;
}>;

export type ManualPaperCanonicalRuntimeReadinessResult = Readonly<{
  schemaVersion: typeof MANUAL_PAPER_CANONICAL_RUNTIME_READINESS_VERSION;
  status: 'READY_FOR_ACTIVATION_REVIEW' | 'BLOCKED';
  readyForActivationReview: boolean;
  activationApplied: false;
  bridgeEnabled: boolean;
  deployShaBound: boolean;
  paperStateBindingReady: boolean;
  paperStateSnapshotReady: boolean;
  naturalPaperStateReady: boolean;
  forwardObserverArtifactsReady: boolean;
  validationReceiptPathReady: boolean;
  safetyBoundaryReady: boolean;
  checks: readonly ManualPaperCanonicalRuntimeReadinessCheck[];
  blockers: readonly string[];
  safety: Readonly<{
    liveTrading: false;
    autoTrading: false;
    realOrderEnabled: false;
    privateTradingApiAllowed: false;
    executionAuthority: 'NONE';
    financialMutationPerformed: false;
    environmentMutationPerformed: false;
  }>;
}>;

function exactSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function truthy(value: unknown): boolean {
  return TRUTHY.has(String(value ?? '').trim().toLowerCase());
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function pushUnique(blockers: string[], blocker: string): void {
  if (!blockers.includes(blocker)) blockers.push(blocker);
}

function parseJson(text: string, blocker: string, blockers: string[]): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    pushUnique(blockers, blocker);
    return null;
  }
}

function explicitAbsolutePath(
  env: RuntimeEnvironment,
  key: string,
  blocker: string,
  blockers: string[],
): string | null {
  const raw = String(env[key] ?? '').trim();
  if (!raw || !isAbsolute(raw)) {
    pushUnique(blockers, blocker);
    return null;
  }
  return resolve(raw);
}

function stateRoot(env: RuntimeEnvironment): string {
  const configured = String(env.PAPER_FORWARD_STATE_ROOT ?? '').trim();
  return resolve(configured || DEFAULT_STATE_ROOT);
}

function paperForwardRoot(env: RuntimeEnvironment): string {
  const configured = String(env.PAPER_FORWARD_ROOT ?? '').trim();
  return resolve(configured || DEFAULT_PAPER_FORWARD_ROOT);
}

function safetyBlockers(env: RuntimeEnvironment): string[] {
  const blockers: string[] = [];
  if (truthy(env.LIVE_TRADING)) blockers.push('PAPER_CANONICAL_LIVE_TRADING_MUST_REMAIN_OFF');
  if (truthy(env.AUTO_TRADING)) blockers.push('PAPER_CANONICAL_AUTO_TRADING_MUST_REMAIN_OFF');
  if (truthy(env.REAL_ORDER_ENABLED)) blockers.push('PAPER_CANONICAL_REAL_ORDER_MUST_REMAIN_OFF');
  if (truthy(env.PRIVATE_TRADING_API_ALLOWED)) blockers.push('PAPER_CANONICAL_PRIVATE_API_MUST_REMAIN_OFF');
  const authority = String(env.executionAuthority ?? env.EXECUTION_AUTHORITY ?? 'NONE').trim().toUpperCase();
  if (authority !== 'NONE') blockers.push('PAPER_CANONICAL_EXECUTION_AUTHORITY_MUST_BE_NONE');
  return blockers;
}

const defaultDependencies: RuntimeReadinessDependencies = Object.freeze({
  readText: (path) => readFile(path, 'utf8'),
  accessPath: (path, mode) => access(path, mode),
  validateSnapshot: (raw, nowMs) => validateImmutablePaperTradingStateSnapshot(raw, nowMs),
  validateRecurringState: (raw) => {
    const candidate = raw as any;
    return restoreRecurringPaperLoopState(candidate, candidate?.identity);
  },
});

export async function probeManualPaperCanonicalRuntimeReadiness(
  input: Readonly<{
    expectedMainSha: string;
    env?: RuntimeEnvironment;
    nowMs?: number;
    dependencies?: Partial<RuntimeReadinessDependencies>;
  }>,
): Promise<ManualPaperCanonicalRuntimeReadinessResult> {
  const env = input.env ?? process.env;
  const nowMs = input.nowMs ?? Date.now();
  const dependencies = Object.freeze({
    ...defaultDependencies,
    ...(input.dependencies ?? {}),
  }) as RuntimeReadinessDependencies;
  const blockers: string[] = [];
  const checks: ManualPaperCanonicalRuntimeReadinessCheck[] = [];

  const check = (name: string, passed: boolean, blocker?: string) => {
    checks.push(Object.freeze({ name, passed }));
    if (!passed && blocker) pushUnique(blockers, blocker);
  };

  const expectedMainSha = String(input.expectedMainSha ?? '').trim().toLowerCase();
  const deploySha = String(env.DEPLOY_SHA ?? '').trim().toLowerCase();
  check('EXPECTED_MAIN_SHA_VALID', exactSha(expectedMainSha), 'PAPER_CANONICAL_EXPECTED_MAIN_SHA_INVALID');
  check(
    'DEPLOY_SHA_EXACT_MAIN',
    exactSha(deploySha) && deploySha === expectedMainSha,
    'PAPER_CANONICAL_DEPLOY_SHA_MISMATCH',
  );

  const bridgeEnabled = truthy(env.PAPER_CANONICAL_OWNER_BRIDGE_ENABLED);
  check(
    'BRIDGE_REMAINS_DISABLED_BEFORE_ACTIVATION',
    bridgeEnabled === false,
    'PAPER_CANONICAL_BRIDGE_ALREADY_ENABLED',
  );

  for (const blocker of safetyBlockers(env)) pushUnique(blockers, blocker);
  const safetyBoundaryReady = safetyBlockers(env).length === 0;
  checks.push(Object.freeze({ name: 'TRADING_SAFETY_BOUNDARY', passed: safetyBoundaryReady }));

  const root = stateRoot(env);
  const bindingPath = join(root, BINDING_RELATIVE_PATH);
  const snapshotPath = join(root, SNAPSHOT_RELATIVE_PATH);
  let binding: any = null;
  try {
    binding = parseJson(
      await dependencies.readText(bindingPath),
      'PAPER_CANONICAL_PAPER_STATE_BINDING_INVALID_JSON',
      blockers,
    ) as any;
  } catch {
    pushUnique(blockers, 'PAPER_CANONICAL_PAPER_STATE_BINDING_UNREADABLE');
  }

  const bindingReady = Boolean(
    binding
      && binding.schemaVersion === 'paper-state-publisher-runtime-binding-v1'
      && binding.paperRuntimeSourceSha === expectedMainSha
      && binding.snapshotPath === snapshotPath
      && isAbsolute(binding.snapshotPath)
      && sha256(binding.publisherAccountIdSha256)
      && binding.immutable === true
      && binding.executionAuthority === 'NONE'
      && binding.privateApiAllowed === false
      && binding.liveTrading === false
      && binding.financialMutationAllowed === false,
  );
  check(
    'PAPER_STATE_RUNTIME_BINDING',
    bindingReady,
    'PAPER_CANONICAL_PAPER_STATE_BINDING_NOT_READY',
  );

  let snapshotReady = false;
  try {
    const raw = parseJson(
      await dependencies.readText(snapshotPath),
      'PAPER_CANONICAL_PAPER_STATE_SNAPSHOT_INVALID_JSON',
      blockers,
    );
    if (raw) {
      const snapshot = dependencies.validateSnapshot(raw, nowMs);
      snapshotReady = snapshot.sourceSha === expectedMainSha
        && snapshot.publisherAccountIdSha256 === binding?.publisherAccountIdSha256
        && snapshot.executionAuthority === 'NONE'
        && snapshot.privateApiAllowed === false
        && snapshot.liveTrading === false
        && snapshot.financialMutationAllowed === false;
    }
  } catch {
    pushUnique(blockers, 'PAPER_CANONICAL_PAPER_STATE_SNAPSHOT_UNREADABLE_OR_INVALID');
  }
  check(
    'PAPER_STATE_SNAPSHOT',
    snapshotReady,
    'PAPER_CANONICAL_PAPER_STATE_SNAPSHOT_NOT_READY',
  );

  const recurringStatePath = join(paperForwardRoot(env), RECURRING_STATE_RELATIVE_PATH);
  let recurringReady = false;
  try {
    const raw = parseJson(
      await dependencies.readText(recurringStatePath),
      'PAPER_CANONICAL_NATURAL_STATE_INVALID_JSON',
      blockers,
    );
    if (raw) {
      dependencies.validateRecurringState(raw);
      recurringReady = (raw as any)?.identity?.researchCodeSha === expectedMainSha;
    }
  } catch {
    pushUnique(blockers, 'PAPER_CANONICAL_NATURAL_STATE_UNREADABLE_OR_INVALID');
  }
  check(
    'NATURAL_PAPER_DURABLE_STATE',
    recurringReady,
    'PAPER_CANONICAL_NATURAL_STATE_NOT_READY',
  );

  const artifactRoot = explicitAbsolutePath(
    env,
    'PAPER_CANONICAL_FORWARD_OBSERVER_ARTIFACT_ROOT',
    'PAPER_CANONICAL_FORWARD_OBSERVER_ARTIFACT_ROOT_UNCONFIGURED',
    blockers,
  );
  let artifactsReady = artifactRoot !== null;
  if (artifactRoot) {
    for (const filename of ARTIFACT_FILES) {
      try {
        const text = await dependencies.readText(join(artifactRoot, filename));
        if (parseJson(text, 'PAPER_CANONICAL_FORWARD_OBSERVER_ARTIFACT_INVALID_JSON', blockers) == null) {
          artifactsReady = false;
        }
      } catch {
        artifactsReady = false;
        pushUnique(blockers, 'PAPER_CANONICAL_FORWARD_OBSERVER_ARTIFACT_UNREADABLE');
      }
    }
  }
  check(
    'FORWARD_OBSERVER_ARTIFACTS',
    artifactsReady,
    'PAPER_CANONICAL_FORWARD_OBSERVER_ARTIFACTS_NOT_READY',
  );

  const receiptRoot = explicitAbsolutePath(
    env,
    'PAPER_CANONICAL_VALIDATION_RECEIPT_ROOT',
    'PAPER_CANONICAL_VALIDATION_RECEIPT_ROOT_UNCONFIGURED',
    blockers,
  );
  let receiptPathReady = receiptRoot !== null;
  if (receiptRoot) {
    try {
      await dependencies.accessPath(receiptRoot, fsConstants.R_OK | fsConstants.W_OK);
    } catch {
      receiptPathReady = false;
      pushUnique(blockers, 'PAPER_CANONICAL_VALIDATION_RECEIPT_ROOT_NOT_ACCESSIBLE');
    }
  }
  const maximumAgeMs = Number(env.PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_MS);
  const maximumAgeReady = Number.isSafeInteger(maximumAgeMs) && maximumAgeMs > 0;
  check(
    'VALIDATION_RECEIPT_ROOT',
    receiptPathReady,
    'PAPER_CANONICAL_VALIDATION_RECEIPT_PATH_NOT_READY',
  );
  check(
    'VALIDATION_RECEIPT_FRESHNESS_POLICY',
    maximumAgeReady,
    'PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_UNCONFIGURED',
  );

  const deployShaBound = exactSha(deploySha) && deploySha === expectedMainSha;
  const readyForActivationReview = blockers.length === 0;

  return Object.freeze({
    schemaVersion: MANUAL_PAPER_CANONICAL_RUNTIME_READINESS_VERSION,
    status: readyForActivationReview ? 'READY_FOR_ACTIVATION_REVIEW' : 'BLOCKED',
    readyForActivationReview,
    activationApplied: false,
    bridgeEnabled,
    deployShaBound,
    paperStateBindingReady: bindingReady,
    paperStateSnapshotReady: snapshotReady,
    naturalPaperStateReady: recurringReady,
    forwardObserverArtifactsReady: artifactsReady,
    validationReceiptPathReady: receiptPathReady && maximumAgeReady,
    safetyBoundaryReady,
    checks: Object.freeze(checks),
    blockers: Object.freeze(blockers),
    safety: Object.freeze({
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
      executionAuthority: 'NONE' as const,
      financialMutationPerformed: false,
      environmentMutationPerformed: false,
    }),
  });
}
