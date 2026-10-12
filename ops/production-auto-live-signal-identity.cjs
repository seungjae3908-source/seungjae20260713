'use strict';
const { createHash } = require('node:crypto');
// Shared with GitHub receipt checks. This file must live in ops because the
// deployed runtime deliberately excludes the .github directory.

const MARKETS = ['CRYPTO_FUTURES', 'CRYPTO_SPOT', 'KR_STOCK', 'US_STOCK'];
function inspectSignalEntryIdentity(entries, targetSha) {
  if (!/^[a-f0-9]{40}$/u.test(targetSha ?? '') || !Array.isArray(entries)) {
    throw new Error('AUTO_LIVE_SIGNAL_IDENTITY_ARGUMENT_INVALID');
  }
  if (entries.some((entry) => entry?.identity?.researchCodeSha !== targetSha)) {
    throw new Error('AUTO_LIVE_SIGNAL_HANDOFF_SHA_MISMATCH');
  }
  const observedMarkets = [...new Set(entries.map((entry) => entry.identity.market))].sort();
  if (observedMarkets.some((market) => !MARKETS.includes(market))) {
    throw new Error('AUTO_LIVE_SIGNAL_HANDOFF_MARKET_INVALID');
  }
  return { entryShaMatch: entries.length ? true : null,
    entryResearchCodeShas: entries.length ? [targetSha] : [], observedMarkets,
    sourceTransportOnly: true, producerInvocationVerified: false };
}

// Transport/schema/digest validation is not evidence that a formula scanner
// and AI provider actually ran. In particular, an empty handoff proves no
// candidate identity, and must not become a fabricated all-four-market PASS.
function assertSignalEntryIdentityReceipt(signal, targetSha) {
  const markets = signal?.observedMarkets;
  const shas = signal?.entryResearchCodeShas;
  const count = signal?.entryCount;
  if (!/^[a-f0-9]{40}$/u.test(targetSha ?? '') || !Number.isSafeInteger(count) || count < 0
    || !Array.isArray(markets) || !Array.isArray(shas)
    || JSON.stringify(markets) !== JSON.stringify([...new Set(markets)].sort())
    || markets.some((market) => !MARKETS.includes(market))
    || signal?.sourceTransportOnly !== true || signal?.producerInvocationVerified !== false
    || (count === 0 ? markets.length !== 0 || shas.length !== 0 || signal.entryShaMatch !== null
      : markets.length < 1 || markets.length > count || signal.entryShaMatch !== true
        || JSON.stringify(shas) !== JSON.stringify([targetSha]))) {
    throw new Error('POSTDEPLOY_QA_AUTO_LIVE_SIGNAL_IDENTITY_INVALID');
  }
}

/**
 * Pre-mutation diagnostic only. Reads a real published public handoff through
 * the same strict schema, entry provenance, and SHA256 digest validator used by
 * the running Paper/Live worker. Transport validation never proves an issuer,
 * authorizes orders, or elevates trading flags.
 */
async function verifyProductionAutoLivePrearmHandoff(value, targetSha, nowMs = Date.now()) {
  if (!/^[a-f0-9]{40}$/u.test(targetSha ?? '') || !Number.isFinite(nowMs) || nowMs <= 0) {
    throw new Error('AUTOMATIC_TRADING_PREARM_ARGUMENT_INVALID');
  }
  let validated;
  try {
    const { validateMemberAutoTradingPaperHandoff } =
      await import('../market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js');
    validated = validateMemberAutoTradingPaperHandoff(value, nowMs);
  } catch {
    // Never surface arbitrary upstream payloads or paths in protected logs.
    throw new Error('AUTOMATIC_TRADING_PREARM_HANDOFF_CONTRACT_INVALID');
  }
  if (validated.status !== 'READY' || validated.evaluatedAtMs > nowMs
    || nowMs - validated.evaluatedAtMs > 30 * 60_000) {
    throw new Error('AUTOMATIC_TRADING_PREARM_HANDOFF_BLOCKED_OR_STALE');
  }
  let identity;
  try { identity = inspectSignalEntryIdentity(validated.entries, targetSha); }
  catch { throw new Error('AUTOMATIC_TRADING_PREARM_HANDOFF_SHA_MISMATCH'); }
  return Object.freeze({ ...identity, entryCount: validated.entryCount });
}


// Read-only operational schedule inspection: a tagged comment, wrong command,
// different cadence or stale activation receipt is not an active source.
// Even a valid schedule does not prove scanner or AI issuer execution.
function inspectManagedPaperForwardSchedule(crontabText, activation, targetSha, activatedAtMs, nowMs = Date.now()) {
  if (typeof crontabText !== 'string' || !/^[a-f0-9]{40}$/u.test(targetSha ?? '')
    || !Number.isSafeInteger(activatedAtMs) || activatedAtMs <= 0
    || !Number.isFinite(nowMs) || nowMs < activatedAtMs) {
    throw new Error('AUTO_LIVE_SIGNAL_SCHEDULE_ARGUMENT_INVALID');
  }
  const tag = '# stock-app-paper-forward-v1';
  const wrapperPath = '/opt/stock-app-data/paper-forward-v1/bin/run-paper-forward-schedule';
  const prefix = '*/15 * * * * ';
  const suffix = ' -n /opt/stock-app-data/paper-forward-v1/cron.lock ' + wrapperPath + ' ' + tag;
  const lines = crontabText.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  // A duplicate untagged invocation is also unsafe; tagged comments alone
  // cannot certify that cron will run a real executable.
  const managed = lines.filter((line) => line.includes(tag) || line.includes(wrapperPath));
  if (managed.length !== 1) throw new Error('AUTO_LIVE_SIGNAL_SCHEDULE_COUNT_INVALID');
  const line = managed[0];
  const executable = line.startsWith(prefix) && line.endsWith(suffix)
    ? line.slice(prefix.length, -suffix.length) : '';
  if (!/^\/(?:[A-Za-z0-9._+-]+\/)*flock$/u.test(executable)) {
    throw new Error('AUTO_LIVE_SIGNAL_SCHEDULE_ENTRY_NOT_EXECUTABLE');
  }
  const hash = createHash('sha256').update(line).digest('hex');
  if (activation?.schemaVersion !== 'paper-forward-schedule-activation-v2'
    || activation?.status !== 'ACTIVE_WAITING_FOR_NATURAL_CYCLE'
    || activation?.targetSha !== targetSha || activation?.deployedSha !== targetSha
    || activation?.activationAtMs !== activatedAtMs
    || Date.parse(String(activation?.installedAt ?? '')) !== activatedAtMs
    || activation?.scheduleActive !== true
    || activation?.pollCadence !== 'EVERY_15_MINUTES'
    || activation?.canonicalCycleIntervalMs !== 900_000
    || activation?.autoLivePublicSignalRefreshEnabled !== true
    || !/^[a-f0-9]{64}$/u.test(String(activation?.runtimeDigest ?? ''))
    || activation?.cronHash !== hash
    || activation?.paperTradeOutcomeAccumulationEnabled !== false
    || activation?.simulatedFinancialAdaptersEnabled !== false
    || activation?.externalFinancialMutationAllowed !== false
    || activation?.publicDataOnly !== true
    || activation?.liveTrading !== false
    || activation?.privateAccountAccess !== false
    || activation?.orderAuthority !== false) {
    throw new Error('AUTO_LIVE_SIGNAL_SCHEDULE_ACTIVATION_PROOF_INVALID');
  }
  return Object.freeze({ exactActiveCommand: true, activationBound: true,
    entryCount: 1, publicOnly: true, refreshIntervalMs: 900_000 });
}


// Read-only preflight for the SHARED historical Paper Forward owner. The
// Automatic LIVE release must never silently disable an existing Natural
// Paper schedule or reconfigure a persisted four-hour state into 15-minute
// observation mode. A separate dedicated worker is needed for coexistence.
function inspectAutoLiveSharedPaperForwardOwnership({ targetSha, crontabText, sharedStateRootPresent }) {
  if (!/^[a-f0-9]{40}$/u.test(targetSha ?? '') || typeof crontabText !== 'string'
    || typeof sharedStateRootPresent !== 'boolean') {
    throw new Error('AUTO_LIVE_SHARED_SCHEDULE_ARGUMENT_INVALID');
  }
  const references = crontabText.split(/\r?\n/u).some((line) =>
    /stock-app-paper-forward-v1|paper-forward|run-paper-forward-schedule/iu.test(line));
  if (references) throw new Error('AUTO_LIVE_SHARED_PAPER_SCHEDULE_ALREADY_OWNED');
  // Preserve disabled/archived Paper epochs as well: an old state root is
  // neither empty nor consent to overwrite its histories and publisher links.
  if (sharedStateRootPresent) throw new Error('AUTO_LIVE_SHARED_PAPER_STATE_ALREADY_OWNED');
  return Object.freeze({
    schemaVersion: 'automatic-live-shared-paper-owner-preflight-v1',
    status: 'PASS_NO_EXISTING_PAPER_OWNER',
    targetSha, financeOrScheduleMutationCount: 0,
    scannerInvocationVerified: false, aiIssuerVerified: false,
    liveActivationReady: false,
  });
}

// A disabled marker must remain visible even when it is a dangling symlink.
// Also reject a redirected runtime-state parent: ENOENT on a child below a
// broken parent is not proof that activation is enabled.
function assertAutoLiveSignalNotDisabled(root, stat = require('node:fs').lstatSync) {
  if (root !== '/opt/stock-app-data/paper-forward-v1' || typeof stat !== 'function') {
    throw new Error('AUTO_LIVE_SIGNAL_SCHEDULE_INSPECTION_UNAVAILABLE');
  }
  const rootAndParent = [root, root + '/runtime-state'];
  for (const path of rootAndParent) {
    try {
      const info = stat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('AUTO_LIVE_SIGNAL_SCHEDULE_INSPECTION_UNAVAILABLE');
      }
    } catch (error) {
      if (path !== root && error?.code === 'ENOENT') continue;
      throw new Error('AUTO_LIVE_SIGNAL_SCHEDULE_INSPECTION_UNAVAILABLE');
    }
  }
  for (const path of [root + '/DISABLED', root + '/runtime-state/DISABLED']) {
    try {
      stat(path);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new Error('AUTO_LIVE_SIGNAL_SCHEDULE_INSPECTION_UNAVAILABLE');
    }
    throw new Error('AUTO_LIVE_SIGNAL_SCHEDULE_DISABLED');
  }
  return Object.freeze({ disableSentinelPresent: false });
}

function runAutoLiveSharedPaperForwardPreflight() {
  const { lstatSync } = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('crontab', ['-l'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.error || result.signal) throw new Error('AUTO_LIVE_SHARED_SCHEDULE_INSPECTION_UNAVAILABLE');
  let crontabText;
  if (result.status === 0) crontabText = String(result.stdout ?? '');
  else if (result.status === 1
    && /^no crontab for [^\n]+$/iu.test(String(result.stderr ?? '').trim())) crontabText = '';
  else throw new Error('AUTO_LIVE_SHARED_SCHEDULE_INSPECTION_UNAVAILABLE');

  let sharedStateRootPresent = false;
  try {
    // lstat, not existsSync: an unexpected or dangling symlink is also
    // prior ownership and can never be treated as an empty install.
    lstatSync('/opt/stock-app-data/paper-forward-v1');
    sharedStateRootPresent = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('AUTO_LIVE_SHARED_SCHEDULE_INSPECTION_UNAVAILABLE');
  }
  return inspectAutoLiveSharedPaperForwardOwnership({
    targetSha: process.env.AUTO_LIVE_TARGET_SHA,
    crontabText, sharedStateRootPresent,
  });
}


// Pure preflight design only. This does not install cron, write Paper state,
// contact a provider, mint AI approval, or grant automatic LIVE authority.
// A separately approved publisher may later implement these fixed boundaries.
function inspectIndependentAutoLivePublicSourcePlan({
  targetSha, deployedSha, crontabText, isolatedRootPresent,
}) {
  if (!/^[a-f0-9]{40}$/u.test(targetSha ?? '')
    || deployedSha !== targetSha || typeof crontabText !== 'string'
    || typeof isolatedRootPresent !== 'boolean') {
    throw new Error('AUTO_LIVE_INDEPENDENT_SOURCE_ARGUMENT_INVALID');
  }
  const root = '/opt/stock-app-data/auto-live-signal-v1';
  const wrapper = root + '/bin/run-auto-live-public-signal';
  const tag = '# stock-app-auto-live-public-signal-v1';
  // Existing Paper Forward schedules are unrelated and must be preserved.
  if (crontabText.split(/\r?\n/u).some(line =>
    line.includes(tag) || line.includes(wrapper))) {
    throw new Error('AUTO_LIVE_INDEPENDENT_SOURCE_ALREADY_OWNED');
  }
  if (isolatedRootPresent) {
    throw new Error('AUTO_LIVE_INDEPENDENT_SOURCE_STATE_ALREADY_OWNED');
  }
  const cronLine = '*/15 * * * * /usr/bin/flock -n '
    + root + '/cron.lock ' + wrapper + ' ' + tag;
  return Object.freeze({
    schemaVersion: 'auto-live-independent-public-source-plan-v1',
    status: 'DRAFT_PLAN_NOT_INSTALLED',
    targetSha, isolatedRoot: root,
    runtimeStateRoot: root + '/runtime-state',
    handoffPath: root + '/runtime-state/handoff/member-auto-trading-latest.json',
    cronLine, cronHash: createHash('sha256').update(cronLine).digest('hex'),
    pollIntervalMs: 900000,
    paperRootMutated: false, paperCronReplaced: false,
    publicDataOnly: true, paperOutcomeAccumulationEnabled: false,
    financialMutationAllowed: false, privateApiAllowed: false,
    producerInvocationVerified: false, aiIssuerVerified: false,
    autoTradingActivationReady: false, ownerInstallApprovalRequired: true,
  });
}

module.exports = {
  inspectIndependentAutoLivePublicSourcePlan,
  assertAutoLiveSignalNotDisabled,
  inspectAutoLiveSharedPaperForwardOwnership,
  inspectManagedPaperForwardSchedule,
  inspectSignalEntryIdentity, assertSignalEntryIdentityReceipt,
  verifyProductionAutoLivePrearmHandoff,
};

// This file can be streamed over a protected SSH stdin (node -), so the
// predeploy check uses the exact PR source before the current app is deployed.
// Importing the helper in offline tests has no side effects.
if (process.env.AUTO_LIVE_SHARED_PAPER_PREFLIGHT === 'true') {
  try {
    process.stdout.write(JSON.stringify(runAutoLiveSharedPaperForwardPreflight()) + '\n');
  } catch (error) {
    const safe = error instanceof Error && /^AUTO_LIVE_SHARED_[A-Z0-9_]{1,100}$/u.test(error.message)
      ? error.message : 'AUTO_LIVE_SHARED_SCHEDULE_INSPECTION_UNAVAILABLE';
    process.stderr.write('[auto-live-shared-paper-preflight] ' + safe + '\n');
    process.exitCode = 1;
  }
}
