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

module.exports = {
  inspectManagedPaperForwardSchedule,
  inspectSignalEntryIdentity, assertSignalEntryIdentityReceipt,
  verifyProductionAutoLivePrearmHandoff,
};
