#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { canonicalJson, sha256 } from '../src/public-forward-liquidity-calibration.mjs';
import {
  prepareProtectedServerCanonicalActivation,
  verifyProtectedServerCanonicalActivationRecord,
} from '../src/public-forward-liquidity-server-canonical-activation-v1.mjs';
import {
  buildServerCanonicalCreditKey,
  buildServerCanonicalRuntimeSelfCheck,
  runServerCanonicalNaturalTick,
} from '../src/public-forward-liquidity-server-canonical-runtime-v1.mjs';
import {
  SERVER_CANONICAL_SOURCE_PRECEDENCE,
} from '../src/public-forward-liquidity-server-canonical-cutover-readiness-v1.mjs';
import {
  resolveServerEvidenceNtpSynchronization,
} from '../src/public-forward-liquidity-server-shadow-worker-v1.mjs';
import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
  buildSuccessorScheduleReliabilityV3SlotDescriptor,
} from '../src/public-forward-liquidity-successor-schedule-reliability-v3.mjs';

const mode = String(process.argv[2] ?? 'self-check').trim();
const REPOSITORY = process.env.SERVER_EVIDENCE_REPOSITORY
  ?? 'seungjae3908-source/seungjae20260713';
const TARGET_WORKFLOW_ID = 347888347;
const REQUIRED_WORKFLOW_ID = 325169344;
const REQUIRED_CONTEXTS = Object.freeze([
  'application-ci/verified',
  'browser-ui/verified',
  'database-rls/verified',
  'security-integration/verified',
  'ai-privacy/verified',
  'futures-public-network-smoke/verified',
]);

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
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(code);
  return parsed;
}

function bool(value, code) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(code);
}

function canonicalStateRoot() {
  return resolve(process.env.SERVER_EVIDENCE_STATE_ROOT
    ?? '/var/lib/stock-app-server-evidence-canonical-v1');
}

function shadowStateRoot() {
  return resolve(process.env.SERVER_EVIDENCE_SHADOW_STATE_ROOT
    ?? '/var/lib/stock-app-server-evidence-shadow-v1');
}

function activationPath() {
  return resolve(process.env.SERVER_EVIDENCE_CANONICAL_ACTIVATION_PATH
    ?? '/opt/stock-app-server-evidence-canonical-v1/activation.json');
}

async function writeCreateOnly(path, value) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function githubJson(path) {
  const url = `https://api.github.com/repos/${REPOSITORY}${path}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'stock-app-public-forward-server-canonical-v1',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`SERVER_CANONICAL_GITHUB_HTTP_${response.status}`);
  return response.json();
}

async function remoteMainSha() {
  const branch = await githubJson('/branches/main');
  return exactSha(branch?.commit?.sha, 'SERVER_CANONICAL_REMOTE_MAIN_INVALID');
}

async function githubIssueComment(commentId) {
  const id = positiveInteger(commentId, 'SERVER_CANONICAL_GITHUB_COMMENT_ID_INVALID');
  return githubJson(`/issues/comments/${id}`);
}

function issueNumberFromComment(comment, code) {
  const issueUrl = String(comment?.issue_url ?? '').trim();
  const match = issueUrl.match(/\/issues\/([1-9][0-9]*)(?:\/)?$/u);
  if (!match) throw new Error(code);
  return positiveInteger(match[1], code);
}

async function verifyProtectedAuthorityComments({
  targetSha,
  activationReceiptCommentId,
  bindingDigest,
  authorityCommentId,
  authorizedAtMs,
} = {}) {
  const [receipt, authority] = await Promise.all([
    githubIssueComment(activationReceiptCommentId),
    githubIssueComment(authorityCommentId),
  ]);
  const owner = REPOSITORY.split('/')[0];
  const receiptBody = [
    '/authorize-public-only-partial-fill-v3-schedule-activation',
    targetSha,
    bindingDigest,
  ].join(' ');
  if (Number(receipt?.id) !== activationReceiptCommentId
    || receipt?.user?.login !== owner
    || receipt?.author_association !== 'OWNER'
    || String(receipt?.body ?? '').trim() !== receiptBody) {
    throw new Error('SERVER_CANONICAL_V3_OWNER_RECEIPT_INVALID');
  }

  const authorityBody = [
    '/activate-public-forward-liquidity-server-canonical-v1',
    targetSha,
    String(activationReceiptCommentId),
    bindingDigest,
  ].join(' ');
  if (Number(authority?.id) !== authorityCommentId
    || authority?.user?.login !== owner
    || authority?.author_association !== 'OWNER'
    || String(authority?.body ?? '').trim() !== authorityBody
    || Date.parse(authority?.created_at ?? '') !== authorizedAtMs) {
    throw new Error('SERVER_CANONICAL_OWNER_CUTOVER_AUTHORITY_INVALID');
  }

  const receiptIssueNumber = issueNumberFromComment(
    receipt,
    'SERVER_CANONICAL_V3_OWNER_RECEIPT_ISSUE_INVALID',
  );
  const authorityIssueNumber = issueNumberFromComment(
    authority,
    'SERVER_CANONICAL_OWNER_CUTOVER_AUTHORITY_ISSUE_INVALID',
  );
  if (receiptIssueNumber !== authorityIssueNumber) {
    throw new Error('SERVER_CANONICAL_AUTHORITY_ISSUE_MISMATCH');
  }
  const releaseControl = await githubJson(`/issues/${receiptIssueNumber}`);
  const releaseControlTitle = String(releaseControl?.title ?? '');
  const validReleaseControlTitle = releaseControlTitle === 'Staging Readiness Control'
    || releaseControlTitle.startsWith('Staging Readiness Control — Rollover ');
  if (releaseControl?.state !== 'open'
    || releaseControl?.pull_request
    || !validReleaseControlTitle) {
    throw new Error('SERVER_CANONICAL_RELEASE_CONTROL_INVALID');
  }

  const since = encodeURIComponent(receipt?.created_at ?? '');
  let page = 1;
  let latest = null;
  while (page <= 20) {
    const response = await githubJson(
      `/issues/${receiptIssueNumber}/comments?since=${since}&per_page=100&page=${page}`,
    );
    if (!Array.isArray(response)) {
      throw new Error('SERVER_CANONICAL_RELEASE_COMMENTS_INVALID');
    }
    for (const comment of response) {
      if (comment?.user?.login !== owner || comment?.author_association !== 'OWNER') continue;
      const parts = String(comment?.body ?? '').trim().split(/\s+/u);
      if (parts.length !== 3
        || ![
          '/authorize-public-only-partial-fill-v3-schedule-activation',
          '/revoke-public-only-partial-fill-v3-schedule-activation',
        ].includes(parts[0])
        || parts[1] !== targetSha
        || parts[2] !== bindingDigest) continue;
      latest = {
        commentId: Number(comment.id),
        action: parts[0].startsWith('/authorize-') ? 'AUTHORIZE' : 'REVOKE',
      };
    }
    if (response.length < 100) break;
    page += 1;
  }
  if (!latest
    || latest.commentId !== activationReceiptCommentId
    || latest.action !== 'AUTHORIZE') {
    throw new Error('SERVER_CANONICAL_V3_OWNER_RECEIPT_NOT_LATEST');
  }
  return Object.freeze({
    receipt,
    authority,
    issueNumber: receiptIssueNumber,
    issueTitle: releaseControlTitle,
    releaseControlOpen: true,
  });
}

async function requiredCi(targetSha) {
  const combined = await githubJson(`/commits/${targetSha}/status?per_page=100`);
  const statuses = Array.isArray(combined?.statuses) ? [...combined.statuses] : [];
  statuses.sort((left, right) => Number(right.id) - Number(left.id));
  const latest = new Map();
  for (const status of statuses) if (!latest.has(status.context)) latest.set(status.context, status);
  const contexts = {};
  const runIds = new Set();
  for (const name of REQUIRED_CONTEXTS) {
    const status = latest.get(name);
    contexts[name] = status?.state ?? null;
    const match = String(status?.target_url ?? '').match(/\/actions\/runs\/(\d+)/u);
    if (match) runIds.add(Number(match[1]));
  }
  if (runIds.size !== 1) throw new Error('SERVER_CANONICAL_REQUIRED_CI_NOT_COHERENT');
  const runId = [...runIds][0];
  const run = await githubJson(`/actions/runs/${runId}`);
  return Object.freeze({
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
  });
}

async function githubDeliveryObservation({
  currentMainSha,
  authorizedAtMs,
  slotIndex = null,
  observedAtMs = Date.now(),
} = {}) {
  const [workflow, targetResponse, repoResponse] = await Promise.all([
    githubJson(`/actions/workflows/${TARGET_WORKFLOW_ID}`),
    githubJson(`/actions/workflows/${TARGET_WORKFLOW_ID}/runs?event=schedule&branch=main&per_page=100`),
    githubJson('/actions/runs?event=schedule&branch=main&per_page=100'),
  ]);
  const targetRuns = Array.isArray(targetResponse?.workflow_runs)
    ? targetResponse.workflow_runs.filter((run) => run.event === 'schedule')
    : [];
  targetRuns.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  const latestTarget = targetRuns[0] ?? null;
  if (!latestTarget) throw new Error('SERVER_CANONICAL_GITHUB_TARGET_SCHEDULE_HISTORY_MISSING');
  const repositoryRuns = Array.isArray(repoResponse?.workflow_runs)
    ? repoResponse.workflow_runs.filter((run) => run.event === 'schedule')
    : [];
  repositoryRuns.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  const latestHealthy = repositoryRuns.find((run) =>
    Number(run.workflow_id) !== TARGET_WORKFLOW_ID && run.head_sha === currentMainSha) ?? null;
  if (!latestHealthy) throw new Error('SERVER_CANONICAL_REPOSITORY_SCHEDULE_HEALTH_MISSING');

  const currentMainRuns = targetRuns.filter((run) => run.head_sha === currentMainSha);
  const sinceAuthority = positiveInteger(authorizedAtMs, 'SERVER_CANONICAL_AUTHORIZED_AT_INVALID');
  const afterAuthority = currentMainRuns.filter((run) => Date.parse(run.created_at) >= sinceAuthority);
  let sameSlot = [];
  if (Number.isSafeInteger(slotIndex) && slotIndex >= 0) {
    const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(slotIndex);
    sameSlot = currentMainRuns.filter((run) => {
      const created = Date.parse(run.created_at);
      return created >= slot.nominalScheduledAtMs && created < slot.slotEndExclusiveMs;
    });
  }
  return Object.freeze({
    targetWorkflowId: TARGET_WORKFLOW_ID,
    targetWorkflowState: workflow.state,
    targetLatestScheduleWorkflowId: Number(latestTarget.workflow_id),
    targetLatestScheduleEvent: latestTarget.event,
    targetLatestScheduleHeadSha: latestTarget.head_sha,
    targetLatestScheduleCreatedAtMs: Date.parse(latestTarget.created_at),
    targetCurrentMainScheduleRunCount: currentMainRuns.length,
    targetScheduleRunCountSinceCutoverAuthority: afterAuthority.length,
    targetSameSlotScheduleRunCount: sameSlot.length,
    targetRecoveryObserved: afterAuthority.length > 0 || sameSlot.length > 0,
    repositoryLatestScheduleCreatedAtMs: Date.parse(latestHealthy.created_at),
    repositoryLatestScheduleWorkflowId: Number(latestHealthy.workflow_id),
    repositoryLatestScheduleEvent: latestHealthy.event,
    repositoryLatestScheduleHeadSha: latestHealthy.head_sha,
    observedAtMs,
  });
}

function ntpSynchronized() {
  let output;
  try {
    output = execFileSync('/usr/bin/timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], {
      encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'],
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

function systemctl(...args) {
  return execFileSync('/usr/bin/systemctl', args, {
    encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function deployedSha(path) {
  return exactSha(await readFile(path, 'utf8'), 'SERVER_CANONICAL_DEPLOYED_SHA_INVALID');
}

async function allShadowReceipts() {
  const root = join(shadowStateRoot(), 'slots');
  let slots;
  try { slots = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const receipts = [];
  for (const slot of slots) {
    if (!slot.isDirectory()) continue;
    const slotPath = join(root, slot.name);
    const attempts = await readdir(slotPath, { withFileTypes: true });
    for (const attempt of attempts) {
      if (!attempt.isDirectory()) continue;
      const path = join(slotPath, attempt.name, 'shadow-receipt.json');
      try { receipts.push(await readJson(path)); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  }
  return receipts;
}

async function shadowEvidenceSnapshot({ targetSha, receiptCommentId, bindingDigest } = {}) {
  const receipts = await allShadowReceipts();
  for (const receipt of receipts) {
    const { receiptDigest, ...body } = receipt ?? {};
    if (receipt?.shadowOnly !== true
      || receipt?.serverCanonical !== false
      || receipt?.prospectiveSlotCredit !== 0
      || receipt?.canonicalEconomicCredit !== 0
      || receipt?.economicSampleCredit !== 0
      || receipt?.profitabilityCredit !== 0
      || receipt?.replayCredit !== 0
      || receipt?.backfillCredit !== 0
      || receipt?.manualCredit !== 0
      || receipt?.syntheticCredit !== 0
      || receipt?.hindsightCredit !== 0
      || receipt?.fullCostReady !== false
      || receipt?.evidenceComplete !== 0
      || receipt?.profitabilityProven !== false
      || receipt?.liveTrading !== false
      || receipt?.autoTrading !== false
      || receipt?.realOrderEnabled !== false
      || receipt?.privateTradingApiAllowed !== false
      || receipt?.executionAuthority !== 'NONE'
      || !/^[a-f0-9]{64}$/u.test(String(receiptDigest ?? ''))
      || receiptDigest !== sha256(canonicalJson(body))) {
      throw new Error('SERVER_CANONICAL_HISTORICAL_SHADOW_ZERO_CREDIT_UNPROVEN');
    }
  }
  const eligible = receipts.filter((receipt) =>
    receipt?.captureStatus === 'PRESENT_SHADOW'
    && receipt?.codeSha === targetSha
    && receipt?.activationReceiptMainSha === targetSha
    && receipt?.activationReceiptCommentId === receiptCommentId
    && receipt?.activationBindingDigest === bindingDigest
    && Array.isArray(receipt?.blockers)
    && receipt.blockers.length === 0
  ).sort((left, right) => Number(right.serverStartedAtMs) - Number(left.serverStartedAtMs));
  if (eligible.length === 0) throw new Error('SERVER_CANONICAL_CURRENT_MAIN_SHADOW_RECEIPT_MISSING');
  return Object.freeze({
    latest: eligible[0],
    historicalShadowLedger: Object.freeze({
      lookupComplete: true,
      canonicalCreditN: 0,
      retroactivePromotionPerformed: false,
    }),
  });
}

async function matchingCanonicalReceipts(creditKeyDigest) {
  const root = join(canonicalStateRoot(), 'server-canonical-v1', 'slots');
  let slots;
  try { slots = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const matches = [];
  for (const slot of slots) {
    if (!slot.isDirectory()) continue;
    const attempts = await readdir(join(root, slot.name), { withFileTypes: true });
    for (const attempt of attempts) {
      if (!attempt.isDirectory()) continue;
      const path = join(root, slot.name, attempt.name, 'server-canonical-receipt.json');
      try {
        const receipt = await readJson(path);
        if (receipt?.creditKeyDigest === creditKeyDigest
          && receipt?.canonicalSource === 'SERVER_NATURAL_TIMER') matches.push(receipt);
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  }
  return matches;
}

function baselineEvidence() {
  return Object.freeze({
    canonicalTrainReceiptN: 4,
    independentN: 4,
    validationN: 0,
    oosN: 0,
    retroactiveRecomputePerformed: false,
    historicalShadowPromotionPerformed: false,
  });
}

async function prepareActivation() {
  const targetSha = exactSha(process.env.SERVER_EVIDENCE_TARGET_SHA, 'SERVER_CANONICAL_TARGET_SHA_INVALID');
  const activationReceiptCommentId = positiveInteger(
    process.env.SERVER_EVIDENCE_ACTIVATION_RECEIPT_COMMENT_ID,
    'SERVER_CANONICAL_RECEIPT_COMMENT_ID_INVALID',
  );
  const bindingDigest = exactDigest(
    process.env.SERVER_EVIDENCE_EXPECTED_BINDING_DIGEST,
    'SERVER_CANONICAL_BINDING_DIGEST_INVALID',
  );
  const authorityCommentId = positiveInteger(
    process.env.SERVER_EVIDENCE_CANONICAL_AUTHORITY_COMMENT_ID,
    'SERVER_CANONICAL_AUTHORITY_COMMENT_ID_INVALID',
  );
  const authorizedAtMs = positiveInteger(
    process.env.SERVER_EVIDENCE_CANONICAL_AUTHORIZED_AT_MS,
    'SERVER_CANONICAL_AUTHORIZED_AT_INVALID',
  );
  const remote = await remoteMainSha();
  if (remote !== targetSha) throw new Error('SERVER_CANONICAL_MAIN_MOVED_BEFORE_ACTIVATION');
  const authorityEvidence = await verifyProtectedAuthorityComments({
    targetSha,
    activationReceiptCommentId,
    bindingDigest,
    authorityCommentId,
    authorizedAtMs,
  });
  const ci = await requiredCi(targetSha);
  if (ci.workflowId !== REQUIRED_WORKFLOW_ID) throw new Error('SERVER_CANONICAL_REQUIRED_CI_WORKFLOW_INVALID');
  const shadow = await shadowEvidenceSnapshot({
    targetSha,
    receiptCommentId: activationReceiptCommentId,
    bindingDigest,
  });
  const timerUnit = 'public-forward-liquidity-server-shadow-worker-v1.timer';
  const serviceUnit = 'public-forward-liquidity-server-shadow-worker-v1.service';
  const timerEnabled = systemctl('is-enabled', timerUnit) === 'enabled';
  const timerActive = systemctl('is-active', timerUnit) === 'active';
  const deployed = await deployedSha('/opt/stock-app-server-evidence-shadow-v1/current/.deploy/current-sha');
  const serverRuntime = Object.freeze({
    deployedSha: deployed,
    timerEnabled,
    timerActive,
    persistent: false,
    timerUnit,
    serviceUnit,
    timerTimezone: 'UTC',
    onCalendarUtc: ['*-*-* *:17:00 UTC', '*-*-* *:27:00 UTC', '*-*-* *:37:00 UTC'],
    accuracySec: 1,
    randomizedDelaySec: 0,
    ntpSynchronized: ntpSynchronized(),
    shadowOnly: true,
    serverCanonical: false,
    receiptPersistence: 'CREATE_ONLY_WX',
    productionAppMutationPerformed: false,
    manualCapturePerformed: false,
    executionAuthority: 'NONE',
    triggerMinutesUtc: [17, 27, 37],
  });
  const githubDelivery = await githubDeliveryObservation({
    currentMainSha: targetSha,
    authorizedAtMs,
  });
  const activationCreditKey = buildServerCanonicalCreditKey({
    policyDigest: shadow.latest.policyDigest,
    cohortDigest: shadow.latest.cohortDigest,
    slotIndex: shadow.latest.slotIndex,
  });
  const canonicalCreditLedger = Object.freeze({
    lookupComplete: true,
    sourcePrecedence: [...SERVER_CANONICAL_SOURCE_PRECEDENCE],
    creditKey: activationCreditKey.key,
    matchingCanonicalCredits: await matchingCanonicalReceipts(
      activationCreditKey.keyDigest,
    ),
    maximumCanonicalEconomicCredit: 1,
  });
  const latestActivationReceipt = Object.freeze({
    issueNumber: authorityEvidence.issueNumber,
    issueTitle: authorityEvidence.issueTitle,
    releaseControlOpen: authorityEvidence.releaseControlOpen,
    action: 'AUTHORIZE',
    targetMainSha: targetSha,
    activationBindingDigest: bindingDigest,
    commentId: activationReceiptCommentId,
    authorAssociation: authorityEvidence.receipt.author_association,
    actorLogin: authorityEvidence.receipt.user.login,
    body: String(authorityEvidence.receipt.body ?? '').trim(),
    latestForTargetBinding: true,
  });
  const record = prepareProtectedServerCanonicalActivation({
    currentMainSha: targetSha,
    activationBindingDigest: bindingDigest,
    latestActivationReceipt,
    requiredCi: ci,
    githubDelivery,
    serverRuntime,
    shadowReceipt: shadow.latest,
    canonicalCreditLedger,
    activationReceiptCommentId,
    authorityCommentId,
    authorizedAtMs,
    runtimeActivatedAtMs: Date.now(),
    baselineEvidence: baselineEvidence(),
    historicalShadowLedger: shadow.historicalShadowLedger,
  });
  await mkdir(resolve(activationPath(), '..'), { recursive: true, mode: 0o755 });
  await writeCreateOnly(activationPath(), record);
  process.stdout.write(`${JSON.stringify({
    status: 'PROTECTED_CANONICAL_ACTIVATION_RECORD_READY',
    targetSha,
    activationReceiptCommentId,
    authorityCommentId,
    cutoverAuthorizedAtMs: record.authorizedAtMs,
    runtimeActivatedAtMs: record.runtimeActivatedAtMs,
    firstEligibleSlotIndex: record.firstEligibleSlotIndex,
    recordDigest: record.recordDigest,
    shadowReceiptDigest: shadow.latest.receiptDigest,
    githubObservedAtMs: githubDelivery.observedAtMs,
    canonicalEconomicCredit: 0,
    executionAuthority: 'NONE',
  })}\n`);
}

async function readActivationRecord() {
  const record = await readJson(activationPath());
  const verdict = verifyProtectedServerCanonicalActivationRecord(record);
  if (!verdict.valid) throw new Error(`SERVER_CANONICAL_ACTIVATION_RECORD_INVALID:${verdict.blockers.join(',')}`);
  return record;
}

async function selfCheck() {
  const runtime = buildServerCanonicalRuntimeSelfCheck();
  process.stdout.write(`${JSON.stringify({
    ...runtime,
    protectedActivationRecordRequired: true,
    publicGithubOnly: true,
    privateTradingApiAllowed: false,
    executionAuthority: 'NONE',
  })}\n`);
}

async function tick() {
  const record = await readActivationRecord();
  const deployFile = process.env.SERVER_EVIDENCE_DEPLOY_SHA_FILE
    ?? '/opt/stock-app-server-evidence-canonical-v1/current/.deploy/current-sha';
  const deployed = await deployedSha(deployFile);
  if (deployed !== record.targetMainSha) throw new Error('SERVER_CANONICAL_DEPLOYED_SHA_MISMATCH');
  const remote = await remoteMainSha();
  if (remote !== record.targetMainSha) {
    process.stdout.write(`${JSON.stringify({
      status: 'NO_CAPTURE_NO_CREDIT',
      blockers: ['SERVER_CANONICAL_REMOTE_MAIN_MOVED'],
      canonicalEconomicCredit: 0,
      executionAuthority: 'NONE',
    })}\n`);
    return;
  }
  const nowMs = Date.now();
  const cohort = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyCore.cohort;
  const slotIndex = Math.floor((nowMs - cohort.startInclusiveMs) / cohort.slotCadenceMs);
  const githubDelivery = await githubDeliveryObservation({
    currentMainSha: record.targetMainSha,
    authorizedAtMs: record.authorizedAtMs,
    slotIndex,
    observedAtMs: Date.now(),
  });
  const creditKey = buildServerCanonicalCreditKey({
    policyDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyDigest,
    cohortDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.cohortDigest,
    slotIndex,
  });
  const matches = await matchingCanonicalReceipts(creditKey.keyDigest);
  const canonicalCreditLedger = Object.freeze({
    lookupComplete: true,
    creditKeyDigest: creditKey.keyDigest,
    matchingCanonicalCredits: matches,
  });
  const serverRuntime = Object.freeze({
    deployedSha: deployed,
    timerEnabled: true,
    timerActive: true,
    persistent: false,
    ntpSynchronized: ntpSynchronized(),
    serverCanonical: bool(process.env.SERVER_EVIDENCE_SERVER_CANONICAL ?? 'true', 'SERVER_CANONICAL_ENV_INVALID'),
    shadowOnly: bool(process.env.SERVER_EVIDENCE_SHADOW_ONLY ?? 'false', 'SERVER_CANONICAL_SHADOW_ENV_INVALID'),
    receiptPersistence: 'CREATE_ONLY_WX',
    manualCapturePerformed: false,
    productionAppMutationPerformed: false,
    executionAuthority: 'NONE',
  });
  const result = await runServerCanonicalNaturalTick({
    stateRoot: canonicalStateRoot(),
    repository: REPOSITORY,
    nowMs,
    currentMainSha: record.targetMainSha,
    activationBindingDigest: record.activationBindingDigest,
    cutoverReadiness: record.cutoverReadiness,
    runtimeActivation: record.runtimeActivation,
    serverRuntime,
    githubDelivery,
    observeGithubDelivery: async ({ slotIndex: observedSlotIndex }) => githubDeliveryObservation({
      currentMainSha: record.targetMainSha,
      authorizedAtMs: record.authorizedAtMs,
      slotIndex: observedSlotIndex,
      observedAtMs: Date.now(),
    }),
    canonicalCreditLedger,
    historicalShadowLedger: record.historicalShadowLedger,
    baselineEvidence: record.baselineEvidence,
    getRemoteMainSha: remoteMainSha,
  });
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    blockers: result.blockers,
    slotIndex: result.authority?.slotIndex ?? null,
    split: result.authority?.split ?? null,
    collectorInvoked: result.collectorInvoked === true,
    prospectiveSlotCredit: result.prospectiveSlotCredit ?? 0,
    canonicalEconomicCredit: 0,
    canonicalIngestPerformed: false,
    independencePerformed: false,
    serverReceiptDigest: result.serverReceipt?.receiptDigest ?? null,
    ingestHandoffReady: result.ingestHandoff?.readyForProtectedCanonicalIngestGate === true,
    executionAuthority: 'NONE',
  })}\n`);
}

async function status() {
  const record = await readActivationRecord();
  const root = join(canonicalStateRoot(), 'server-canonical-v1', 'slots');
  let slotN = 0;
  let receiptN = 0;
  try {
    const slots = await readdir(root, { withFileTypes: true });
    for (const slot of slots) {
      if (!slot.isDirectory()) continue;
      slotN += 1;
      const attempts = await readdir(join(root, slot.name), { withFileTypes: true });
      for (const attempt of attempts) {
        if (!attempt.isDirectory()) continue;
        if (existsSync(join(root, slot.name, attempt.name, 'server-canonical-receipt.json'))) receiptN += 1;
      }
    }
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  process.stdout.write(`${JSON.stringify({
    status: 'ACTIVE_PROTECTED_CANONICAL_RUNTIME',
    targetSha: record.targetMainSha,
    cutoverAuthorizedAtMs: record.authorizedAtMs,
    runtimeActivatedAtMs: record.runtimeActivatedAtMs,
    firstEligibleSlotIndex: record.firstEligibleSlotIndex,
    activationRecordDigest: record.recordDigest,
    canonicalSlotDirectoryN: slotN,
    canonicalReceiptN: receiptN,
    canonicalEconomicCredit: 0,
    canonicalIngestPerformed: false,
    executionAuthority: 'NONE',
  })}\n`);
}

try {
  if (mode === 'self-check') await selfCheck();
  else if (mode === 'prepare-activation') await prepareActivation();
  else if (mode === 'tick') await tick();
  else if (mode === 'status') await status();
  else throw new Error('SERVER_CANONICAL_RUNNER_MODE_INVALID');
} catch (error) {
  const code = String(error?.message ?? 'SERVER_CANONICAL_UNKNOWN_ERROR');
  process.stderr.write(`${JSON.stringify({
    status: 'FAILED_CLOSED',
    blocker: code,
    canonicalEconomicCredit: 0,
    canonicalIngestPerformed: false,
    independencePerformed: false,
    executionAuthority: 'NONE',
  })}\n`);
  process.exitCode = 1;
}
