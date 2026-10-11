/**
 * Reproducible local evidence for the retained 2026-10-10 native-minute cohort.
 * Run a bundled copy from the repository root (or api-server directory):
 *   node <bundle> --root <private capture directory> --output <new private JSON>
 * The only financial computation is the existing application service/PERIOD
 * engine. This script does not fetch data, change archives or promote results.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { createOriginalMinuteBacktestServiceV1 } from '../src/services/original-minute-backtest.service';
import { normalizeOriginalMinuteBacktestRequestV1, ORIGINAL_MINUTE_BACKTEST_SAFETY_V1,
  type OriginalMinuteBacktestRequestV1, type OriginalMinuteBacktestRunV1,
} from '../../packages/strategy-hypothesis/src/original-minute-backtest.js';
import { validatePublicNativeCryptoRosterCaptureV1 } from '../../market-prediction-lab/src/public-native-crypto-roster-v1.js';

const DATE = '2026-10-10';
const OWNER = '00000000-0000-4000-8000-000000000001';
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_CODE_BYTES = 32 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/u;
const REASON = /^[A-Z][A-Z0-9_]{0,159}$/u;
const CURRENT = 'CURRENT_PROVIDER_ROSTER_SOURCE_ONLY';
const TERMINAL = ['COMPLETED', 'BLOCKED_DATA', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
const CAPTURES = Object.freeze({
  CRYPTO_SPOT: Object.freeze({ count: 294,
    rosterDigestSha256: '138dbe8f51ca87858b9596bc1026c52d510d5abf6b6de024f9394a8c7f08a189',
    envelopeFileSha256: '561e41994efb2e6819cd3b79dcfcb986bb3c6c246858e7a4a53c71883abaa4bf',
    rawResponseSha256: '22683df8d9e096c6dba027e9f858228a23cd1a046c4ede0ffc1b642a042d3793' }),
  CRYPTO_FUTURES: Object.freeze({ count: 466,
    rosterDigestSha256: 'b7d9ef4192e778b1e69d70e984c659720a36e76bba10253d51a788ef26c1aa83',
    envelopeFileSha256: '0139c1f4d15405f70c7240599e28a8f69aa53c7aa3766b4b1f9a98a068527a13',
    rawResponseSha256: 'ed003d8dc4e67397482c948a73f924aa91d128346a1c16cb5f9d8e0379f7777e' }),
});
type CryptoMarket = keyof typeof CAPTURES;
type Raw = Record<string, any>;
const MODEL = Object.freeze({
  timeframe: '5m', strategy: Object.freeze({ kind: 'EMA_TREND', fast: 4, slow: 12, stopPercent: 1, targetPercent: 2 }),
  initialCapitalKRW: 1_000_000, riskFraction: 0.01, leverage: 1,
  costModel: Object.freeze({ entryFeeRate: 0.0005, exitFeeRate: 0.0005, spreadRate: 0.0002,
    slippageRate: 0.0005, taxRate: 0, latencyRate: 0 }),
  cashFundingRatePerSession: 0, futuresFundingRatePerSession: 0.0001,
  fxKRWPerKRW: 1, fxKRWPerUSDOrUSDT: 1400,
});
const CODE = Object.freeze({
  captureProducer: 'api-server/scripts/verify-original-minute-backtest-capture-v1.ts',
  applicationService: 'api-server/src/services/original-minute-backtest.service.ts',
  sharedSelectionContract: 'packages/strategy-hypothesis/src/original-minute-backtest.js',
  periodEngine: 'market-prediction-lab/src/four-market-original-minute-period-v1.js',
  replayEngine: 'market-prediction-lab/src/four-market-original-minute-replay-v1.js',
  readonlyReportProjector: 'market-prediction-lab/src/research-original-minute-diagnostic-readonly-v1.js',
  canonicalCandidateReview: 'market-prediction-lab/src/four-market-original-minute-candidate-review-v1.js',
  retainedRosterVerifier: 'market-prediction-lab/src/public-native-crypto-roster-v1.js',
  nativeMinuteArchive: 'market-prediction-lab/src/research-minute-archive-v1.js',
});
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function requireThat(value: unknown, code: string): asserts value {
  if (!value) throw new Error('P3_CAPTURE_' + code);
}
function args(argv: string[]) {
  if (!argv.length || (argv.length === 1 && argv[0] === '--help')) return null;
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    requireThat(['--root', '--output'].includes(key) && typeof value === 'string' && value.length > 0
      && !Object.hasOwn(parsed, key), 'CLI_ARGUMENTS_INVALID');
    parsed[key] = value;
  }
  requireThat(Object.keys(parsed).length === 2, 'ROOT_AND_OUTPUT_REQUIRED');
  for (const path of Object.values(parsed)) requireThat(isAbsolute(path) && resolve(path) === path, 'ABSOLUTE_CANONICAL_PATH_REQUIRED');
  return { root: parsed['--root'], output: parsed['--output'] };
}
async function privateDirectory(directory: string) {
  let current = directory;
  while (true) {
    const st = await lstat(current);
    requireThat(st.isDirectory() && !st.isSymbolicLink(), 'DIRECTORY_UNSAFE');
    if (current === directory) requireThat((st.mode & 0o777) === 0o700, 'DIRECTORY_MUST_BE_0700');
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}
async function readBounded(file: string, maximumBytes: number, privateOnly = false) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await handle.stat();
    requireThat(st.isFile() && st.nlink === 1 && st.size > 0 && st.size <= maximumBytes, 'FILE_INVALID');
    if (privateOnly) requireThat((st.mode & 0o777) === 0o600, 'FILE_MUST_BE_0600');
    const chunks: Buffer[] = []; let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65_536, maximumBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead; requireThat(total <= maximumBytes, 'FILE_TOO_LARGE');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}
async function requireAbsent(file: string, code: string) {
  try { await lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  requireThat(false, code);
}
async function writerIdle(root: string) {
  await requireAbsent(join(root, 'archive', '.pit-native-minute-task.lock'), 'ARCHIVE_WRITER_ACTIVE');
}
async function outputReady(root: string, output: string) {
  const archive = join(root, 'archive');
  requireThat(output.endsWith('.json') && output !== archive && !output.startsWith(archive + sep), 'OUTPUT_CANNOT_BE_ARCHIVE');
  requireThat(!Object.keys(CAPTURES).some(market => output === join(root, market + '-roster.json')), 'OUTPUT_CANNOT_BE_ROSTER');
  await privateDirectory(dirname(output));
  await requireAbsent(output, 'OUTPUT_ALREADY_EXISTS');
}
async function codeFingerprints() {
  let repository: string | null = null;
  for (const candidate of [resolve(process.cwd()), resolve(process.cwd(), '..')]) {
    try {
      if ((await lstat(join(candidate, CODE.captureProducer))).isFile()) { repository = candidate; break; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  requireThat(repository, 'RUN_FROM_REPOSITORY_OR_API_DIRECTORY');
  const result: Record<string, string> = {};
  for (const [component, path] of Object.entries(CODE)) result[component] = hash(await readBounded(join(repository, path), MAX_CODE_BYTES));
  result.executedArtifact = hash(await readBounded(resolve(process.argv[1]), MAX_CODE_BYTES));
  return result;
}
async function loadCapture(root: string, market: CryptoMarket) {
  const bytes = await readBounded(join(root, market + '-roster.json'), MAX_JSON_BYTES, true);
  requireThat(hash(bytes) === CAPTURES[market].envelopeFileSha256, 'FROZEN_CAPTURE_FILE_SHA_MISMATCH');
  const capture: Raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const checked = validatePublicNativeCryptoRosterCaptureV1(capture, CAPTURES[market].rosterDigestSha256);
  requireThat(checked.ok && capture.roster.market === market && capture.roster.symbols.length === CAPTURES[market].count
    && capture.rawResponseSha256 === CAPTURES[market].rawResponseSha256, 'FROZEN_CURRENT_CAPTURE_INVALID');
  requireThat(capture.roster.historicalUniverseComplete === false && capture.roster.fullMarketPITUniverseVerified === false,
    'CURRENT_ROSTER_CANNOT_BECOME_PIT');
  return capture;
}
function selection(market: string, symbol: string, direction = 'LONG', startDate = DATE, endDate = DATE) {
  return { market, symbol, direction, startDate, endDate, timeframe: MODEL.timeframe, strategy: MODEL.strategy,
    initialCapitalKRW: MODEL.initialCapitalKRW, riskFraction: MODEL.riskFraction, leverage: MODEL.leverage,
    costModel: { ...MODEL.costModel, fundingRatePerSession: market === 'CRYPTO_FUTURES'
      ? MODEL.futuresFundingRatePerSession : MODEL.cashFundingRatePerSession },
    fxRateKRWPerQuote: ['KR_STOCK', 'CRYPTO_SPOT'].includes(market) ? MODEL.fxKRWPerKRW : MODEL.fxKRWPerUSDOrUSDT };
}
function assertRun(run: OriginalMinuteBacktestRunV1, expected: OriginalMinuteBacktestRequestV1, captures: Record<CryptoMarket, Raw>) {
  requireThat(run.schemaVersion === 'original-minute-backtest-run-v1', 'RUN_SCHEMA_INVALID');
  requireThat(JSON.stringify(run.selection) === JSON.stringify(expected), 'SELECTED_MODEL_CHANGED');
  for (const [key, value] of Object.entries(ORIGINAL_MINUTE_BACKTEST_SAFETY_V1))
    requireThat((run as Raw)[key] === value, 'RUN_TRUTH_BOUNDARY_INVALID');
  requireThat(['COMPLETED', 'BLOCKED_DATA'].includes(run.status) && run.finishedAtMs !== null, 'RUN_NOT_SUCCESSFULLY_ACCOUNTED');
  requireThat(REASON.test(run.reason ?? ''), 'RUN_REASON_INVALID');
  requireThat(run.source.historicalPITRosterChecked === false, 'HISTORICAL_PIT_CANNOT_BE_INFERRED');
  const crypto = Object.hasOwn(CAPTURES, expected.market);
  if (crypto) {
    const capture = captures[expected.market as CryptoMarket];
    requireThat(run.source.evidenceScope === CURRENT && run.source.sourceClass === 'CURRENT_PUBLIC_ROSTER'
      && run.source.currentRosterDigestSha256 === capture.roster.rosterDigestSha256
      && run.source.currentRosterObservedAtMs === capture.roster.observedAtMs, 'CURRENT_CAPTURE_BINDING_MISMATCH');
  }
  if (run.status === 'BLOCKED_DATA') {
    requireThat(run.report === null && run.netProfitPct === null && run.actualMarketWideOpportunityCount === null,
      'BLOCKED_DATA_MUST_STAY_NULL');
    return;
  }
  const report = run.report;
  requireThat(report && crypto && report.symbol === expected.symbol && report.timeframe === expected.timeframe
    && report.direction === expected.direction && report.selectedStartDate === expected.startDate
    && report.selectedEndDate === expected.endDate, 'REPORT_SELECTION_MISMATCH');
  requireThat(report.kind === 'PERIOD' && report.status === 'SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY'
    && report.sessionClosePolicy === 'CLOSE_EACH_SOURCE_SESSION', 'EXISTING_PERIOD_RESULT_REQUIRED');
  requireThat(report.profitabilityProven === false && report.independentOOSProven === false
    && report.independentFullCostProven === false && report.originalHistoricalSignalVerified === false
    && report.paperCandidatePASS === false && report.executionAuthority === 'NONE' && report.actualFillCount === null,
  'REPORT_TRUTH_BOUNDARY_INVALID');
  requireThat(report.canonicalPaperResearchReview.status === 'RESEARCH_HOLD'
    && report.canonicalPaperResearchReview.paperAdmissionAllowed === false
    && report.canonicalPaperResearchReview.executionAuthority === 'NONE', 'CANONICAL_RESEARCH_HOLD_REQUIRED');
  requireThat(SHA.test(run.source.sourceModelDigestSha256 ?? '') && SHA.test(run.source.sourceSessionIndexDigestSha256 ?? ''),
    'COMPLETED_MODEL_AND_SOURCE_HASH_REQUIRED');
  requireThat(run.coverage.verifiedNativeMinuteSessions === 1 && report.sourceSessionsVerified === 1, 'ONE_COMPLETE_SOURCE_DAY_REQUIRED');
}
function statusCounts(runs: readonly OriginalMinuteBacktestRunV1[]) {
  const counts: Record<string, number> = {};
  for (const run of runs) counts[run.status] = (counts[run.status] ?? 0) + 1;
  return counts;
}
function reasonCounts(runs: readonly OriginalMinuteBacktestRunV1[]) {
  const counts: Record<string, number> = {};
  for (const run of runs) if (run.status === 'BLOCKED_DATA' && run.reason) counts[run.reason] = (counts[run.reason] ?? 0) + 1;
  return counts;
}

async function main() {
  const config = args(process.argv.slice(2));
  if (!config) {
    process.stdout.write('Offline retained-data verifier: --root ABSOLUTE_PRIVATE_CAPTURE_DIRECTORY --output NEW_ABSOLUTE_PRIVATE_JSON\n');
    return;
  }
  const originalFetch = globalThis.fetch; let forbiddenNetworkAttempts = 0;
  globalThis.fetch = async () => { forbiddenNetworkAttempts++; throw new Error('P3_CAPTURE_NETWORK_FORBIDDEN'); };
  let service: ReturnType<typeof createOriginalMinuteBacktestServiceV1> | null = null;
  try {
    await privateDirectory(config.root); await privateDirectory(join(config.root, 'archive'));
    await writerIdle(config.root); await outputReady(config.root, config.output);
    const startedAtMs = Date.now();
    const codeContentSha256 = await codeFingerprints();
    const captures = { CRYPTO_SPOT: await loadCapture(config.root, 'CRYPTO_SPOT'),
      CRYPTO_FUTURES: await loadCapture(config.root, 'CRYPTO_FUTURES') };
    const cases: { kind: 'CURRENT_COHORT' | 'MISSING_SOURCE_CHECK'; request: ReturnType<typeof selection> }[] = [];
    for (const symbol of captures.CRYPTO_SPOT.roster.symbols) cases.push({ kind: 'CURRENT_COHORT', request: selection('CRYPTO_SPOT', symbol) });
    for (const symbol of captures.CRYPTO_FUTURES.roster.symbols) for (const direction of ['LONG', 'SHORT'])
      cases.push({ kind: 'CURRENT_COHORT', request: selection('CRYPTO_FUTURES', symbol, direction) });
    const cohortCount = cases.length;
    for (const request of [selection('KR_STOCK', '005930'), selection('US_STOCK', 'AAPL'),
      selection('CRYPTO_SPOT', 'KRW-BTC', 'LONG', '2025-10-11'), selection('CRYPTO_SPOT', 'KRW-BTC', 'LONG', '2016-10-11')])
      cases.push({ kind: 'MISSING_SOURCE_CHECK', request });
    requireThat(cohortCount === 1226 && cases.length === 1230, 'DESIGNATED_CASE_COUNT_CHANGED');
    process.stdout.write(JSON.stringify({ event: 'START', cohortRuns: cohortCount, missingSourceChecks: 4,
      timeframe: MODEL.timeframe, providerGETCount: 0, executionAuthority: 'NONE' }) + '\n');
    service = createOriginalMinuteBacktestServiceV1({ sourceRoot: config.root, maxStoredRuns: 1, maxRunMs: 600_000 });
    const rows: { caseNumber: number; kind: string; result: OriginalMinuteBacktestRunV1 }[] = [];
    for (const [index, item] of cases.entries()) {
      requireThat(forbiddenNetworkAttempts === 0, 'NETWORK_ATTEMPT_DETECTED');
      const expected = normalizeOriginalMinuteBacktestRequestV1(item.request, { nowMs: Date.now() });
      const initial = await service.start(OWNER, item.request);
      let run: OriginalMinuteBacktestRunV1 | null = initial;
      const runStartedAtMs = Date.now();
      while (!TERMINAL.includes(run.status)) {
        await yieldImmediate();
        run = service.get(OWNER, initial.runId);
        requireThat(run, 'RUN_DISAPPEARED');
        requireThat(Date.now() - runStartedAtMs <= 605_000, 'RUN_DID_NOT_SETTLE');
      }
      if (!['COMPLETED', 'BLOCKED_DATA'].includes(run.status)) process.stdout.write(JSON.stringify({
        event: 'CASE_REJECTED', caseNumber: index + 1, market: expected.market, symbol: expected.symbol,
        direction: expected.direction, status: run.status, reason: REASON.test(run.reason ?? '') ? run.reason : null }) + '\n');
      assertRun(run, expected, captures);
      if (item.kind === 'MISSING_SOURCE_CHECK') {
        requireThat(run.status === 'BLOCKED_DATA', 'MISSING_SOURCE_CHECK_WRONGLY_COMPLETED');
        if (expected.market === 'CRYPTO_SPOT') requireThat((run.coverage.missingSourceDays ?? 0) > 0, 'MISSING_DAYS_NOT_EXPOSED');
      }
      rows.push({ caseNumber: index + 1, kind: item.kind, result: run });
      if ((index + 1) % 100 === 0 || index + 1 === cases.length) process.stdout.write(JSON.stringify({
        event: 'PROGRESS', finishedRuns: index + 1, plannedRuns: cases.length,
        statusCounts: statusCounts(rows.map(row => row.result)), providerGETCount: forbiddenNetworkAttempts }) + '\n');
    }
    service.dispose(); service = null;
    requireThat(forbiddenNetworkAttempts === 0, 'NETWORK_ATTEMPT_DETECTED');
    await writerIdle(config.root);
    requireThat(JSON.stringify(await codeFingerprints()) === JSON.stringify(codeContentSha256), 'CODE_CHANGED_DURING_EXECUTION');
    for (const market of Object.keys(CAPTURES) as CryptoMarket[]) await loadCapture(config.root, market);
    const cohort = rows.filter(row => row.kind === 'CURRENT_COHORT').map(row => row.result);
    const extras = rows.filter(row => row.kind === 'MISSING_SOURCE_CHECK').map(row => row.result);
    const groups = [['CRYPTO_SPOT', 'LONG'], ['CRYPTO_FUTURES', 'LONG'], ['CRYPTO_FUTURES', 'SHORT']].map(([market, direction]) => {
      const runs = cohort.filter(run => run.selection.market === market && run.selection.direction === direction);
      return { market, direction, runCount: runs.length, statusCounts: statusCounts(runs), blockedReasonCounts: reasonCounts(runs) };
    });
    const evidence = {
      schemaVersion: 'original-minute-actual-capture-backtest-evidence-v1',
      status: 'OFFLINE_APPLICATION_SOURCE_MODEL_VERIFICATION_COMPLETE_ONLY', startedAtMs, finishedAtMs: Date.now(),
      verificationMeaning: 'LOCAL_APPLICATION_EXECUTION_AND_TRUTH_BOUNDARIES_ONLY_NOT_PROFITABILITY_PASS',
      selectedUTCDate: DATE, sourceScope: 'FROZEN_CURRENT_PROVIDER_COHORT_ONE_UTC_DAY',
      sourceUniverseMemberCount: 760, historicalUniverseComplete: false, historicalDelistedPITComplete: false,
      independentlyAuthenticatedHistoricalSources: false, historicalScannerAvailabilityProven: false,
      sourceLicenseAndReuseRightsIndependentlyVerified: false, sourceRedistributionAllowed: false,
      rawHttpCandleBodiesArchived: false, quoteVolumeArchived: false, missingMinuteNoTradeProof: false,
      modelAssumptions: MODEL,
      modelAssumptionNotes: [
        'FX 1400 is an explicit research assumption for USD and USDT, not a historical published rate or a parity proof.',
        'Fees, spread, slippage, tax, latency and funding are fixed model assumptions, not independently verified historical costs.',
        'Each symbol and direction is a separate modeled run with its own initial capital; this is not a combined portfolio return.',
        'Missing originals remain BLOCKED_DATA with null results; unavailable minutes do not prove no trading occurred.',
        'Current roster membership and this one day cannot establish historical listings, removals, PIT, scanner recall, OOS or paper admission.',
      ],
      codeContentSha256, codeDigestPurpose: 'LOCAL_CODE_AND_EXECUTED_ARTIFACT_CONTENT_INTEGRITY_ONLY',
      sourceCaptures: (Object.keys(CAPTURES) as CryptoMarket[]).map(market => ({ market, ...CAPTURES[market],
        observedAtMs: captures[market].roster.observedAtMs, counts: captures[market].roster.counts,
        digestPurpose: 'CONTENT_INTEGRITY_ONLY_NOT_SOURCE_AUTHENTICATION' })),
      cohortRunCount: cohort.length, cohortStatusCounts: statusCounts(cohort), cohortBlockedReasonCounts: reasonCounts(cohort),
      missingSourceCheckCount: extras.length, missingSourceCheckStatusCounts: statusCounts(extras),
      missingSourceCheckBlockedReasonCounts: reasonCounts(extras), groups,
      allRunsPassedSourceAndSafetyAssertions: true, forbiddenNetworkAttempts,
      ...ORIGINAL_MINUTE_BACKTEST_SAFETY_V1, results: rows,
    };
    const text = JSON.stringify(evidence, null, 2) + '\n';
    requireThat(!/(?:\/workspace\/|\/tmp\/|\/private\/|api[_-]?key|authorization|Bearer |rawResponseText|minuteBars|\"stack\")/i.test(text),
      'PRIVATE_FIELDS_IN_OUTPUT');
    await outputReady(config.root, config.output);
    const output = await open(config.output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await output.writeFile(text, 'utf8'); await output.sync(); } finally { await output.close(); }
    const written = await readBounded(config.output, 64 * 1024 * 1024, true);
    requireThat(hash(written) === hash(text), 'OUTPUT_READBACK_SHA_MISMATCH');
    process.stdout.write(JSON.stringify({ event: 'COMPLETE', cohortRunCount: cohort.length,
      cohortStatusCounts: statusCounts(cohort), cohortBlockedReasonCounts: reasonCounts(cohort),
      missingSourceCheckCount: extras.length, missingSourceCheckStatusCounts: statusCounts(extras),
      missingSourceCheckBlockedReasonCounts: reasonCounts(extras), bytes: written.length, sha256: hash(written),
      providerGETCount: forbiddenNetworkAttempts, profitabilityProven: false, executionAuthority: 'NONE' }) + '\n');
  } finally {
    service?.dispose();
    globalThis.fetch = originalFetch;
  }
}

main().catch(error => {
  const message = (error as Error)?.message;
  process.stderr.write(JSON.stringify({ status: 'VERIFICATION_FAILED', code: typeof message === 'string'
    && /^P3_CAPTURE_[A-Z0-9_]+$/u.test(message) ? message : 'P3_CAPTURE_EXECUTION_FAILED',
  profitabilityProven: false, executionAuthority: 'NONE' }) + '\n');
  process.exitCode = 1;
});
