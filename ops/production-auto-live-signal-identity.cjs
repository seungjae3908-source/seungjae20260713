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
  const tag = '# stock-app-auto-live-public-signal-v1';
  const wrapperPath = '/opt/stock-app-data/auto-live-signal-v1/bin/run-auto-live-public-signal';
  const prefix = '*/15 * * * * ';
  const suffix = ' -n /opt/stock-app-data/auto-live-signal-v1/cron.lock ' + wrapperPath + ' ' + tag;
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
    || activation?.independentPaperRoot !== true
    || activation?.paperRootMutated !== false
    || activation?.paperCronReplaced !== false
    || activation?.producerInvocationVerified !== false
    || activation?.aiIssuerVerified !== false
    || activation?.autoTradingActivationReady !== false
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
  if (root !== '/opt/stock-app-data/auto-live-signal-v1' || typeof stat !== 'function') {
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


const CANONICAL_AUTO_SIGNAL_HANDOFF_PATH =
  '/opt/stock-app-data/auto-live-signal-v1/runtime-state/handoff/member-auto-trading-latest.json';
const MAX_AUTO_SIGNAL_HANDOFF_BYTES = 8 * 1024 * 1024;
const CANONICAL_AUTO_SIGNAL_ACTIVATION_PATH = '/opt/stock-app-data/auto-live-signal-v1/activation.json';
const CANONICAL_AUTO_SIGNAL_WRAPPER_PATH =
  '/opt/stock-app-data/auto-live-signal-v1/bin/run-auto-live-public-signal';
const CANONICAL_AUTO_SIGNAL_FILES = Object.freeze({
  HANDOFF: Object.freeze({ path: CANONICAL_AUTO_SIGNAL_HANDOFF_PATH,
    maxBytes: MAX_AUTO_SIGNAL_HANDOFF_BYTES, minBytes: 2, executable: false }),
  ACTIVATION: Object.freeze({ path: CANONICAL_AUTO_SIGNAL_ACTIVATION_PATH,
    maxBytes: 32 * 1024, minBytes: 2, executable: false }),
  WRAPPER: Object.freeze({ path: CANONICAL_AUTO_SIGNAL_WRAPPER_PATH,
    maxBytes: 64 * 1024, minBytes: 16, executable: true }),
});

/**
 * Bounded, read-only, NOFOLLOW source artifact reader. A growing file can
 * never be consumed past its original size+1 before rejection. Transport
 * verification does not attest any genuine scanner or AI invocation.
 */
function readBoundedAutoLiveSourceArtifact(kind, candidatePath, io = require('node:fs')) {
  const rule = CANONICAL_AUTO_SIGNAL_FILES[kind];
  const prefix = 'AUTO_LIVE_SIGNAL_' + kind;
  if (!rule || candidatePath !== rule.path) throw new Error(prefix + '_PATH_INVALID');
  // Verify all ancestor paths; final component also uses O_NOFOLLOW.
  for (let slash = rule.path.indexOf('/', 1); slash !== -1;
    slash = rule.path.indexOf('/', slash + 1)) {
    const parent = rule.path.slice(0, slash);
    let stat;
    try { stat = io.lstatSync(parent); }
    catch { throw new Error(prefix + '_PARENT_INVALID'); }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(prefix + '_PARENT_INVALID');
    }
  }
  if (![io.constants?.O_RDONLY, io.constants?.O_NOFOLLOW, io.constants?.O_NONBLOCK]
    .every(Number.isInteger)) throw new Error(prefix + '_OPEN_FLAGS_UNAVAILABLE');
  let fd;
  try {
    fd = io.openSync(rule.path,
      io.constants.O_RDONLY | io.constants.O_NOFOLLOW | io.constants.O_NONBLOCK);
  } catch { throw new Error(prefix + '_OPEN_FAILED'); }
  try {
    const before = io.fstatSync(fd);
    if (!before?.isFile() || !Number.isSafeInteger(before.size)
      || before.size < rule.minBytes || before.size > rule.maxBytes
      || !Number.isInteger(before.mode) || (before.mode & 0o077) !== 0
      || (rule.executable && (before.mode & 0o111) === 0)) {
      throw new Error(prefix + '_FILE_UNSAFE');
    }
    const bytes = Buffer.allocUnsafe(before.size + 1);
    let read = 0;
    while (read < bytes.length) {
      const count = io.readSync(fd, bytes, read, bytes.length - read, read);
      if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length - read) {
        throw new Error(prefix + '_FILE_UNSAFE');
      }
      if (count === 0) break;
      read += count;
    }
    const after = io.fstatSync(fd);
    if (read !== before.size || !after?.isFile()
      || after.size !== before.size
      || (after.mode & 0o777) !== (before.mode & 0o777)
      || after.ino !== before.ino || after.dev !== before.dev
      || after.mtimeMs !== before.mtimeMs) {
      throw new Error(prefix + '_FILE_CHANGED');
    }
    return bytes.subarray(0, read).toString('utf8');
  } catch (error) {
    if (error instanceof Error
      && [prefix + '_FILE_UNSAFE', prefix + '_FILE_CHANGED'].includes(error.message)) {
      throw error;
    }
    throw new Error(prefix + '_READ_FAILED');
  } finally {
    try { io.closeSync(fd); }
    catch { throw new Error(prefix + '_CLOSE_FAILED'); }
  }
}
function readProductionAutoLiveSignalHandoff(handoffPath, io = require('node:fs')) {
  const raw = readBoundedAutoLiveSourceArtifact('HANDOFF', handoffPath, io);
  try { return JSON.parse(raw); }
  catch { throw new Error('AUTO_LIVE_SIGNAL_HANDOFF_JSON_INVALID'); }
}
function readProductionAutoLiveScheduleActivation(path, io = require('node:fs')) {
  const raw = readBoundedAutoLiveSourceArtifact('ACTIVATION', path, io);
  try { return JSON.parse(raw); }
  catch { throw new Error('AUTO_LIVE_SIGNAL_ACTIVATION_JSON_INVALID'); }
}
function readProductionAutoLiveScheduleWrapper(path, io = require('node:fs')) {
  return readBoundedAutoLiveSourceArtifact('WRAPPER', path, io);
}


function runAutoLiveIndependentPublicSourcePreflight() {
  const { lstatSync } = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('crontab', ['-l'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.error || result.signal) {
    throw new Error('AUTO_LIVE_INDEPENDENT_SOURCE_INSPECTION_UNAVAILABLE');
  }
  let crontabText;
  if (result.status === 0) crontabText = String(result.stdout ?? '');
  else if (result.status === 1
    && /^no crontab for [^\n]+$/iu.test(String(result.stderr ?? '').trim())) crontabText = '';
  else throw new Error('AUTO_LIVE_INDEPENDENT_SOURCE_INSPECTION_UNAVAILABLE');
  let isolatedRootPresent = false;
  try {
    lstatSync('/opt/stock-app-data/auto-live-signal-v1');
    isolatedRootPresent = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error('AUTO_LIVE_INDEPENDENT_SOURCE_INSPECTION_UNAVAILABLE');
    }
  }
  return inspectIndependentAutoLivePublicSourcePlan({
    targetSha: process.env.AUTO_LIVE_TARGET_SHA,
    deployedSha: process.env.AUTO_LIVE_DEPLOYED_SHA,
    crontabText, isolatedRootPresent,
  });
}

const INDEPENDENT_AUTO_PUBLIC_INSTALL_SCRIPT = "#!/usr/bin/env bash\nset -Eeuo pipefail\numask 077\nROOT='/opt/stock-app-data/auto-live-signal-v1'\nPARENT='/opt/stock-app-data'\nAPP='/opt/stock-app'\nTAG='# stock-app-auto-live-public-signal-v1'\nWRAPPER=\"$ROOT/bin/run-auto-live-public-signal\"\nSHA=\"$1\"\nSTAGE=''\nPUBLISHED=0\nCRON_MUTATED=0\nOLD_CRON=''\nNEW_CRON=''\nabort() { printf '[auto-live-independent-install] %s\\n' \"$1\" >&2; exit 1; }\nrollback() {\n  code=$?\n  trap - EXIT\n  if (( code != 0 )) && (( PUBLISHED == 1 )); then\n    : > \"$ROOT/DISABLED\" || true\n    chmod 600 \"$ROOT/DISABLED\" || true\n  fi\n  if (( code != 0 )) && (( CRON_MUTATED == 1 )); then\n    now_cron=\"$(crontab -l 2>/dev/null || true)\"\n    expected=\"$NEW_CRON\"\n    if [[ -n \"$OLD_CRON\" ]]; then expected=\"$OLD_CRON\"
  readBoundedAutoLiveSourceArtifact,
  readProductionAutoLiveScheduleActivation,
  readProductionAutoLiveScheduleWrapper,
  readProductionAutoLiveSignalHandoff,
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

if (process.env.AUTO_LIVE_INDEPENDENT_SOURCE_PREFLIGHT === 'true') {
  if (process.env.AUTO_LIVE_SHARED_PAPER_PREFLIGHT === 'true') {
    process.stderr.write('[auto-live-source-preflight] CONFLICTING_PREFLIGHT_MODES\n');
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(JSON.stringify(runAutoLiveIndependentPublicSourcePreflight()) + '\n');
    } catch (error) {
      const safe = error instanceof Error
        && /^AUTO_LIVE_INDEPENDENT_[A-Z0-9_]{1,100}$/u.test(error.message)
        ? error.message : 'AUTO_LIVE_INDEPENDENT_SOURCE_INSPECTION_UNAVAILABLE';
      process.stderr.write('[auto-live-source-preflight] ' + safe + '\n');
      process.exitCode = 1;
    }
  }
}
\\n'\"$NEW_CRON\"; fi\n    # Never overwrite a third-party crontab change made during the installer.\n    if [[ \"$now_cron\" == \"$expected\" ]]; then\n      if [[ -n \"$OLD_CRON\" ]]; then printf '%s\\n' \"$OLD_CRON\" | crontab - || true\n      else crontab -r 2>/dev/null || true; fi\n    fi\n  fi\n  if [[ -n \"$STAGE\" && -d \"$STAGE\" ]]; then rm -rf -- \"$STAGE\"; fi\n  exit \"$code\"\n}\ntrap rollback EXIT\n\n[[ \"$SHA\" =~ ^[0-9a-f]{40}$ ]] || abort 'exact source SHA required'\n[[ \"$(printenv AUTO_LIVE_INDEPENDENT_SIGNAL_INSTALL_APPROVED || true)\" == 'true' ]] \\\n  || abort 'protected owner approval required'\n[[ -d \"$PARENT\" && ! -L \"$PARENT\" ]] || abort 'isolated root parent unavailable'\n[[ -r \"$APP/.deploy/current-sha\" ]] || abort 'deployed SHA marker missing'\n[[ \"$(tr -d '[:space:]' < \"$APP/.deploy/current-sha\")\" == \"$SHA\" ]] \\\n  || abort 'target does not equal exact deployed SHA'\n[[ ! -e \"$ROOT\" && ! -L \"$ROOT\" ]] || abort 'independent root already owned'\nfor command in bash node rsync flock crontab chmod mkdir mktemp sed find sort xargs sha256sum mv; do\n  command -v \"$command\" >/dev/null 2>&1 || abort 'installer dependency unavailable'\ndone\n[[ -x /usr/bin/flock ]] || abort 'canonical flock unavailable'\nfor rel in market-prediction-lab packages/strategy-hypothesis packages/external-research; do\n  [[ -d \"$APP/$rel\" && ! -L \"$APP/$rel\" ]] || abort 'canonical source package missing'\ndone\n[[ -r \"$APP/market-prediction-lab/scripts/run-paper-forward-schedule.js\" ]] \\\n  || abort 'public observation engine missing'\n[[ -r \"$APP/packages/strategy-hypothesis/src/index.js\" ]] \\\n  || abort 'strategy hypothesis dependency missing'\n[[ -r \"$APP/packages/external-research/src/index.js\" ]] \\\n  || abort 'external research dependency missing'\n\nexec 9>\"$PARENT/.auto-live-signal-v1-install.lock\"\nflock -n 9 || abort 'independent install already running'\nset +e\nOLD_CRON=\"$(crontab -l 2>/dev/null)\"\ncron_rc=$?\nset -e\n[[ \"$cron_rc\" == 0 || \"$cron_rc\" == 1 ]] || abort 'crontab unavailable'\n[[ \"$OLD_CRON\" != *\"$TAG\"* && \"$OLD_CRON\" != *\"$WRAPPER\"* ]] \\\n  || abort 'previous independent cron already owned'\n[[ ! -e \"$ROOT\" && ! -L \"$ROOT\" ]] || abort 'independent root appeared during preflight'\nFLOCK_BIN=\"$(command -v flock)\"\nNEW_CRON=\"*/15 * * * * $FLOCK_BIN -n $ROOT/cron.lock $WRAPPER $TAG\"\nSTAGE=\"$(mktemp -d \"$PARENT/.auto-live-signal-stage.XXXXXXXX\")\"\nchmod 700 \"$STAGE\"\nmkdir -p \"$STAGE/releases/$SHA/market-prediction-lab\" \\\n  \"$STAGE/releases/$SHA/packages/strategy-hypothesis\" \\\n  \"$STAGE/releases/$SHA/packages/external-research\" \\\n  \"$STAGE/runtime-state\" \"$STAGE/bin\" \"$STAGE/logs\"\n# Immutable code only; NEVER copy Paper ledgers, keys, env or original cron.\nfor rel in market-prediction-lab packages/strategy-hypothesis packages/external-research; do\n  rsync -a --delete --exclude='node_modules/' --exclude='*/node_modules/' \\\n    --exclude='.env*' --exclude='*.pem' --exclude='*.key' --exclude='*.p12' \\\n    \"$APP/$rel/\" \"$STAGE/releases/$SHA/$rel/\"\ndone\nif find \"$STAGE/releases/$SHA\" -type l | grep -q .; then\n  abort 'unexpected symlink in isolated code snapshot'\nfi\nfind \"$STAGE/releases/$SHA\" -type f -exec chmod 600 {} +\nfind \"$STAGE/releases/$SHA\" -type d -exec chmod 700 {} +\nACTIVATION_MS=\"$(node -e 'process.stdout.write(String(Date.now()))')\"\ncat > \"$STAGE/bin/run-auto-live-public-signal\" <<'WRAPPER'\n#!/usr/bin/env bash\nset -Eeuo pipefail\numask 077\nROOT='/opt/stock-app-data/auto-live-signal-v1'\n[[ ! -e \"$ROOT/DISABLED\" && ! -L \"$ROOT/DISABLED\" ]] || exit 0\n[[ ! -e \"$ROOT/runtime-state/DISABLED\" && ! -L \"$ROOT/runtime-state/DISABLED\" ]] || exit 0\nLOG=\"$ROOT/logs/cron.log\"\nif [[ -f \"$LOG\" && \"$(wc -c < \"$LOG\")\" -gt 5242880 ]]; then\n  mv -f \"$LOG\" \"$ROOT/logs/cron.previous.log\"\nfi\nexec >> \"$LOG\" 2>&1\nexec /usr/bin/env -i \\\n  HOME='/tmp' PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \\\n  NODE_ENV='production' \\\n  PAPER_FORWARD_SCHEDULE_ACTIVE='true' \\\n  PAPER_FORWARD_TRIGGER_SOURCE='cron' \\\n  PAPER_FORWARD_ROOT='/opt/stock-app-data/auto-live-signal-v1/runtime-state' \\\n  PAPER_FORWARD_RESEARCH_SHA='__SOURCE_SHA__' \\\n  PAPER_FORWARD_ACTIVATION_AT_MS='__ACTIVATION_MS__' \\\n  AUTO_LIVE_PUBLIC_SIGNAL_REFRESH_ENABLED='true' \\\n  PAPER_FORWARD_OUTCOME_ACCUMULATION_ENABLED='false' \\\n  RESEARCH_PRODUCTION='false' \\\n  LIVE_TRADING='false' LIVE_TRADING_ENABLED='false' \\\n  REAL_ORDER_ENABLED='false' PRIVATE_TRADING_API_ALLOWED='false' \\\n  PRIVATE_API_ENABLED='false' PRIVATE_ACCOUNT_ACCESS='false' \\\n  node '/opt/stock-app-data/auto-live-signal-v1/releases/__SOURCE_SHA__/market-prediction-lab/scripts/run-paper-forward-schedule.js'\nWRAPPER\nsed -i -e \"s/__SOURCE_SHA__/$SHA/g\" -e \"s/__ACTIVATION_MS__/$ACTIVATION_MS/g\" \\\n  \"$STAGE/bin/run-auto-live-public-signal\"\nchmod 700 \"$STAGE/bin/run-auto-live-public-signal\"\nRUNTIME_DIGEST=\"$(cd \"$STAGE/releases/$SHA\" && find . -type f -print0 | sort -z | \\\n  xargs -0 -r sha256sum | sha256sum | awk '{print $1}')\"\nCRON_HASH=\"$(printf '%s' \"$NEW_CRON\" | sha256sum | awk '{print $1}')\"\nnode - \"$STAGE/activation.json\" \"$SHA\" \"$ACTIVATION_MS\" \"$RUNTIME_DIGEST\" \"$CRON_HASH\" <<'NODE'\nconst fs = require('node:fs');\nconst [path,sha,at,digest,cronHash] = process.argv.slice(2);\nconst value = {\n  schemaVersion:'paper-forward-schedule-activation-v2',\n  status:'ACTIVE_WAITING_FOR_NATURAL_CYCLE',\n  targetSha:sha, deployedSha:sha,\n  activationAtMs:Number(at), installedAt:new Date(Number(at)).toISOString(),\n  pollCadence:'EVERY_15_MINUTES',\n  canonicalCycleIntervalMs:900000, autoLivePublicSignalRefreshEnabled:true,\n  independentPaperRoot:true, paperRootMutated:false, paperCronReplaced:false,\n  producerInvocationVerified:false, aiIssuerVerified:false,\n  autoTradingActivationReady:false,\n  runtimeDigest:digest, cronHash, scheduleActive:true, publicDataOnly:true,\n  paperTradeOutcomeAccumulationEnabled:false, simulatedFinancialAdaptersEnabled:false,\n  externalFinancialMutationAllowed:false, liveTrading:false,\n  privateAccountAccess:false, orderAuthority:false,\n  privateRequestCount:0, financialMutationCount:0,\n};\nfs.writeFileSync(path,JSON.stringify(value)+'\\n',{flag:'wx',mode:0o600});\nNODE\n# A dormant published root is safe even if Cron is mutated before readback.\n: > \"$STAGE/DISABLED\"\nchmod 600 \"$STAGE/DISABLED\" \"$STAGE/activation.json\"\n[[ ! -e \"$ROOT\" && ! -L \"$ROOT\" ]] || abort 'independent root became owned'\nmv -T \"$STAGE\" \"$ROOT\"\nSTAGE=''\nPUBLISHED=1\n# A read-only final crontab check reduces the chance of overwriting another\n# writer. Append exactly one entry; never remove the historic Paper tag.\nCURRENT_CRON=\"$(crontab -l 2>/dev/null || true)\"\n[[ \"$CURRENT_CRON\" == \"$OLD_CRON\" ]] || abort 'unrelated cron changed during preparation'\nif [[ -n \"$OLD_CRON\" ]]; then\n  printf '%s\\n%s\\n' \"$OLD_CRON\" \"$NEW_CRON\" | crontab -\nelse\n  printf '%s\\n' \"$NEW_CRON\" | crontab -\nfi\nCRON_MUTATED=1\nREADBACK=\"$(crontab -l)\"\nEXPECTED=\"$NEW_CRON\"\nif [[ -n \"$OLD_CRON\" ]]; then EXPECTED=\"$OLD_CRON\"
  readBoundedAutoLiveSourceArtifact,
  readProductionAutoLiveScheduleActivation,
  readProductionAutoLiveScheduleWrapper,
  readProductionAutoLiveSignalHandoff,
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

if (process.env.AUTO_LIVE_INDEPENDENT_SOURCE_PREFLIGHT === 'true') {
  if (process.env.AUTO_LIVE_SHARED_PAPER_PREFLIGHT === 'true') {
    process.stderr.write('[auto-live-source-preflight] CONFLICTING_PREFLIGHT_MODES\n');
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(JSON.stringify(runAutoLiveIndependentPublicSourcePreflight()) + '\n');
    } catch (error) {
      const safe = error instanceof Error
        && /^AUTO_LIVE_INDEPENDENT_[A-Z0-9_]{1,100}$/u.test(error.message)
        ? error.message : 'AUTO_LIVE_INDEPENDENT_SOURCE_INSPECTION_UNAVAILABLE';
      process.stderr.write('[auto-live-source-preflight] ' + safe + '\n');
      process.exitCode = 1;
    }
  }
}
\\n'\"$NEW_CRON\"; fi\n[[ \"$READBACK\" == \"$EXPECTED\" ]] || abort 'independent cron readback mismatch'\nrm -f \"$ROOT/DISABLED\"\nPUBLISHED=0\nCRON_MUTATED=0\ntrap - EXIT\nprintf '{\"status\":\"ACTIVE_WAITING_FOR_NATURAL_CYCLE\",\"targetSha\":\"%s\",\"activationAtMs\":%s,\"scheduleActive\":true,\"canonicalCycleIntervalMs\":900000,\"paperTradeOutcomeAccumulationEnabled\":false,\"simulatedFinancialAdaptersEnabled\":false,\"externalFinancialMutationAllowed\":false,\"independentPaperRoot\":true,\"paperRootMutated\":false,\"paperCronReplaced\":false,\"producerInvocationVerified\":false,\"aiIssuerVerified\":false,\"autoTradingActivationReady\":false,\"privateRequestCount\":0,\"financialMutationCount\":0,\"liveTrading\":false}\\n' \\\n  \"$SHA\" \"$ACTIVATION_MS\"\n";
function buildIndependentAutoLivePublicInstallScript() {
  return INDEPENDENT_AUTO_PUBLIC_INSTALL_SCRIPT;
}
function installIndependentAutoLivePublicSource(targetSha) {
  if (!/^[a-f0-9]{40}$/u.test(targetSha ?? '')
    || process.env.AUTO_LIVE_INDEPENDENT_SIGNAL_INSTALL_APPROVED !== 'true') {
    throw new Error('AUTO_LIVE_INDEPENDENT_INSTALL_NOT_APPROVED');
  }
  const { spawnSync } = require('node:child_process');
  const out = spawnSync('bash', ['-s', '--', targetSha], {
    input: INDEPENDENT_AUTO_PUBLIC_INSTALL_SCRIPT,
    encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024,
    env: { ...process.env, LIVE_TRADING: 'false', AUTO_TRADING: 'false',
      REAL_ORDER_ENABLED: 'false', PRIVATE_TRADING_API_ALLOWED: 'false' },
  });
  if (out.error || out.status !== 0 || out.signal) {
    throw new Error('AUTO_LIVE_INDEPENDENT_INSTALL_FAILED_CLOSED');
  }
  let receipt;
  try { receipt = JSON.parse(String(out.stdout ?? '').trim()); }
  catch { throw new Error('AUTO_LIVE_INDEPENDENT_INSTALL_RECEIPT_INVALID'); }
  if (receipt?.targetSha !== targetSha || receipt?.status !== 'ACTIVE_WAITING_FOR_NATURAL_CYCLE'
    || receipt?.independentPaperRoot !== true || receipt?.paperRootMutated !== false
    || receipt?.paperCronReplaced !== false || receipt?.autoTradingActivated === true
    || receipt?.liveTrading !== false
    || receipt?.financialMutationCount !== 0
    || receipt?.producerInvocationVerified !== false) {
    throw new Error('AUTO_LIVE_INDEPENDENT_INSTALL_RECEIPT_INVALID');
  }
  return receipt;
}
module.exports = {
  buildIndependentAutoLivePublicInstallScript,
  installIndependentAutoLivePublicSource,
  runAutoLiveIndependentPublicSourcePreflight,
  readBoundedAutoLiveSourceArtifact,
  readProductionAutoLiveScheduleActivation,
  readProductionAutoLiveScheduleWrapper,
  readProductionAutoLiveSignalHandoff,
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

if (process.env.AUTO_LIVE_INDEPENDENT_SOURCE_PREFLIGHT === 'true') {
  if (process.env.AUTO_LIVE_SHARED_PAPER_PREFLIGHT === 'true') {
    process.stderr.write('[auto-live-source-preflight] CONFLICTING_PREFLIGHT_MODES\n');
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(JSON.stringify(runAutoLiveIndependentPublicSourcePreflight()) + '\n');
    } catch (error) {
      const safe = error instanceof Error
        && /^AUTO_LIVE_INDEPENDENT_[A-Z0-9_]{1,100}$/u.test(error.message)
        ? error.message : 'AUTO_LIVE_INDEPENDENT_SOURCE_INSPECTION_UNAVAILABLE';
      process.stderr.write('[auto-live-source-preflight] ' + safe + '\n');
      process.exitCode = 1;
    }
  }
}

if (process.env.AUTO_LIVE_INDEPENDENT_SOURCE_INSTALL === 'true') {
  if (process.env.AUTO_LIVE_SHARED_PAPER_PREFLIGHT === 'true'
    || process.env.AUTO_LIVE_INDEPENDENT_SOURCE_PREFLIGHT === 'true') {
    process.stderr.write('[auto-live-source-install] CONFLICTING_OPERATION_MODES\n');
    process.exitCode = 1;
  } else {
    try {
      const receipt = installIndependentAutoLivePublicSource(process.env.AUTO_LIVE_TARGET_SHA);
      process.stdout.write(JSON.stringify(receipt) + '\n');
    } catch (error) {
      const safe = error instanceof Error && /^AUTO_LIVE_INDEPENDENT_[A-Z0-9_]+$/u.test(error.message)
        ? error.message : 'AUTO_LIVE_INDEPENDENT_INSTALL_FAILED_CLOSED';
      process.stderr.write('[auto-live-source-install] ' + safe + '\n');
      process.exitCode = 1;
    }
  }
}
