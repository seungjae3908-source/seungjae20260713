#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIAGNOSTIC_SCHEMA_VERSION = 'paper-forward-no-deploy-readonly-diagnostic-v1';
export const PAPER_FORWARD_ROOT = '/opt/stock-app-data/paper-forward-v1';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const CRON_INTERVAL_MS = 15 * 60 * 1000;
const CRON_TAG = '# stock-app-paper-forward-v1';

function parseJson(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeIntegerOrNull(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function safeStatus(value) {
  const status = String(value ?? '').trim();
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(status) ? status : null;
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function parseInvocations(text, activationAtMs) {
  if (typeof text !== 'string') return { available: false, rows: [], invalidLineCount: null };
  const rows = [];
  let invalidLineCount = 0;
  for (const line of String(text ?? '').split(/\r?\n/).filter(Boolean)) {
    const value = parseJson(line);
    if (value == null) {
      invalidLineCount += 1;
      continue;
    }
    const invokedAtMs = finiteOrNull(value.invokedAtMs);
    if (value.triggerSource !== 'cron' || invokedAtMs == null || invokedAtMs < activationAtMs) continue;
    rows.push({
      invokedAtMs,
      completedAtMs: finiteOrNull(value.completedAtMs),
      status: safeStatus(value.status),
      mutationCount: nonNegativeIntegerOrNull(value.mutationCount),
      naturalScheduleInvocation: booleanOrNull(value.naturalScheduleInvocation),
      privateRequestCount: nonNegativeIntegerOrNull(value.privateRequestCount),
      financialMutationCount: nonNegativeIntegerOrNull(value.financialMutationCount),
      orderCount: nonNegativeIntegerOrNull(value.orderCount),
      liveTrading: booleanOrNull(value.liveTrading),
      orderAuthority: booleanOrNull(value.orderAuthority),
    });
  }
  rows.sort((left, right) => left.invokedAtMs - right.invokedAtMs);
  return { available: true, rows, invalidLineCount };
}

function inspectCronLog(text, activationAtMs, failedAtMs, metadata = {}) {
  const available = typeof text === 'string';
  const source = String(text ?? '');
  const markers = [];
  const markerPattern = /\[paper-forward-cron\] invoked_at=([^\s]+)/g;
  for (const match of source.matchAll(markerPattern)) {
    const atMs = Date.parse(match[1]);
    if (Number.isFinite(atMs) && atMs >= activationAtMs) markers.push({ atMs, index: match.index ?? 0 });
  }
  const relevantText = markers.length > 0 ? source.slice(markers[0].index) : '';
  const errorCodes = [...new Set(relevantText.match(/\bPAPER_FORWARD_[A-Z0-9_]{1,96}\b/g) ?? [])]
    .sort()
    .slice(0, 20);
  return {
    available,
    sizeBytes: available ? nonNegativeIntegerOrNull(metadata.sizeBytes) : null,
    modifiedAtMs: finiteOrNull(metadata.modifiedAtMs),
    sha256: available ? sha256(source) : null,
    invocationMarkerCountAfterActivation: available ? markers.length : null,
    invocationMarkerCountWithinFailureWindow: available
      ? markers.filter((item) => item.atMs <= failedAtMs).length
      : null,
    invocationMarkerCountAfterFailure: available ? markers.filter((item) => item.atMs > failedAtMs).length : null,
    firstInvocationMarkerAtMs: markers.at(0)?.atMs ?? null,
    latestInvocationMarkerAtMs: markers.at(-1)?.atMs ?? null,
    errorCodes: available ? errorCodes : null,
    rawLogIncluded: false,
  };
}

function inspectProcesses(text, targetSha) {
  const available = typeof text === 'string';
  const wrapper = `${PAPER_FORWARD_ROOT}/bin/run-paper-forward-schedule`;
  const runner = `${PAPER_FORWARD_ROOT}/releases/${targetSha}/market-prediction-lab/scripts/run-paper-forward-schedule.js`;
  const matches = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match || (!match[2].includes(wrapper) && !match[2].includes(runner))) continue;
    matches.push(Number(match[1]));
  }
  return {
    observationAvailable: available,
    matchingProcessCount: available ? matches.length : null,
    oldestElapsedSeconds: available && matches.length > 0 ? Math.max(...matches) : null,
    processArgumentsIncluded: false,
    processIdsIncluded: false,
  };
}

function inspectLocks(text) {
  const value = parseJson(text);
  const locks = Array.isArray(value?.locks) ? value.locks : [];
  const matching = locks.filter((lock) => String(lock?.path ?? lock?.PATH ?? '') === `${PAPER_FORWARD_ROOT}/cron.lock`);
  return {
    observationAvailable: value != null,
    cronLockHeld: value == null ? null : matching.length > 0,
    matchingLockCount: value == null ? null : matching.length,
    lockOwnerIncluded: false,
  };
}

function expectedCronTicks(activationAtMs, failedAtMs) {
  if (!Number.isFinite(activationAtMs) || !Number.isFinite(failedAtMs) || failedAtMs < activationAtMs) return 0;
  return Math.max(0, Math.floor(failedAtMs / CRON_INTERVAL_MS) - Math.floor(activationAtMs / CRON_INTERVAL_MS));
}

function classify({ activation, invocationsAvailable, invocationRows, cronLog, processes, lock }) {
  if (activation.available !== true) return 'ACTIVATION_EVIDENCE_UNAVAILABLE';
  if (activation.targetShaMatches !== true) return 'SERVER_ACTIVATION_TARGET_MISMATCH';
  const latest = invocationRows.at(-1);
  if (latest) {
    if (latest.completedAtMs != null && latest.completedAtMs > activation.failedAtMs) {
      return 'LATE_COMPLETION_AFTER_ACTIVATION_TIMEOUT';
    }
    if (latest.status !== 'COMPLETED') return 'NON_COMPLETED_INVOCATION_RECORDED';
    return 'COMPLETED_INVOCATION_PRESENT_BUT_GATE_REJECTED';
  }
  if (processes.matchingProcessCount > 0 || lock.cronLockHeld) return 'RUNTIME_IN_FLIGHT_OR_LOCKED';
  if (cronLog.invocationMarkerCountAfterActivation > 0 && cronLog.errorCodes?.length > 0) {
    return 'CRON_RUNTIME_FAILED_BEFORE_INVOCATION_RECORD';
  }
  if (cronLog.invocationMarkerCountAfterActivation > 0) return 'CRON_EXITED_OR_STALLED_BEFORE_INVOCATION_RECORD';
  if (cronLog.available !== true || invocationsAvailable !== true) return 'INSUFFICIENT_RUNTIME_EVIDENCE';
  return 'CRON_NOT_INVOKED_WITHIN_OBSERVED_LOG';
}

export function buildPaperForwardNoDeployDiagnostics({
  targetSha,
  failedRunId,
  failedAtMs,
  observedAtMs = Date.now(),
  observation = {},
}) {
  if (!SHA_PATTERN.test(String(targetSha ?? ''))) throw new Error('exact lowercase 40-character target SHA required');
  if (!Number.isSafeInteger(Number(failedRunId)) || Number(failedRunId) <= 0) throw new Error('positive failed run ID required');
  if (!Number.isFinite(Number(failedAtMs)) || Number(failedAtMs) <= 0) throw new Error('failed timestamp required');

  const activationValue = parseJson(observation.activationText);
  const activationAtMs = finiteOrNull(activationValue?.activationAtMs);
  const safeActivationAtMs = activationAtMs ?? Number(failedAtMs);
  const activation = {
    available: activationValue != null,
    status: safeStatus(activationValue?.status),
    targetShaMatches: activationValue == null ? null : activationValue.targetSha === targetSha,
    paperRuntimeSourceShaMatches: activationValue == null ? null : activationValue.paperRuntimeSourceSha === targetSha,
    activationAtMs,
    failedAtMs: Number(failedAtMs),
    scheduleActiveRecorded: activationValue == null ? null : booleanOrNull(activationValue.scheduleActive),
    productionAppDeployPerformed: activationValue == null
      ? null
      : booleanOrNull(activationValue.productionAppDeployPerformed),
    productionAppMutationAllowed: activationValue == null
      ? null
      : booleanOrNull(activationValue.productionAppMutationAllowed),
  };
  const invocations = parseInvocations(observation.invocationsText, safeActivationAtMs);
  const cronLog = inspectCronLog(
    observation.cronLogText,
    safeActivationAtMs,
    Number(failedAtMs),
    observation.cronLogMetadata,
  );
  const processes = inspectProcesses(observation.processText, targetSha);
  const lock = inspectLocks(observation.locksText);
  const stateValue = parseJson(observation.stateText);
  const statusValue = parseJson(observation.statusText);
  const disabledValue = parseJson(observation.disabledText);
  const crontabText = observation.crontabText;
  const cronEntryCount = typeof crontabText === 'string'
    ? crontabText.split(/\r?\n/).filter((line) => line.includes(CRON_TAG)).length
    : null;
  const latestInvocation = invocations.rows.at(-1) ?? null;

  const evidence = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    status: 'collected',
    mode: 'read-only',
    targetSha,
    failedActivationRunId: Number(failedRunId),
    observedAtMs: Number(observedAtMs),
    activation,
    schedule: {
      expectedCronTicksWithinFailureWindow: activationAtMs == null
        ? null
        : expectedCronTicks(activationAtMs, Number(failedAtMs)),
      crontabObservationAvailable: typeof crontabText === 'string',
      managedCronEntryCount: cronEntryCount,
      rootDisabledSentinelObservationAvailable: observation.rootDisabledSentinel?.observationAvailable === true,
      rootDisabledSentinelPresent: observation.rootDisabledSentinel?.present ?? null,
      runtimeDisabledSentinelObservationAvailable: observation.runtimeDisabledSentinel?.observationAvailable === true,
      runtimeDisabledSentinelPresent: observation.runtimeDisabledSentinel?.present ?? null,
      disabledStatus: safeStatus(disabledValue?.status),
    },
    cronLog,
    runtimeProcess: processes,
    cronLock: lock,
    invocations: {
      observationAvailable: invocations.available,
      recordCountAfterActivation: invocations.available ? invocations.rows.length : null,
      invalidLineCount: invocations.invalidLineCount,
      latest: latestInvocation,
    },
    state: {
      available: stateValue != null,
      researchCodeSha: SHA_PATTERN.test(String(stateValue?.identity?.researchCodeSha ?? ''))
        ? stateValue.identity.researchCodeSha
        : null,
      targetIdentityMatches: stateValue == null ? null : stateValue?.identity?.researchCodeSha === targetSha,
      cycleCount: Array.isArray(stateValue?.cycles) ? stateValue.cycles.length : null,
      positionCount: Array.isArray(stateValue?.positions) ? stateValue.positions.length : null,
      settlementCount: Array.isArray(stateValue?.settlements) ? stateValue.settlements.length : null,
    },
    runtimeStatus: {
      available: statusValue != null,
      status: safeStatus(statusValue?.status),
      scheduleActive: statusValue == null ? null : statusValue.scheduleActive === true,
      allProvidersReady: statusValue == null ? null : statusValue.allProvidersReady === true,
      providerLaneCount: Array.isArray(statusValue?.lanes) ? statusValue.lanes.length : null,
      readyProviderLaneCount: Array.isArray(statusValue?.lanes)
        ? statusValue.lanes.filter((lane) => lane?.status === 'READY').length
        : null,
      simulatedFinancialAdaptersEnabled: statusValue == null
        ? null
        : statusValue.simulatedFinancialAdaptersEnabled === true,
      externalFinancialMutationAllowed: statusValue == null
        ? null
        : statusValue.externalFinancialMutationAllowed === true,
    },
    productionApp: {
      deployedSha: SHA_PATTERN.test(String(observation.productionAppSha ?? ''))
        ? observation.productionAppSha
        : null,
    },
    classification: null,
    safety: {
      remoteMutationPerformed: false,
      databaseMutationPerformed: false,
      secretMutationPerformed: false,
      environmentMutationPerformed: false,
      productionAppDeployPerformed: false,
      paperScheduleMutationPerformed: false,
      privateTradingApiUsed: false,
      liveTradingPerformed: false,
      realOrderPerformed: false,
      rawLogsIncluded: false,
      credentialsIncluded: false,
    },
  };
  evidence.classification = classify({
    activation,
    invocationsAvailable: invocations.available,
    invocationRows: invocations.rows,
    cronLog,
    processes,
    lock,
  });
  return evidence;
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function metadata(path) {
  try {
    const value = statSync(path);
    return { sizeBytes: value.size, modifiedAtMs: value.mtimeMs };
  } catch {
    return {};
  }
}

function presence(path) {
  try {
    statSync(path);
    return { observationAvailable: true, present: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { observationAvailable: true, present: false };
    return { observationAvailable: false, present: null };
  }
}

function commandText(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

export function collectPaperForwardNoDeployDiagnostics({ targetSha, failedRunId, failedAtMs }) {
  const root = PAPER_FORWARD_ROOT;
  const cronLogPath = `${root}/logs/cron.log`;
  return buildPaperForwardNoDeployDiagnostics({
    targetSha,
    failedRunId,
    failedAtMs,
    observation: {
      activationText: readText(`${root}/activation.json`),
      invocationsText: readText(`${root}/runtime-state/status/invocations.jsonl`),
      stateText: readText(`${root}/runtime-state/state/recurring-paper-loop.json`),
      statusText: readText(`${root}/runtime-state/status/runtime-status.json`),
      disabledText: readText(`${root}/disabled.json`),
      cronLogText: readText(cronLogPath),
      cronLogMetadata: metadata(cronLogPath),
      productionAppSha: readText('/opt/stock-app/.deploy/current-sha')?.trim() ?? null,
      crontabText: commandText('crontab', ['-l']),
      processText: commandText('ps', ['-eo', 'etimes=,args=']),
      locksText: commandText('lslocks', ['--json', '--output', 'PATH']),
      rootDisabledSentinel: presence(`${root}/DISABLED`),
      runtimeDisabledSentinel: presence(`${root}/runtime-state/DISABLED`),
    },
  });
}

async function main() {
  const [targetSha, failedRunIdRaw, failedAtMsRaw] = process.argv.slice(2);
  const evidence = collectPaperForwardNoDeployDiagnostics({
    targetSha,
    failedRunId: Number(failedRunIdRaw),
    failedAtMs: Number(failedAtMsRaw),
  });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

const invokedAsFile = process.argv[1] === '-'
  || (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (invokedAsFile) {
  main().catch((error) => {
    process.stderr.write(`[paper-forward-readonly-diagnostic] ${error?.message ?? 'failed'}\n`);
    process.exitCode = 1;
  });
}
