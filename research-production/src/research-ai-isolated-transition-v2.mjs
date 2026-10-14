import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseEnv } from 'node:util';

import {
  loadAutonomousResearchNextDirectiveV1,
  rebindAutonomousResearchNextDirectiveV1,
} from './autonomous-research-closed-loop-v1.mjs';
import { runAutonomousResearchCycleV2 } from './autonomous-research-cycle-v2.mjs';
import { runResearchAiReviewScan } from './research-ai-review-worker.mjs';
import { runResearchVideoDiscoveryScan } from './research-video-discovery-worker.mjs';

const SHA40 = /^[a-f0-9]{40}$/u;
const MAX_ENV_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const PROFILE_NAMES = Object.freeze(['forward', 'fast-historical', 'long-history']);
const PROVIDER_KEYS = new Set([
  'YOUTUBE_DATA_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_MODEL', 'GROQ_API_KEY', 'GROQ_MODEL',
]);
const AI_POLICY_KEYS = new Set(['RESEARCH_AI_FREE_TIER_CONFIRMED', 'AI_CHAT_PROVIDER', 'RESEARCH_AI_MAX_CALLS_PER_SCAN']);
const VIDEO_POLICY_KEYS = new Set([
  'RESEARCH_VIDEO_DISCOVERY_APPROVED', 'RESEARCH_VIDEO_DISCOVERY_MAX_RESULTS',
  'RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON', 'RESEARCH_VIDEO_DISCOVERY_REGION_CODE',
  'RESEARCH_VIDEO_DISCOVERY_RELEVANCE_LANGUAGE', 'RESEARCH_VIDEO_DISCOVERY_PUBLISHED_AFTER_HOURS',
]);

function exactSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA40.test(sha)) throw new Error('ISOLATED_TRANSITION_TARGET_SHA_INVALID');
  return sha;
}

function absoluteRoot(value, code) {
  const raw = String(value ?? '').trim();
  if (!raw || !isAbsolute(raw) || resolve(raw) !== raw) throw new Error(code);
  return raw;
}

function overlaps(left, right) {
  const fromLeft = relative(left, right);
  const fromRight = relative(right, left);
  return fromLeft === '' || (!fromLeft.startsWith('..') && !isAbsolute(fromLeft))
    || (!fromRight.startsWith('..') && !isAbsolute(fromRight));
}

async function boundedFile(path, maximumBytes) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error('ISOLATED_TRANSITION_FILE_SYMLINK_FORBIDDEN');
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximumBytes
      || (before.mode & 0o007) !== 0) throw new Error('ISOLATED_TRANSITION_FILE_UNSAFE');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || after.nlink !== 1) throw new Error('ISOLATED_TRANSITION_FILE_CHANGED');
    return bytes;
  } finally {
    await handle.close();
  }
}

async function boundedJson(path, { optional = false } = {}) {
  try {
    const bytes = await boundedFile(path, MAX_JSON_BYTES);
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('ISOLATED_TRANSITION_JSON_INVALID');
    throw error;
  }
}

async function atomicJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

async function readRestrictedEnv(path, allowedKeys) {
  const parsed = parseEnv((await boundedFile(path, MAX_ENV_BYTES)).toString('utf8'));
  for (const key of Object.keys(parsed)) if (!allowedKeys.has(key)) throw new Error(`ISOLATED_TRANSITION_ENV_KEY_FORBIDDEN:${key}`);
  return parsed;
}

async function isolatedRuntimeEnv({ providerEnvPath, aiPolicyEnvPath, videoPolicyEnvPath, inheritedEnv }) {
  const [providers, aiPolicy, videoPolicy] = await Promise.all([
    readRestrictedEnv(providerEnvPath, PROVIDER_KEYS),
    readRestrictedEnv(aiPolicyEnvPath, AI_POLICY_KEYS),
    readRestrictedEnv(videoPolicyEnvPath, VIDEO_POLICY_KEYS),
  ]);
  const transport = Object.fromEntries([
    'PATH', 'LANG', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  ].filter((key) => typeof inheritedEnv[key] === 'string').map((key) => [key, inheritedEnv[key]]));
  return Object.freeze({
    ...transport,
    ...aiPolicy,
    ...videoPolicy,
    ...providers,
    RESEARCH_AI_INVOCATION_MODE: 'MANUAL',
    RESEARCH_VIDEO_INVOCATION_MODE: 'MANUAL',
    LIVE_TRADING: 'false',
    LIVE_TRADING_ENABLED: 'false',
    REAL_ORDER_ENABLED: 'false',
    REAL_TRADING_ENABLED: 'false',
    PRIVATE_API_ENABLED: 'false',
    PRIVATE_ACCOUNT_ACCESS: 'false',
    PRIVATE_TRADING_API_ALLOWED: 'false',
    ORDER_AUTHORITY: 'false',
    ORDER_SUBMISSION_ENABLED: 'false',
  });
}

async function prepareEmptyRoot(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())
    || await realpath(path) !== path) throw new Error('ISOLATED_TRANSITION_STATE_ROOT_UNSAFE');
  if ((await readdir(path)).length !== 0) throw new Error('ISOLATED_TRANSITION_STATE_ROOT_NOT_EMPTY');
  await mkdir(join(path, 'latest'), { mode: 0o700 });
  await mkdir(join(path, 'transition-evidence'), { mode: 0o700 });
}

async function verifySourceRoot(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error('ISOLATED_TRANSITION_SOURCE_ROOT_UNSAFE');
  }
}

async function seedProfile({ sourceStateRoot, isolatedStateRoot, profile, researchSha }) {
  const source = await boundedJson(join(sourceStateRoot, 'latest', `${profile}.json`), { optional: true });
  if (source == null) return Object.freeze({ profile, state: 'MISSING' });
  // The production fast-historical lane uses the independent v2 historical
  // pipeline writer; forward and long-history use the canonical v1 writer.
  // Preserve the original evidence schema and SHA when seeding isolated state.
  const schemaSupported = source?.schemaVersion === 'research-production-cycle-v1'
    || (profile === 'fast-historical' && source?.schemaVersion === 'research-production-historical-cycle-v2');
  if (!schemaSupported || source?.profile !== profile
    || !SHA40.test(String(source?.researchSha ?? ''))
    || !['complete', 'partial_failure', 'blocked_data'].includes(source?.status)) {
    throw new Error(`ISOLATED_TRANSITION_PROFILE_INVALID:${profile}`);
  }
  await atomicJson(join(isolatedStateRoot, 'latest', `${profile}.json`), source);
  return Object.freeze({
    profile,
    state: source.researchSha === researchSha ? 'CURRENT_SHA_COPY' : 'STALE_RELEASE_EVIDENCE_PRESERVED',
    sourceResearchSha: source.researchSha,
    sourceStatus: source.status,
  });
}

function safeProfilePreflightReason(error) {
  const message = String(error?.message ?? '');
  if (/^ISOLATED_TRANSITION_[A-Z0-9_]+(?::[a-z-]+)?$/u.test(message)) return message;
  if (['EACCES', 'ELOOP', 'EPERM'].includes(error?.code)) return `PROFILE_SOURCE_${error.code}`;
  return 'ISOLATED_TRANSITION_PROFILE_SOURCE_READ_ERROR';
}

// Examine *all* current profile snapshots before a live provider request.
// Keep original SHA, status and schema unchanged; fail closed with one
// bounded, sanitized aggregate instead of discovering one missing contract
// after each production-environment approval.
async function seedAllResearchProfilesV2({ sourceStateRoot, isolatedStateRoot, researchSha }) {
  const profiles = [];
  const blockers = [];
  for (const profile of PROFILE_NAMES) {
    try {
      profiles.push(await seedProfile({ sourceStateRoot, isolatedStateRoot, profile, researchSha }));
    } catch (error) {
      blockers.push(`${profile}=${safeProfilePreflightReason(error)}`);
    }
  }
  if (blockers.length !== 0) {
    throw new Error(`ISOLATED_TRANSITION_PROFILE_PREFLIGHT_BLOCKERS:${blockers.join('|')}`);
  }
  return profiles;
}

function verifyCycle(cycle) {
  if (cycle?.status !== 'COMPLETE' || cycle?.directiveConsumed !== true || cycle?.discoveryStatus !== 'DOSSIER_STAGED'
    || cycle?.actualProviderCalls?.attempted !== 2 || cycle?.actualProviderCalls?.succeeded !== 2
    || cycle?.actualProviderCalls?.failed !== 0 || cycle?.actualSourceFetches?.attempted !== 3
    || cycle?.actualSourceFetches?.succeeded !== 3 || cycle?.actualSourceFetches?.failed !== 0
    || !Number.isSafeInteger(cycle?.formulaGeneratedCount) || cycle.formulaGeneratedCount < 1
    || !Number.isSafeInteger(cycle?.actualBacktestCount) || cycle.actualBacktestCount < 1
    || cycle?.safety?.executionAuthority !== 'NONE' || cycle?.safety?.realOrder !== false) {
    throw new Error(`ISOLATED_TRANSITION_NATURAL_CYCLE_NOT_PROVEN:${String(cycle?.reason ?? cycle?.status ?? 'MISSING')}`);
  }
}

function verifyReview(review) {
  if (!['COMPLETE', 'PARTIAL_COVERAGE_COMPLETE'].includes(review?.status)
    || !Number.isSafeInteger(review?.providerNetworkCalls) || !Number.isSafeInteger(review?.cacheHits)
    || review.providerNetworkCalls + review.cacheHits < 1
    || !Array.isArray(review?.reviews) || review.reviews.length < 1
    || !Array.isArray(review?.blockedProfiles) || review.blockedProfiles.length !== 0
    || review?.safety?.executionAuthority !== 'NONE') {
    const leaf = Array.isArray(review?.blockedProfiles) ? review.blockedProfiles[0]?.reason : null;
    throw new Error(`ISOLATED_TRANSITION_AI_REVIEW_NOT_PROVEN:${String(leaf ?? review?.reason ?? review?.status ?? 'MISSING')}`);
  }
}

function verifyVideo(video) {
  if (video?.status !== 'COMPLETE' || video?.provider !== 'YOUTUBE_DATA_API_V3'
    || !Number.isSafeInteger(video?.providerNetworkCalls) || video.providerNetworkCalls < 1
    || !Number.isSafeInteger(video?.sourceCount) || video.sourceCount < 0
    || video?.safety?.executionAuthority !== 'NONE') {
    throw new Error(`ISOLATED_TRANSITION_VIDEO_NOT_PROVEN:${String(video?.reason ?? video?.status ?? 'MISSING')}`);
  }
}

export async function runResearchAiIsolatedTransitionV2({
  sourceStateRoot: rawSourceStateRoot,
  isolatedStateRoot: rawIsolatedStateRoot,
  repoRoot: rawRepoRoot,
  researchSha: rawResearchSha,
  providerEnvPath,
  aiPolicyEnvPath,
  videoPolicyEnvPath,
  maximumCycles = 1,
  inheritedEnv = process.env,
  now = () => new Date().toISOString(),
  runCycle = runAutonomousResearchCycleV2,
  runReview = runResearchAiReviewScan,
  runVideo = runResearchVideoDiscoveryScan,
} = {}) {
  const researchSha = exactSha(rawResearchSha);
  const sourceStateRoot = absoluteRoot(rawSourceStateRoot, 'ISOLATED_TRANSITION_SOURCE_ROOT_INVALID');
  const isolatedStateRoot = absoluteRoot(rawIsolatedStateRoot, 'ISOLATED_TRANSITION_STATE_ROOT_INVALID');
  const repoRoot = absoluteRoot(rawRepoRoot, 'ISOLATED_TRANSITION_REPO_ROOT_INVALID');
  if (overlaps(sourceStateRoot, isolatedStateRoot)) throw new Error('ISOLATED_TRANSITION_STATE_ROOT_OVERLAP');
  if (!Number.isSafeInteger(maximumCycles) || maximumCycles < 1 || maximumCycles > 2) {
    throw new Error('ISOLATED_TRANSITION_CYCLE_LIMIT_INVALID');
  }
  await verifySourceRoot(sourceStateRoot);
  await prepareEmptyRoot(isolatedStateRoot);
  const env = await isolatedRuntimeEnv({ providerEnvPath, aiPolicyEnvPath, videoPolicyEnvPath, inheritedEnv });
  const startedAt = now();
  const sourceDirective = await loadAutonomousResearchNextDirectiveV1({ stateRoot: sourceStateRoot });
  let directiveSeed = Object.freeze({ state: 'CREATED_BY_ISOLATED_LOOP', sourceDirectiveDigest: null, isolatedDirectiveDigest: null });
  if (sourceDirective) {
    const rebound = rebindAutonomousResearchNextDirectiveV1({ directive: sourceDirective, researchCodeSha: researchSha, observedAt: startedAt });
    await atomicJson(join(isolatedStateRoot, 'latest', 'autonomous-research-next-directive.json'), rebound);
    directiveSeed = Object.freeze({
      state: sourceDirective.researchCodeSha === researchSha ? 'EXACT_SHA_DIRECTIVE_COPIED' : 'STALE_SHA_DIRECTIVE_REBOUND',
      sourceResearchSha: sourceDirective.researchCodeSha,
      sourceDirectiveDigest: sourceDirective.directiveDigest,
      isolatedDirectiveDigest: rebound.directiveDigest,
      failureCodesPreserved: rebound.failureCodes.length,
      failedFamiliesPreserved: rebound.failedFamilies.length,
      blockedStrategiesPreserved: rebound.blockedStrategyIdentityDigests.length,
    });
  }
  const profiles = await seedAllResearchProfilesV2({
    sourceStateRoot, isolatedStateRoot, researchSha,
  });
  const reviewSeed = profiles.find((row) => row.profile === 'forward' && row.sourceResearchSha)
    ?? profiles.find((row) => row.sourceResearchSha);
  if (!reviewSeed) throw new Error('ISOLATED_TRANSITION_REVIEW_EVIDENCE_MISSING');

  const cycles = [];
  for (let index = 0; index < maximumCycles; index += 1) {
    const cycle = await runCycle({ stateRoot: isolatedStateRoot, researchCodeSha: researchSha, env });
    verifyCycle(cycle);
    if (cycles.some((previous) => previous.selectedNextStrategy?.sourceRevision === cycle.selectedNextStrategy?.sourceRevision
      && previous.selectedNextStrategy?.sourcePath === cycle.selectedNextStrategy?.sourcePath)) {
      throw new Error('ISOLATED_TRANSITION_DUPLICATE_STRATEGY_SELECTED');
    }
    cycles.push(cycle);
    await atomicJson(join(isolatedStateRoot, 'transition-evidence', `natural-cycle-${index + 1}.json`), cycle);
  }
  const loopState = await boundedJson(join(isolatedStateRoot, 'autonomous-research', 'releases', researchSha, 'state.json'));
  if (loopState?.contract !== 'autonomous-research-closed-loop-state/v1'
    || loopState?.researchCodeSha !== researchSha || !Array.isArray(loopState?.records)) {
    throw new Error('ISOLATED_TRANSITION_CLOSED_LOOP_STATE_INVALID');
  }
  const records = cycles.map((cycle) => loopState.records.find((row) => row?.dossierDigest === cycle.stagedDossierDigest));
  if (records.some((row) => !row || row.executionAuthority !== 'NONE' || row.itemDigest == null || row.metrics == null)) {
    throw new Error('ISOLATED_TRANSITION_BACKTEST_RECORD_MISSING');
  }
  const review = await runReview({
    repoRoot, stateRoot: isolatedStateRoot, researchSha: reviewSeed.sourceResearchSha, env,
    // Compatibility is checked against immutable pre-cutover evidence. It is
    // never re-labelled as target-SHA evidence; activation later requires a
    // fresh target-SHA one-shot after the release cutover.
    verifyGitHead: false,
    maxCalls: Number(env.RESEARCH_AI_MAX_CALLS_PER_SCAN ?? 3),
  });
  verifyReview(review);
  const video = await runVideo({ repoRoot, stateRoot: isolatedStateRoot, researchSha, env });
  verifyVideo(video);

  const result = Object.freeze({
    schemaVersion: 'research-ai-isolated-transition-v2',
    status: 'PASS',
    targetSha: researchSha,
    startedAt,
    completedAt: now(),
    productionStateMutated: false,
    isolatedStateRoot,
    directiveSeed,
    seededProfiles: Object.freeze(profiles),
    naturalCycleCount: cycles.length,
    strategies: Object.freeze(cycles.map((cycle, index) => Object.freeze({
      repository: cycle.selectedNextStrategy.repository,
      sourcePath: cycle.selectedNextStrategy.sourcePath,
      sourceRevision: cycle.selectedNextStrategy.sourceRevision,
      family: cycle.selectedNextStrategy.family,
      templateId: cycle.selectedNextStrategy.templateId,
      formulaGeneratedCount: 1,
      actualBacktestCount: 1,
      disposition: records[index].disposition,
      metrics: records[index].metrics,
    }))),
    formulaCandidateCount: records.filter((row) => row.itemDigest != null).length,
    actualBacktestCount: records.filter((row) => row.metrics != null).length,
    failureMemoryCount: cycles.at(-1)?.failureObservationCount ?? 0,
    nextDirectiveGenerated: true,
    actualProviderCalls: cycles.reduce((sum, cycle) => sum + cycle.actualProviderCalls.succeeded, 0),
    actualSourceFetches: cycles.reduce((sum, cycle) => sum + cycle.actualSourceFetches.succeeded, 0),
    aiReview: Object.freeze({ status: review.status, evidenceResearchSha: reviewSeed.sourceResearchSha,
      exactTargetEvidence: reviewSeed.sourceResearchSha === researchSha, provider: review.provider, model: review.model,
      providerNetworkCalls: review.providerNetworkCalls, cacheHits: review.cacheHits, reviewCount: review.reviews.length }),
    youtube: Object.freeze({ status: video.status, providerNetworkCalls: video.providerNetworkCalls,
      sourceCount: video.sourceCount, zeroResult: video.sourceCount === 0, zeroResultReason: video.zeroResultReason ?? null }),
    paperActivated: false,
    actualPaperEntryCount: 0,
    actualPaperExitCount: 0,
    providerSecretValuesExposed: false,
    liveTrading: false,
    privateTradingApiAllowed: false,
    realOrderEnabled: false,
    executionAuthority: 'NONE',
  });
  await atomicJson(join(isolatedStateRoot, 'isolated-transition-proof.json'), result);
  return result;
}
