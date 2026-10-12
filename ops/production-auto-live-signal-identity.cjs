'use strict';
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

module.exports = {
  inspectSignalEntryIdentity, assertSignalEntryIdentityReceipt,
  verifyProductionAutoLivePrearmHandoff,
};
