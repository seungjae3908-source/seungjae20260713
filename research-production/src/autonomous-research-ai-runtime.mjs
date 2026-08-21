import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { preflightResearchProduction } from './engine.mjs';
import { buildRealResearchPilotCatalog } from '../../market-prediction-lab/src/autonomous-research-pilot-v1.js';
import {
  createAutonomousResearchRuntimeState,
  executeDualFreeAiRuntime,
} from '../../market-prediction-lab/src/autonomous-research-runtime-v1.js';
import { createDualFreeAiReviewPlan } from '../../market-prediction-lab/src/autonomous-strategy-formula-generator-v1.js';
import { createGeminiGroqResearchBridge } from '../../market-prediction-lab/src/autonomous-research-free-ai-provider-bridge-v1.js';
import { researchDigest } from '../../market-prediction-lab/src/research-trial-registry.js';

const AI_SECRET_KEYS = Object.freeze([
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
]);

const SAFETY = Object.freeze({
  AUTONOMOUS_RESEARCH_FACTORY_ACTIVE: false,
  LIVE_TRADING: false,
  AUTO_TRADING: false,
  REAL_ORDER_ENABLED: false,
  PRIVATE_TRADING_API_ALLOWED: false,
  finalHoldoutOpened: false,
  shadowActivated: false,
  paperActivated: false,
  scannerEligibilityActivated: false,
  actualOrders: 0,
  actualCancels: 0,
  actualAmends: 0,
  actualTransfers: 0,
  actualWithdrawals: 0,
});

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function timestamp(value) {
  const parsed = Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) throw new TypeError('now must return a valid timestamp');
  return new Date(parsed).toISOString();
}

function secretPresence(env) {
  return Object.freeze({
    geminiConfigured: Boolean(String(env?.GEMINI_API_KEY ?? env?.GOOGLE_API_KEY ?? '').trim()),
    groqConfigured: Boolean(String(env?.GROQ_API_KEY ?? '').trim()),
  });
}

function collectSecretValues(env) {
  return AI_SECRET_KEYS
    .map((key) => String(env?.[key] ?? '').trim())
    .filter((value) => value.length > 0);
}

function assertSecretsAbsentFromValue(value, env) {
  const serialized = JSON.stringify(value);
  for (const secret of collectSecretValues(env)) {
    if (serialized.includes(secret)) throw new Error('RESEARCH_AI_SECRET_SERIALIZATION_FORBIDDEN');
  }
  return true;
}

function safeProviderMetadata(providers) {
  return Object.freeze((providers ?? []).map((provider) => Object.freeze({
    providerId: provider.providerId,
    modelId: provider.modelId,
    billingTier: provider.billingTier,
    state: provider.state,
    priority: provider.priority,
    supportedRoles: Object.freeze([...(provider.supportedRoles ?? [])]),
  })));
}

async function atomicJson(path, value, env) {
  assertSecretsAbsentFromValue(value, env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

function buildPilotAnalysis(source) {
  return Object.freeze({
    status: 'RESEARCH_PRODUCTION_REAL_AI_PILOT',
    title: source.metadata.title,
    market: source.pilot.targetMarket,
    strategyFamily: source.metadata.strategyFamily,
    strategySummary: source.metadata.strategySummary,
    formulaSummary: source.metadata.formulaSummary,
    dataStatus: source.pilot.dataStatus,
    costStatus: source.pilot.costStatus,
    generationKind: source.pilot.generationKind ?? null,
    unsupportedReason: source.pilot.unsupportedReason ?? null,
    evidenceAuthority: 'DETERMINISTIC_RUNTIME_ONLY',
    aiProfitabilityAuthority: false,
  });
}

export async function preflightAutonomousResearchAi({
  repoRoot,
  stateRoot,
  researchSha,
  env = process.env,
  verifyGitHead = true,
  fetchImpl = globalThis.fetch,
  timeoutMs = 7_000,
  now = () => new Date().toISOString(),
} = {}) {
  const observedAt = timestamp(now());
  const base = await preflightResearchProduction({
    repoRoot: requiredText(repoRoot, 'repoRoot'),
    stateRoot: requiredText(stateRoot, 'stateRoot'),
    researchSha: requiredText(researchSha, 'researchSha'),
    env,
    verifyGitHead,
  });
  const bridge = createGeminiGroqResearchBridge({ env, fetchImpl, timeoutMs, now: () => observedAt });
  const presence = secretPresence(env);
  const providers = safeProviderMetadata(bridge.providers);
  const result = Object.freeze({
    schemaVersion: 1,
    mode: 'PREFLIGHT',
    status: presence.geminiConfigured && presence.groqConfigured ? 'PROVIDER_CONFIGURED_UNPROBED' : 'WAITING_FOR_AI',
    observedAt,
    researchSha: base.researchSha,
    checkoutSha: base.checkoutSha,
    stateRoot: resolve(stateRoot),
    providerPresence: presence,
    providers,
    FREE_PROVIDER_ONLY: true,
    PAID_FALLBACK: false,
    providerNetworkCalls: 0,
    secretValuesExposed: false,
    serviceActivationRequested: false,
    timerActivationRequested: false,
    safety: SAFETY,
  });
  assertSecretsAbsentFromValue(result, env);
  return Object.freeze({ result, bridge, base });
}

export async function probeAutonomousResearchAi(input = {}) {
  const preflight = await preflightAutonomousResearchAi(input);
  const readiness = await preflight.bridge.probeFreeAiProviders();
  const result = Object.freeze({
    schemaVersion: 1,
    mode: 'PROBE',
    status: readiness.AI_DUAL_REVIEW_READY === 'READY' ? 'READY' : 'AI_RESEARCH_UNAVAILABLE',
    observedAt: readiness.checkedAt,
    researchSha: preflight.base.researchSha,
    providerPresence: preflight.result.providerPresence,
    providerReadiness: readiness,
    providerNetworkCalls: preflight.result.providerPresence.geminiConfigured || preflight.result.providerPresence.groqConfigured ? 2 : 0,
    FREE_PROVIDER_ONLY: true,
    PAID_FALLBACK: false,
    secretValuesExposed: false,
    serviceActivationRequested: false,
    timerActivationRequested: false,
    safety: SAFETY,
  });
  assertSecretsAbsentFromValue(result, input.env ?? process.env);
  return Object.freeze({ result, bridge: preflight.bridge, base: preflight.base });
}

export async function runAutonomousResearchAiPilot({
  repoRoot,
  stateRoot,
  researchSha,
  env = process.env,
  verifyGitHead = true,
  fetchImpl = globalThis.fetch,
  timeoutMs = 7_000,
  now = () => new Date().toISOString(),
  pilotIndex = 0,
} = {}) {
  const observedAt = timestamp(now());
  const probed = await probeAutonomousResearchAi({
    repoRoot,
    stateRoot,
    researchSha,
    env,
    verifyGitHead,
    fetchImpl,
    timeoutMs,
    now: () => observedAt,
  });
  const stateDir = join(resolve(stateRoot), 'autonomous-ai');

  if (probed.result.status !== 'READY') {
    const blocked = Object.freeze({
      schemaVersion: 1,
      mode: 'PILOT',
      status: 'AI_RESEARCH_UNAVAILABLE',
      observedAt,
      researchSha: probed.base.researchSha,
      providerReadiness: probed.result.providerReadiness,
      reviewCalls: 0,
      reviews: 0,
      queueJobsCreated: 0,
      backtestsExecuted: 0,
      profitabilityClaimed: false,
      championCreated: false,
      finalHoldoutOpened: false,
      secretValuesExposed: false,
      FREE_PROVIDER_ONLY: true,
      PAID_FALLBACK: false,
      safety: SAFETY,
    });
    await atomicJson(join(stateDir, 'latest-ai-pilot.json'), blocked, env);
    return blocked;
  }

  const catalog = buildRealResearchPilotCatalog({ ingestedAt: observedAt });
  if (!Number.isInteger(pilotIndex) || pilotIndex < 0 || pilotIndex >= catalog.length) {
    throw new RangeError('pilotIndex is outside the real research pilot catalog');
  }
  const source = catalog[pilotIndex];
  const analysis = buildPilotAnalysis(source);
  const evidenceFingerprint = researchDigest({
    metadata: source.metadata,
    pilot: source.pilot,
    researchSha: probed.base.researchSha,
  });
  const plan = createDualFreeAiReviewPlan({
    evidenceFingerprint,
    providers: probed.bridge.providers,
  });
  if (plan.status !== 'DUAL_FREE_AI_READY') throw new Error('AI_RESEARCH_UNAVAILABLE');

  const execution = await executeDualFreeAiRuntime(
    createAutonomousResearchRuntimeState(),
    {
      plan,
      researchSourceId: `research-production-pilot:${source.pilot.pilotId}`,
      researchRecord: source.metadata,
      analysis,
      calledAt: observedAt,
    },
    probed.bridge.callFreeAiReviewProvider,
  );

  const core = Object.freeze({
    schemaVersion: 1,
    mode: 'PILOT',
    status: execution.synthesis.status,
    observedAt,
    researchSha: probed.base.researchSha,
    pilotId: source.pilot.pilotId,
    researchTitle: source.metadata.title,
    evidenceFingerprint,
    providerReadiness: probed.result.providerReadiness,
    reviewCalls: execution.calls.length,
    reviews: execution.reviews.length,
    synthesis: execution.synthesis,
    callAudit: execution.calls,
    queueJobsCreated: 0,
    backtestsExecuted: 0,
    profitabilityClaimed: false,
    championCreated: false,
    finalHoldoutOpened: false,
    secretValuesExposed: false,
    FREE_PROVIDER_ONLY: true,
    PAID_FALLBACK: false,
    serviceActivationRequested: false,
    timerActivationRequested: false,
    safety: SAFETY,
  });
  const result = Object.freeze({ ...core, artifactDigest: researchDigest(core) });
  assertSecretsAbsentFromValue(result, env);
  await atomicJson(join(stateDir, `${result.artifactDigest}.json`), result, env);
  await atomicJson(join(stateDir, 'latest-ai-pilot.json'), result, env);
  return result;
}

export const AUTONOMOUS_RESEARCH_AI_SECRET_KEYS = AI_SECRET_KEYS;
export const AUTONOMOUS_RESEARCH_AI_SAFETY = SAFETY;
