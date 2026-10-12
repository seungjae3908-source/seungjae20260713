import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import {
  persistResearchMinuteSessionV1, inspectArchivedResearchMinuteSessionV1,
} from './research-minute-archive-v1.js';
import { deriveResearchTimeframesFromMinuteSourceV1 } from './research-minute-to-multiframe-v1.js';

// Opt-in PRIVATE/OFFLINE source relay.  #1859 creates a sealed readback; this
// adapter never fetches providers, controls orders, opens Paper, or issues
// profitability credit. The bridge has NO dependency on an unmerged PR module.
export const RESEARCH_PUBLIC_MINUTE_PREWIRE_BRIDGE_V1 =
  'research-public-minute-prewire-native-archive-bridge/v1';
const UPSTREAM = 'research-original-minute-backtester-prewire/v1';
const MODEL_STATUS = 'RETROSPECTIVE_RESEARCH_MODEL_INPUT_ONLY';
const HASH64 = /^[a-f0-9]{64}$/u;
const SHA40 = /^[a-f0-9]{40}$/u;
const DAY = 86_400_000;
const MINUTE = 60_000;
const VENUE = Object.freeze({
  CRYPTO_SPOT: { venue: 'UPBIT_KRW', source: 'UPBIT_PUBLIC_1M' },
  CRYPTO_FUTURES: {
    venue: 'BITGET_USDT_FUTURES', source: 'BITGET_PUBLIC_FUTURES_1M',
  },
});
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const stamp = x => Number.isSafeInteger(x) && x > 0;
const fail = code => { throw new TypeError(code); };
const stop = (status, reason, fields = {}) => Object.freeze({
  contract: RESEARCH_PUBLIC_MINUTE_PREWIRE_BRIDGE_V1,
  status, reason,
  sourceOnly: true, readOnlyInput: true, publicProviderGETCount: 0,
  privateAccountAPIRequests: 0, realOrders: 0, paperOrders: 0,
  actualFillsProven: false, historicalPITProven: false,
  originalScannerAsOfAvailabilityVerified: false,
  independentOosProven: false, fullCostProfitabilityProven: false,
  profitabilityProven: false, paperAdmissionAllowed: false,
  executionAuthority: 'NONE', archiveFilesWritten: 0, ...fields,
});

export function validatePublicMinutePrewireForNativeArchiveV1(prewire, opts = {}) {
  const { expectedResearchSha, asOfMs = null } = opts;
  if (!obj(prewire) || prewire.contract !== UPSTREAM
    || prewire.status !== MODEL_STATUS || !obj(prewire.modelInput)
    || prewire.executionAuthority !== 'NONE'
    || prewire.profitabilityProven !== false
    || prewire.historicalPITProven !== false
    || prewire.independentOosProven !== false
    || prewire.fullCostProfitabilityProven !== false
    || prewire.paperAdmissionAllowed !== false
    || prewire.providerGETCount !== 0 || prewire.archiveFilesWritten !== 0
    || prewire.sourceMinuteRows !== 1440
    || !HASH64.test(prewire.sourceMinuteDigest ?? '')
    || prewire.sourceMinuteDigest !== prewire.modelInput.sourceMinuteRowsSha256
    || prewire.metadata?.allSourceSlotsObserved !== true
    || prewire.metadata?.sourceDigestMatchesCanonicalModel !== true
    || prewire.metadata?.retrospectiveTimeCannotBeUsedAsScannerTime !== true
    || prewire.metadata?.independentMarketLicenseOrPITProven !== false
    || !stamp(prewire.oldestActualReceiptMs)
    || !stamp(prewire.newestActualReceiptMs)
    || prewire.oldestActualReceiptMs > prewire.newestActualReceiptMs
    || !Array.isArray(prewire.sourceArchiveDigests)
    || prewire.sourceArchiveDigests.length < 12
    || prewire.sourceArchiveDigests.length > 512
    || prewire.metadata?.sourceMinutePages !== prewire.sourceArchiveDigests.length
    || prewire.metadata?.missingOneMinuteSlots !== 0
    || new Set(prewire.sourceArchiveDigests).size !== prewire.sourceArchiveDigests.length
    || prewire.sourceArchiveDigests.some(s => !HASH64.test(s))
    || !Array.isArray(prewire.sourceArchiveProducerShas)
    || prewire.sourceArchiveProducerShas.length < 1
    || prewire.sourceArchiveProducerShas.length > 512
    || prewire.sourceArchiveProducerShas.some(s => !SHA40.test(s))
    || new Set(prewire.sourceArchiveProducerShas).size !== prewire.sourceArchiveProducerShas.length
    || !SHA40.test(expectedResearchSha ?? '')
    || !prewire.sourceArchiveProducerShas.includes(expectedResearchSha))
    return stop('BLOCKED_DATA', 'PUBLIC_MINUTE_PREWIRE_PROVENANCE_UNVERIFIED');

  const s = prewire.modelInput;
  const expected = VENUE[s.market];
  if (!expected || s.venue !== expected.venue || s.sourceId !== expected.source
    || prewire.market !== s.market || prewire.symbol !== s.symbol
    || !stamp(s.session?.startMs) || s.session.startMs % DAY !== 0
    || s.session.endMs !== s.session.startMs + DAY
    || s.session.kind !== 'UTC_24H' || s.session.timeZone !== 'UTC'
    || s.session.calendarSourceId !== 'CRYPTO_UTC_DAY_SOURCE_ONLY'
    || new Date(s.session.startMs).toISOString().slice(0, 10) !== prewire.day
    || !stamp(s.asOfMs)
    || (asOfMs !== null && asOfMs !== s.asOfMs)
    || s.asOfMs < prewire.newestActualReceiptMs
    || !Array.isArray(s.minuteBars) || s.minuteBars.length !== 1440
    || hash(s.minuteBars) !== prewire.sourceMinuteDigest)
    return stop('BLOCKED_DATA', 'PUBLIC_MINUTE_PREWIRE_MARKET_OR_SOURCE_MISMATCH');

  const validated = deriveResearchTimeframesFromMinuteSourceV1({
    ...s, timeframes: ['1m', '5m'],
  });
  const allBarsWithinReceiptWindow = s.minuteBars.every(bar =>
    stamp(bar.availableAtMs)
    && bar.availableAtMs >= prewire.oldestActualReceiptMs
    && bar.availableAtMs <= s.asOfMs);
  if (!allBarsWithinReceiptWindow
    || validated.sourceMinuteIntegrityVerified !== true
    || validated.intervalData?.['1m']?.completeBarCount !== 1440
    || validated.intervalData?.['5m']?.completeBarCount !== 288
    || !validated.intervalData?.['1m']?.sourceSessionCoverageComplete
    || !validated.intervalData?.['5m']?.sourceSessionCoverageComplete)
    return stop('BLOCKED_DATA', 'PUBLIC_MINUTE_PREWIRE_CLOSED_SLOT_OR_ASOF_UNVERIFIED');

  return stop('RETROSPECTIVE_ORIGINAL_SOURCE_COMPATIBLE', null, {
    market: s.market, symbol: s.symbol, day: prewire.day,
    sourceMinuteDigest: prewire.sourceMinuteDigest,
    // Never include raw OHLCV in the compatibility/status response.
    observedMinuteRows: 1440,
    actualSourceReceipts: prewire.sourceArchiveDigests.length,
    checkedProducerSha: expectedResearchSha,
  });
}

export async function importPublicMinutePrewireIntoNativeArchiveV1({
  enabled = false, operatorApproved = false, prewire,
  archiveRoot, expectedResearchSha, now = () => Date.now(),
} = {}) {
  if (!enabled)
    return stop('DISABLED', 'EXPLICIT_NATIVE_ARCHIVE_IMPORT_DISABLED');
  if (!operatorApproved)
    return stop('HOLD_OPERATOR_APPROVAL', 'EXPLICIT_OFFLINE_SOURCE_IMPORT_APPROVAL_REQUIRED');
  if (typeof now !== 'function' || !stamp(now()))
    fail('NATIVE_MINUTE_PREWIRE_CLOCK_INVALID');
  const valid = validatePublicMinutePrewireForNativeArchiveV1(prewire, {
    expectedResearchSha,
  });
  if (valid.status !== 'RETROSPECTIVE_ORIGINAL_SOURCE_COMPATIBLE')
    return valid;
  if (prewire.modelInput.asOfMs > now() + 5_000)
    return stop('BLOCKED_DATA', 'PUBLIC_MINUTE_PREWIRE_FUTURE_ASOF_UNVERIFIED');
  if (typeof archiveRoot !== 'string' || !isAbsolute(archiveRoot)
    || resolve(archiveRoot) !== archiveRoot
    || /^\/(?:opt\/stock-app-data|srv\/stock-app|var\/lib\/stock-app)(?:\/|$)/u.test(archiveRoot))
    fail('NATIVE_MINUTE_PREWIRE_PROTECTED_ARCHIVE_ROOT');

  // Only one input session is passed to the existing immutable private
  // archive. Hashes/receipts are local checks, not official vendor signatures.
  const save = await persistResearchMinuteSessionV1({
    root: archiveRoot, source: prewire.modelInput,
  });
  const inspected = await inspectArchivedResearchMinuteSessionV1({
    root: archiveRoot, market: valid.market, symbol: valid.symbol,
    sessionStartMs: prewire.modelInput.session.startMs,
    sourceDigestSha256: save.sourceDigestSha256,
  });
  if (inspected.status !== 'OBSERVED_ALL_MINUTE_SLOTS_SOURCE_ONLY'
    || inspected.sourceMinuteRowsSha256 !== valid.sourceMinuteDigest
    || inspected.sourceMinuteRows !== 1440
    || inspected.originalScannerAvailabilityIndependentlyVerified !== false
    || inspected.profitabilityProven !== false)
    fail('NATIVE_MINUTE_PREWIRE_PRIVATE_READBACK_MISMATCH');
  return stop('IMPORTED_RETROSPECTIVE_SOURCE_ONLY', null, {
    market: valid.market, symbol: valid.symbol, day: valid.day,
    sourceMinuteDigest: valid.sourceMinuteDigest,
    nativeImmutableArchiveDigest: save.sourceDigestSha256,
    nativeArchivedMinuteRows: inspected.sourceMinuteRows,
    archiveFilesWritten: save.status === 'STORED_IMMUTABLE_ORIGINAL' ? 1 : 0,
    reusedIdenticalSource: save.status === 'REUSED_IDENTICAL_ORIGINAL',
    firstScannerAvailabilityIndependentlyVerified: false,
  });
}
