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
module.exports = { inspectSignalEntryIdentity, assertSignalEntryIdentityReceipt };
