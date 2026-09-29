#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { canonicalJson, sha256 } from '../src/public-forward-liquidity-calibration.mjs';
import {
  buildServerCanonicalCutoverReadiness,
  SERVER_CANONICAL_CUTOVER_AUTHORITY_SCHEMA,
  SERVER_CANONICAL_SOURCE_PRECEDENCE,
} from '../src/public-forward-liquidity-server-canonical-cutover-readiness-v1.mjs';
import {
  buildServerCanonicalCreditKey,
  runServerCanonicalNaturalTick,
  SERVER_CANONICAL_RUNTIME_ACTIVATION_SCHEMA,
} from '../src/public-forward-liquidity-server-canonical-runtime-v1.mjs';
import {
  resolveServerEvidenceNtpSynchronization,
} from '../src/public-forward-liquidity-server-shadow-worker-v1.mjs';
import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
} from '../src/public-forward-liquidity-successor-schedule-reliability-v3.mjs';

const REPOSITORY = process.env.SERVER_EVIDENCE_REPOSITORY ?? 'seungjae3908-source/seungjae20260713';
const TARGET_WORKFLOW_ID = 347888347;
const REQUIRED_WORKFLOW_ID = 325169344;
const REQUIRED_WORKFLOW_PATH = '.github/workflows/futures-public-network-smoke.yml';
const REQUIRED_CONTEXTS = [
  'application-ci/verified',
  'browser-ui/verified',
  'database-rls/verified',
  'security-integration/verified',
  'ai-privacy/verified',
  'futures-public-network-smoke/verified',
];
const ROOT = '/opt/stock-app-server-evidence-shadow-v1';
const DEFAULT_READINESS = `${ROOT}/canonical-cutover-readiness.json`;
const DEFAULT_ACTIVATION = `${ROOT}/canonical-runtime-activation.json`;
const DEFAULT_STATE_ROOT = '/var/lib/stock-app-server-evidence-shadow-v1';
const SHADOW_TIMER = 'public-forward-liquidity-server-shadow-worker-v1.timer';
const CANONICAL_TIMER = 'public-forward-liquidity-server-canonical-runtime-v1.timer';

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}
function exactSha(value, code) {
  const normalized = required(value, code).toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) throw new Error(code);
  return normalized;
}
function exactDigest(value, code) {
  const normalized = required(value, code).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(code);
  return normalized;
}
function positiveInteger(value, code) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(code);
  return n;
}
function boolCommand(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
function ntpSynchronized() {
  let output;
  try {
    output = execFileSync('/usr/bin/timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return resolveServerEvidenceNtpSynchronization({
      timedatectlSucceeded: false,
      timedatectlValue: null,
      systemdSyncMarkerPresent: existsSync('/run/systemd/timesync/synchronized'),
    });
  }
  return resolveServerEvidenceNtpSynchronization({
    timedatectlSucceeded: true,
    timedatectlValue: output,
    systemdSyncMarkerPresent: false,
  });
}
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function deployedSha() {
  return exactSha(
    await readFile(process.env.SERVER_EVIDENCE_DEPLOY_SHA_FILE ?? `${ROOT}/current/.deploy/current-sha`, 'utf8'),
    'SERVER_CANONICAL_DEPLOY_SHA_INVALID',
  );
}
async function bindingDigest() {
  const binding = await json(new URL('../config/public-forward-liquidity-successor-schedule-reliability-activation-v3.json', import.meta.url));
  const digest = sha256(canonicalJson(binding));
  const expected = String(process.env.SERVER_EVIDENCE_EXPECTED_BINDING_DIGEST ?? '').trim();
  if (expected && exactDigest(expected, 'SERVER_CANONICAL_EXPECTED_BINDING_DIGEST_INVALID') !== digest) {
    throw new Error('SERVER_CANONICAL_BINDING_DIGEST_MISMATCH');
  }
  return digest;
}
async function api(path) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'stock-app-server-canonical-v1',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`SERVER_CANONICAL_GITHUB_HTTP_${response.status}`);
  return response.json();
}
async function remoteMainSha() {
  const branch = await api('/branches/main');
  return exactSha(branch?.commit?.sha, 'SERVER_CANONICAL_REMOTE_MAIN_INVALID');
}
async function requiredCi(currentMainSha) {
  const statuses = await api(`/commits/${currentMainSha}/statuses?per_page=100`);
  statuses.sort((a, b) => Number(b.id) - Number(a.id));
  const latest = new Map();
  for (const status of statuses) if (!latest.has(status.context)) latest.set(status.context, status);
  const contexts = Object.fromEntries(REQUIRED_CONTEXTS.map((name) => [name, latest.get(name)?.state ?? null]));
  const runIds = new Set();
  for (const name of REQUIRED_CONTEXTS) {
    const match = String(latest.get(name)?.target_url ?? '').match(/\/actions\/runs\/(\d+)/u);
    if (match) runIds.add(Number(match[1]));
  }
  if (runIds.size !== 1) return { contexts };
  const runId = [...runIds][0];
  const run = await api(`/actions/runs/${runId}`);
  return {
    runId,
    headSha: run.head_sha,
    workflowId: Number(run.workflow_id),
    workflowName: run.name,
    workflowPath: run.path,
    event: run.event,
    headBranch: run.head_branch,
    runAttempt: Number(run.run_attempt),
    status: run.status,
    conclusion: run.conclusion,
    contexts,
  };
}
async function githubDelivery({ currentMainSha, authorizedAtMs, slotIndex = null, observedAtMs = Date.now() }) {
  const [workflow, targetRunsPayload, repoRunsPayload] = await Promise.all([
    api(`/actions/workflows/${TARGET_WORKFLOW_ID}`),
    api(`/actions/workflows/${TARGET_WORKFLOW_ID}/runs?event=schedule&branch=main&per_page=100`),
    api('/actions/runs?event=schedule&branch=main&per_page=100'),
  ]);
  const targetRuns = targetRunsPayload.workflow_runs ?? [];
  const repoRuns = repoRunsPayload.workflow_runs ?? [];
  const latestTarget = targetRuns[0] ?? null;
  const currentMainRuns = targetRuns.filter((run) => run.head_sha === currentMainSha);
  const sinceAuthority = currentMainRuns.filter((run) => Date.parse(run.created_at) >= authorizedAtMs);
  let sameSlot = [];
  if (Number.isSafeInteger(slotIndex)) {
    const cohort = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyCore.cohort;
    const start = cohort.startInclusiveMs + slotIndex * cohort.slotCadenceMs;
    const end = start + cohort.slotCadenceMs;
    sameSlot = currentMainRuns.filter((run) => {
      const ms = Date.parse(run.created_at);
      return ms >= start && ms < end;
    });
  }
  const latestRepo = repoRuns.find((run) => Number(run.workflow_id) !== TARGET_WORKFLOW_ID) ?? null;
  return {
    targetWorkflowId: TARGET_WORKFLOW_ID,
    targetWorkflowState: workflow.state,
    targetLatestScheduleWorkflowId: latestTarget ? Number(latestTarget.workflow_id) : null,
    targetLatestScheduleEvent: latestTarget?.event ?? null,
    targetLatestScheduleHeadSha: latestTarget?.head_sha ?? null,
    targetLatestScheduleCreatedAtMs: latestTarget ? Date.parse(latestTarget.created_at) : null,
    targetCurrentMainScheduleRunCount: currentMainRuns.length,
    targetScheduleRunCountSinceCutoverAuthority: sinceAuthority.length,
    targetSameSlotScheduleRunCount: sameSlot.length,
    targetRecoveryObserved: currentMainRuns.length > 0,
    repositoryLatestScheduleCreatedAtMs: latestRepo ? Date.parse(latestRepo.created_at) : null,
    repositoryLatestScheduleWorkflowId: latestRepo ? Number(latestRepo.workflow_id) : null,
    repositoryLatestScheduleEvent: latestRepo?.event ?? null,
    repositoryLatestScheduleHeadSha: latestRepo?.head_sha ?? null,
    observedAtMs,
  };
}
async function canonicalLedger(stateRoot, identity) {
  const key = buildServerCanonicalCreditKey(identity);
  const slotRoot = join(resolve(stateRoot), 'server-canonical-v1', 'slots', `slot-${String(identity.slotIndex).padStart(4, '0')}`);
  let entries = [];
  try { entries = await readdir(slotRoot, { withFileTypes: true }); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const matchingCanonicalCredits = entries.filter((entry) => entry.isDirectory()).map((entry) => ({ attempt: entry.name }));
  return {
    lookupComplete: true,
    sourcePrecedence: [...SERVER_CANONICAL_SOURCE_PRECEDENCE],
    creditKey: key.key,
    creditKeyDigest: key.keyDigest,
    matchingCanonicalCredits,
    maximumCanonicalEconomicCredit: 1,
  };
}

async function latestPresentShadowReceipt(stateRoot) {
  const slotsRoot = join(resolve(stateRoot), 'slots');
  let slots = [];
  try { slots = await readdir(slotsRoot, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  let latest = null;
  for (const slot of slots) {
    if (!slot.isDirectory()) continue;
    const slotRoot = join(slotsRoot, slot.name);
    const attempts = await readdir(slotRoot, { withFileTypes: true });
    for (const attempt of attempts) {
      if (!attempt.isDirectory()) continue;
      try {
        const receipt = await json(join(slotRoot, attempt.name, 'shadow-receipt.json'));
        if (receipt?.captureStatus !== 'PRESENT_SHADOW' || receipt?.shadowOnly !== true || receipt?.canonicalEconomicCredit !== 0) continue;
        if (!latest || Number(receipt.serverStartedAtMs) > Number(latest.serverStartedAtMs)) latest = receipt;
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  }
  return latest;
}

async function historicalShadowLedger(stateRoot) {
  const slotsRoot = join(resolve(stateRoot), 'slots');
  let slots = [];
  try { slots = await readdir(slotsRoot, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return { lookupComplete: true, canonicalCreditN: 0, retroactivePromotionPerformed: false };
    throw error;
  }
  let canonicalCreditN = 0;
  for (const slot of slots) {
    if (!slot.isDirectory()) continue;
    const attempts = await readdir(join(slotsRoot, slot.name), { withFileTypes: true });
    for (const attempt of attempts) {
      if (!attempt.isDirectory()) continue;
      try {
        const receipt = await json(join(slotsRoot, slot.name, attempt.name, 'shadow-receipt.json'));
        if (Number(receipt?.canonicalEconomicCredit) !== 0 || receipt?.serverCanonical === true) canonicalCreditN += 1;
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  }
  return { lookupComplete: true, canonicalCreditN, retroactivePromotionPerformed: false };
}
function baselineEvidence() {
  return {
    canonicalTrainReceiptN: 4,
    independentN: 4,
    validationN: 0,
    oosN: 0,
    retroactiveRecomputePerformed: false,
    historicalShadowPromotionPerformed: false,
  };
}
async function writeCreateOnly(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o755 });
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}
function serverRuntime(mode, sha) {
  const timer = mode === 'shadow' ? SHADOW_TIMER : CANONICAL_TIMER;
  return {
    deployedSha: sha,
    timerEnabled: boolCommand('/usr/bin/systemctl', ['is-enabled', '--quiet', timer]),
    timerActive: boolCommand('/usr/bin/systemctl', ['is-active', '--quiet', timer]),
    persistent: false,
    timerUnit: mode === 'shadow' ? SHADOW_TIMER : CANONICAL_TIMER,
    serviceUnit: mode === 'shadow'
      ? 'public-forward-liquidity-server-shadow-worker-v1.service'
      : 'public-forward-liquidity-server-canonical-runtime-v1.service',
    timerTimezone: 'UTC',
    onCalendarUtc: ['*-*-* *:17:00 UTC', '*-*-* *:27:00 UTC', '*-*-* *:37:00 UTC'],
    triggerMinutesUtc: [17, 27, 37],
    accuracySec: 1,
    randomizedDelaySec: 0,
    ntpSynchronized: ntpSynchronized(),
    shadowOnly: mode === 'shadow',
    serverCanonical: mode === 'canonical',
    receiptPersistence: 'CREATE_ONLY_WX',
    productionAppMutationPerformed: false,
    manualCapturePerformed: false,
    executionAuthority: 'NONE',
  };
}
async function prepareActivation() {
  const currentMainSha = exactSha(process.env.SERVER_CANONICAL_TARGET_SHA, 'SERVER_CANONICAL_TARGET_SHA_INVALID');
  const activationReceiptCommentId = positiveInteger(process.env.SERVER_CANONICAL_V3_RECEIPT_COMMENT_ID, 'SERVER_CANONICAL_V3_RECEIPT_INVALID');
  const expectedBindingDigest = exactDigest(process.env.SERVER_EVIDENCE_EXPECTED_BINDING_DIGEST, 'SERVER_CANONICAL_BINDING_INVALID');
  const authorityCommentId = positiveInteger(process.env.SERVER_CANONICAL_AUTHORITY_COMMENT_ID, 'SERVER_CANONICAL_AUTHORITY_COMMENT_ID_INVALID');
  const authorizedAtMs = positiveInteger(process.env.SERVER_CANONICAL_AUTHORIZED_AT_MS, 'SERVER_CANONICAL_AUTHORIZED_AT_INVALID');
  const actualDeploySha = await deployedSha();
  if (actualDeploySha !== currentMainSha || await remoteMainSha() !== currentMainSha) throw new Error('SERVER_CANONICAL_MAIN_OR_DEPLOY_DRIFT');
  if (await bindingDigest() !== expectedBindingDigest) throw new Error('SERVER_CANONICAL_BINDING_DRIFT');
  const cohort = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyCore.cohort;
  if (authorizedAtMs < cohort.startInclusiveMs || authorizedAtMs >= cohort.endExclusiveMs) throw new Error('SERVER_CANONICAL_AUTHORITY_OUTSIDE_COHORT');
  const authoritySlot = Math.floor((authorizedAtMs - cohort.startInclusiveMs) / cohort.slotCadenceMs);
  const firstEligibleSlotIndex = authoritySlot + 1;
  const stateRoot = process.env.SERVER_EVIDENCE_STATE_ROOT ?? DEFAULT_STATE_ROOT;
  const latestPresentShadow = await latestPresentShadowReceipt(stateRoot);
  const latestActivationReceipt = {
    issueNumber: 23,
    action: 'AUTHORIZE',
    targetMainSha: currentMainSha,
    activationBindingDigest: expectedBindingDigest,
    commentId: activationReceiptCommentId,
    authorAssociation: 'OWNER',
    actorLogin: 'seungjae3908-source',
    body: `/authorize-public-only-partial-fill-v3-schedule-activation ${currentMainSha} ${expectedBindingDigest}`,
    latestForTargetBinding: true,
  };
  const cutoverAuthority = {
    schemaVersion: SERVER_CANONICAL_CUTOVER_AUTHORITY_SCHEMA,
    targetMainSha: currentMainSha,
    activationBindingDigest: expectedBindingDigest,
    activationReceiptCommentId,
    authorityCommentId,
    authorizedAtMs,
    firstEligibleSlotIndex,
    replayCredit: 0,
    backfillCredit: 0,
    manualCredit: 0,
    syntheticCredit: 0,
    hindsightCredit: 0,
    executionAuthority: 'NONE',
  };
  const delivery = await githubDelivery({ currentMainSha, authorizedAtMs, slotIndex: latestPresentShadow?.slotIndex ?? null });
  const ledger = latestPresentShadow?.slotIndex == null
    ? { lookupComplete: false, matchingCanonicalCredits: [] }
    : await canonicalLedger(stateRoot, {
        policyDigest: latestPresentShadow.policyDigest,
        cohortDigest: latestPresentShadow.cohortDigest,
        slotIndex: latestPresentShadow.slotIndex,
      });
  const readiness = buildServerCanonicalCutoverReadiness({
    currentMainSha,
    activationBindingDigest: expectedBindingDigest,
    latestActivationReceipt,
    requiredCi: await requiredCi(currentMainSha),
    githubDelivery: delivery,
    serverRuntime: serverRuntime('shadow', currentMainSha),
    cutoverAuthority,
    shadowReceipt: latestPresentShadow,
    canonicalCreditLedger: ledger,
  });
  if (!readiness.readyForFutureCanonicalCutover) {
    process.stdout.write(`${JSON.stringify(readiness)}\n`);
    throw new Error(`SERVER_CANONICAL_READINESS_BLOCKED:${readiness.blockers.join(',')}`);
  }
  const body = {
    schemaVersion: SERVER_CANONICAL_RUNTIME_ACTIVATION_SCHEMA,
    activationApplied: true,
    defaultOffAcknowledged: true,
    targetMainSha: currentMainSha,
    activationBindingDigest: expectedBindingDigest,
    readinessDigest: sha256(canonicalJson(readiness)),
    activationReceiptCommentId,
    authorityCommentId,
    authorizedAtMs,
    firstEligibleSlotIndex,
    sourcePrecedence: [...SERVER_CANONICAL_SOURCE_PRECEDENCE],
    preAuthorityShadowCanonicalCredit: 0,
    preCutoverShadowCanonicalCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    manualCredit: 0,
    syntheticCredit: 0,
    hindsightCredit: 0,
    executionAuthority: 'NONE',
  };
  const activation = { ...body, activationDigest: sha256(canonicalJson(body)) };
  await writeCreateOnly(process.env.SERVER_EVIDENCE_CANONICAL_READINESS_FILE ?? DEFAULT_READINESS, readiness);
  await writeCreateOnly(process.env.SERVER_EVIDENCE_CANONICAL_ACTIVATION_FILE ?? DEFAULT_ACTIVATION, activation);
  process.stdout.write(`${JSON.stringify({ status: 'READY', firstEligibleSlotIndex, readinessDigest: body.readinessDigest, activationDigest: activation.activationDigest })}\n`);
}
async function tick() {
  const currentMainSha = await deployedSha();
  const digest = await bindingDigest();
  const readiness = await json(process.env.SERVER_EVIDENCE_CANONICAL_READINESS_FILE ?? DEFAULT_READINESS);
  const activation = await json(process.env.SERVER_EVIDENCE_CANONICAL_ACTIVATION_FILE ?? DEFAULT_ACTIVATION);
  const stateRoot = process.env.SERVER_EVIDENCE_STATE_ROOT ?? DEFAULT_STATE_ROOT;
  const nowMs = Date.now();
  const cohort = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyCore.cohort;
  const slotIndex = Math.floor((nowMs - cohort.startInclusiveMs) / cohort.slotCadenceMs);
  const identity = { policyDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyDigest, cohortDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.cohortDigest, slotIndex };
  const delivery = await githubDelivery({ currentMainSha, authorizedAtMs: activation.authorizedAtMs, slotIndex, observedAtMs: nowMs });
  const result = await runServerCanonicalNaturalTick({
    stateRoot,
    repository: REPOSITORY,
    nowMs,
    currentMainSha,
    activationBindingDigest: digest,
    cutoverReadiness: readiness,
    runtimeActivation: activation,
    serverRuntime: serverRuntime('canonical', currentMainSha),
    githubDelivery: delivery,
    observeGithubDelivery: async ({ slotIndex: capturedSlot }) => githubDelivery({
      currentMainSha,
      authorizedAtMs: activation.authorizedAtMs,
      slotIndex: capturedSlot,
      observedAtMs: Date.now(),
    }),
    canonicalCreditLedger: await canonicalLedger(stateRoot, identity),
    historicalShadowLedger: await historicalShadowLedger(stateRoot),
    baselineEvidence: baselineEvidence(),
    getRemoteMainSha: remoteMainSha,
  });
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    captureAllowed: result.captureAllowed,
    slotIndex: result.authority?.slotIndex ?? null,
    split: result.authority?.split ?? null,
    prospectiveSlotCredit: result.prospectiveSlotCredit ?? 0,
    canonicalEconomicCredit: result.canonicalEconomicCredit ?? 0,
    readyForProtectedCanonicalIngestGate: result.ingestHandoff?.readyForProtectedCanonicalIngestGate === true,
    persisted: result.persisted?.attemptRoot ?? null,
    blockers: result.blockers ?? [],
    executionAuthority: 'NONE',
  })}\n`);
}
async function selfCheck() {
  process.stdout.write(`${JSON.stringify({
    defaultEnabled: false,
    targetWorkflowId: TARGET_WORKFLOW_ID,
    requiredWorkflowId: REQUIRED_WORKFLOW_ID,
    requiredWorkflowPath: REQUIRED_WORKFLOW_PATH,
    sourcePrecedence: SERVER_CANONICAL_SOURCE_PRECEDENCE,
    baselineEvidence: baselineEvidence(),
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: 'NONE',
  })}\n`);
}

const mode = String(process.argv[2] ?? 'self-check').trim();
if (mode === 'self-check') await selfCheck();
else if (mode === 'prepare-activation') await prepareActivation();
else if (mode === 'tick') await tick();
else throw new Error('SERVER_CANONICAL_RUNNER_MODE_INVALID');
