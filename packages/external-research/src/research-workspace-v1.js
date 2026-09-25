/** Read-only integration view, not a provider, compiler, backtester or promoter. */
import { createHash } from 'node:crypto';
export const WORKSPACE_SCHEMA = 'research-workspace-v1';
export const REGISTRY_SCHEMA = 'research-workspace-registry-v1';
export const MARKETS = Object.freeze(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES', 'UNKNOWN']);
export const AUTHORITY = Object.freeze({ executionAuthority: 'NONE', actualOrders: 0,
  economicEvidenceCredit: 0, profitabilityCredit: 0, canonicalSampleDelta: 0,
  paidFallback: false, automaticAdoption: false, providerInvoked: false });
const REQUIRED_RULES = ['ENTRY', 'EXIT', 'STOP_LOSS', 'POSITION_SIZING', 'EXECUTION_ASSUMPTION'];
const ACCESS = ['AUTHORIZED_TRANSCRIPT', 'OFFICIAL_VIDEO_ANALYSIS'];
const PHASES = ['EXPLORATORY', 'VALIDATION', 'FORWARD_OBSERVATION'];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = code => { const e = new Error(code); e.code = code; throw e; };
const check = (condition, code) => { if (!condition) fail(code); };
const text = (v, max = 240) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const sha = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(v);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const iso = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const integer = (v, max = 1e7) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const safeKeys = new Set(['executionAuthority', 'paidFallback', 'providerInvoked']);
function inert(value, depth = 0) {
  check(depth <= 16, 'INPUT_DEPTH_EXCEEDED');
  if (typeof value === 'string') {
    check(value.length <= 4000, 'TEXT_TOO_LONG');
    check(!/(?:\bBearer\s+\S+|sk-[A-Za-z0-9_-]{16,}|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|계좌번호)\s*[:=]\s*\S+)/i.test(value), 'SENSITIVE_INPUT');
  }
  if (Array.isArray(value)) { check(value.length <= 2000, 'INPUT_TOO_LARGE'); value.forEach(v => inert(v, depth + 1)); }
  else if (object(value)) for (const [k, v] of Object.entries(value)) {
    check(!['__proto__', 'constructor', 'prototype'].includes(k), 'UNSAFE_KEY');
    check(safeKeys.has(k) || !/(?:secret|password|apikey|api_key|accesstoken|refreshtoken)/i.test(k), 'SENSITIVE_INPUT');
    inert(v, depth + 1);
  }
  else check(value === null || ['string', 'boolean'].includes(typeof value) || finite(value), 'NON_JSON_VALUE');
}
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  return object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
}
export function evidenceDigest(value) { inert(value); return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function authority(value) {
  check(object(value) && value.executionAuthority === 'NONE' && value.economicEvidenceCredit === 0 && value.profitabilityCredit === 0, 'SOURCE_AUTHORITY_INVALID');
}
function safeSource(r, observedAt) {
  check(object(r) && text(r.videoId, 120) && text(r.title, 500), 'SOURCE_INVALID');
  check(r.canonicalUrl === `https://www.youtube.com/watch?v=${encodeURIComponent(r.videoId)}`, 'SOURCE_URL_INVALID');
  authority(r);
  check(r.contentAuthority === 'UNTRUSTED_EXTERNAL_DATA', 'SOURCE_TRUST_INVALID');
  for (const key of ['publishedAt', 'discoveredAt']) check(r[key] === null || iso(r[key]) && r[key] <= observedAt, 'SOURCE_TIMESTAMP_INVALID');
  check(r.durationSec === null || finite(r.durationSec) && r.durationSec >= 0, 'SOURCE_DURATION_INVALID');
  check(typeof r.transcriptStatus === 'string', 'TRANSCRIPT_STATUS_MISSING');
  return { sourceId: `youtube:${r.videoId}`, videoId: r.videoId, url: r.canonicalUrl, title: r.title,
    publishedAt: r.publishedAt, discoveredAt: r.discoveredAt, durationSec: r.durationSec,
    transcriptStatus: r.transcriptStatus, accessLevel: 'METADATA_ONLY', market: 'UNKNOWN' };
}
/** Input must come from the existing sanitized snapshot reader, never a browser POST. */
export function snapshotSources(evidence, { now, expectedSourceHeadSha, maxAgeMs }) {
  check(iso(now) && sha(expectedSourceHeadSha) && integer(maxAgeMs, 31 * 86400000) && maxAgeMs > 0, 'TRUST_POLICY_REQUIRED');
  if (evidence == null || evidence.available === false) return { state: 'MISSING', sourceCount: null, sources: [], snapshotDigest: null, reason: 'SANITIZED_SNAPSHOT_MISSING' };
  inert(evidence);
  check(object(evidence) && evidence.runtimeVersion === 'video-research-public-provider-runtime-v3' && evidence.status === 'SUCCESS', 'SNAPSHOT_INVALID');
  check(evidence.provider === 'YOUTUBE_DATA_API_V3' && evidence.providerAccess === 'OFFICIAL_PUBLIC_API' && evidence.requestMode === 'READ_ONLY_GET', 'SNAPSHOT_PROVIDER_INVALID');
  const p = evidence.snapshotProvenance;
  check(object(p) && p.schemaVersion === 'video-research-sanitized-snapshot-v1' && p.publisherMode === 'LOCAL_ATOMIC_FILE' && p.providerRuntimeVersion === evidence.runtimeVersion, 'SNAPSHOT_PROVENANCE_INVALID');
  authority(p); authority(evidence.safety);
  check(evidence.safety.researchOnly === true && evidence.safety.paidProviderEnabled === false && evidence.safety.scheduleActive === false && evidence.safety.automaticDiscoveryEnabled === false && evidence.safety.liveTrading === false && evidence.safety.privateTradingApi === false && evidence.safety.realOrderEnabled === false && evidence.safety.credentialMutation === false && evidence.safety.transcriptDownloadEnabled === false, 'SNAPSHOT_SAFETY_INVALID');
  check(evidence.credentialConfigured === true && evidence.credentialValueExposed === false, 'SNAPSHOT_CREDENTIAL_STATE_INVALID');
  check(p.sourceHeadSha === expectedSourceHeadSha, 'SNAPSHOT_HEAD_MISMATCH');
  check(iso(p.observedAt) && p.observedAt <= now, 'SNAPSHOT_TIME_INVALID');
  if (Date.parse(now) - Date.parse(p.observedAt) > maxAgeMs) return { state: 'STALE', sourceCount: null, sources: [], snapshotDigest: null, reason: 'SNAPSHOT_STALE' };
  check(integer(evidence.sourceCount, 5) && Array.isArray(evidence.records) && evidence.records.length === evidence.sourceCount, 'SOURCE_COUNT_INVALID');
  const sources = evidence.records.map(r => safeSource(r, p.observedAt));
  check(new Set(sources.map(r => r.sourceId)).size === sources.length, 'DUPLICATE_SOURCE');
  // Deliberately excludes request credentials and claims not in the sanitized source projection.
  const snapshotDigest = evidenceDigest({ sourceHeadSha: p.sourceHeadSha, observedAt: p.observedAt, sources });
  return { state: 'MEASURED', sourceCount: sources.length, sources, snapshotDigest, reason: null, observedAt: p.observedAt };
}
function proof(proof, source, now) {
  check(object(proof) && ACCESS.includes(proof.accessLevel), 'CONTENT_PROOF_REQUIRED');
  check(proof.sourceId === source.sourceId && digest(proof.inputDigest) && digest(proof.outputDigest), 'CONTENT_IDENTITY_MISMATCH');
  check(text(proof.provider) && text(proof.model) && id(proof.receiptId), 'CONTENT_RECEIPT_REQUIRED');
  check(proof.authorized === true && proof.paidFallback === false && iso(proof.completedAt) && proof.completedAt <= now, 'CONTENT_ACCESS_INVALID');
  check(source.publishedAt === null || source.publishedAt <= proof.completedAt, 'CONTENT_BEFORE_PUBLICATION');
  return { accessLevel: proof.accessLevel, provider: proof.provider, model: proof.model,
    completedAt: proof.completedAt, inputDigest: proof.inputDigest, outputDigest: proof.outputDigest, receiptId: proof.receiptId };
}
function rules(value, segments, source, content) {
  check(Array.isArray(segments) && segments.length <= 200 && Array.isArray(value) && value.length <= 60, 'RULES_INVALID');
  const segmentMap = new Map();
  for (const s of segments) {
    check(object(s) && id(s.id) && s.sourceId === source.sourceId && s.contentDigest === content.outputDigest, 'SEGMENT_IDENTITY_INVALID');
    check(!segmentMap.has(s.id), 'DUPLICATE_SEGMENT');
    check(finite(s.startSec) && finite(s.endSec) && s.startSec >= 0 && s.endSec > s.startSec && source.durationSec !== null && s.endSec <= source.durationSec, 'SEGMENT_RANGE_INVALID');
    check(text(s.excerpt, 600), 'SEGMENT_EXCERPT_REQUIRED');
    segmentMap.set(s.id, s);
  }
  const ids = new Set();
  return value.map(r => {
    check(object(r) && id(r.id) && !ids.has(r.id) && REQUIRED_RULES.includes(r.kind) && text(r.text, 1000), 'RULE_INVALID'); ids.add(r.id);
    check(['SOURCE_RULE', 'AI_ASSUMPTION'].includes(r.origin), 'RULE_ORIGIN_INVALID');
    check(Array.isArray(r.segmentIds) && r.segmentIds.length <= 20 && r.segmentIds.every(x => segmentMap.has(x)), 'RULE_SUPPORT_INVALID');
    check(r.origin !== 'SOURCE_RULE' || r.segmentIds.length > 0, 'RULE_SUPPORT_MISSING');
    check(r.origin !== 'AI_ASSUMPTION' || text(r.rationale, 500), 'ASSUMPTION_RATIONALE_REQUIRED');
    return { id: r.id, kind: r.kind, text: r.text, origin: r.origin,
      rationale: r.origin === 'AI_ASSUMPTION' ? r.rationale : null,
      evidence: r.segmentIds.map(k => { const s = segmentMap.get(k); return { startSec: s.startSec, endSec: s.endSec, excerpt: s.excerpt }; }) };
  });
}
export function strategyDigest(entry) {
  return evidenceDigest({ strategyId: entry.strategyId, version: entry.version, sourceId: entry.sourceId,
    contentProof: entry.contentProof, market: entry.market, timeframe: entry.timeframe,
    rules: entry.rules, segments: entry.segments });
}
export function backtestProjectionDigest(run) {
  return evidenceDigest(Object.fromEntries(Object.entries(run).filter(([key]) => key !== 'summaryDigest')));
}
function runView(run, entry, now) {
  if (run == null) return null;
  check(object(run) && run.schemaVersion === 'research-linked-backtest-v1', 'RUN_SCHEMA_INVALID');
  check(run.strategyDigest === strategyDigest(entry) && run.strategyId === entry.strategyId && run.version === entry.version && run.market === entry.market && run.timeframe === entry.timeframe, 'RUN_STRATEGY_MISMATCH');
  check(id(run.runId) && digest(run.resultDigest) && digest(run.datasetDigest) && sha(run.codeSha), 'RUN_PROVENANCE_REQUIRED');
  check(iso(run.startAt) && iso(run.endAt) && iso(run.completedAt) && run.startAt < run.endAt && run.endAt <= run.completedAt && run.completedAt <= now, 'RUN_TIME_INVALID');
  check(run.completedAt >= entry.contentProof.completedAt && PHASES.includes(run.validationClass), 'RUN_PHASE_INVALID');
  check(run.executionAuthority === 'NONE' && run.actualOrders === 0 && run.canonicalSampleDelta === 0, 'RUN_AUTHORITY_INVALID');
  check(integer(run.tradeCount) && finite(run.netReturn) && run.netReturn >= -1 && finite(run.maxDrawdown) && run.maxDrawdown >= 0 && run.maxDrawdown <= 1 && run.costsIncluded === true, 'RUN_METRICS_INVALID');
  check(run.tradeCount > 0 || run.netReturn === 0 && run.maxDrawdown === 0, 'EMPTY_RUN_METRICS_INVALID');
  check(digest(run.summaryDigest) && run.summaryDigest === backtestProjectionDigest(run), 'RUN_SUMMARY_DIGEST_MISMATCH');
  // Classification is a producer claim, not independently verified by this read model.
  return { runId: run.runId, resultDigest: run.resultDigest, datasetDigest: run.datasetDigest, codeSha: run.codeSha,
    startAt: run.startAt, endAt: run.endAt, completedAt: run.completedAt, tradeCount: run.tradeCount,
    netReturn: run.netReturn, maxDrawdown: run.maxDrawdown, costsIncluded: true,
    reportedValidationClass: run.validationClass, independentlyVerified: false,
    dayTargetStatus: 'NOT_EVALUATED', dailyReturn: null, winProbability: null };
}
function entryView(e, source, now) {
  check(object(e) && id(e.strategyId) && id(e.version) && MARKETS.includes(e.market) && e.market !== 'UNKNOWN' && ['1m','5m','15m','30m','1h','4h','1D'].includes(e.timeframe), 'STRATEGY_IDENTITY_INVALID');
  const content = proof(e.contentProof, source, now);
  const parsedRules = rules(e.rules, e.segments, source, content);
  const missing = REQUIRED_RULES.filter(k => !parsedRules.some(r => r.kind === k));
  const assumptions = parsedRules.filter(r => r.origin === 'AI_ASSUMPTION');
  const run = runView(e.run, e, now);
  check(!run || missing.length === 0, 'RUN_WITH_INCOMPLETE_RULES');
  return { id: `${e.strategyId}@${e.version}`, strategyId: e.strategyId, version: e.version,
    sourceId: e.sourceId, market: e.market, timeframe: e.timeframe, content,
    strategyDigest: strategyDigest(e), rules: parsedRules, missingRules: missing, run,
    state: run ? 'BACKTEST_RECORDED' : missing.length ? 'RULES_INCOMPLETE' : 'COMPILER_REVIEW_REQUIRED',
    assumptionCount: assumptions.length,
    actions: { inspect: true, scannerApply: false, paperApply: false, liveApply: false,
      reason: 'CANONICAL_VALIDATION_AND_EXPLICIT_APPROVAL_REQUIRED' } };
}
/** Hash checks preserve identity, NOT signatures/authorization or profitability proof. */
export function buildResearchWorkspace({ videoEvidence = null, registry = null, policy }) {
  let input;
  try { input = snapshotSources(videoEvidence, policy); }
  catch (e) { return { schemaVersion: WORKSPACE_SCHEMA, sourceState: 'INVALID', sourceReason: e.code ?? 'SNAPSHOT_INVALID', sourceCount: null,
    sources: [], strategies: [], registryState: 'BLOCKED', registryReason: 'SOURCE_INVALID', workerState: 'UNVERIFIED', authority: AUTHORITY }; }
  const result = { schemaVersion: WORKSPACE_SCHEMA, sourceState: input.state, sourceReason: input.reason,
    sourceCount: input.sourceCount, sources: input.sources, sourceSnapshotDigest: input.snapshotDigest,
    strategies: [], registryState: registry === null ? 'MISSING' : 'BLOCKED', registryReason: null,
    workerState: 'UNVERIFIED', authority: AUTHORITY };
  if (registry === null) return result;
  if (input.state !== 'MEASURED') { result.registryReason = 'SOURCE_UNAVAILABLE'; return result; }
  try {
    inert(registry);
    check(registry.schemaVersion === REGISTRY_SCHEMA && registry.sourceSnapshotDigest === input.snapshotDigest, 'REGISTRY_SOURCE_MISMATCH');
    check(iso(registry.generatedAt) && registry.generatedAt <= policy.now, 'REGISTRY_TIME_INVALID');
    check(Array.isArray(registry.entries) && registry.entries.length <= 200, 'REGISTRY_ENTRIES_INVALID');
    const entries = [], identities = new Set(), bySource = new Map(input.sources.map(s => [s.sourceId, s]));
    for (const e of registry.entries) {
      check(bySource.has(e.sourceId), 'REGISTRY_ORPHAN_SOURCE');
      const parsed = entryView(e, bySource.get(e.sourceId), registry.generatedAt);
      check(!identities.has(parsed.id), 'DUPLICATE_STRATEGY_VERSION'); identities.add(parsed.id); entries.push(parsed);
    }
    result.registryState = 'READABLE'; result.strategies = entries;
    return result;
  } catch (e) { result.registryState = 'INVALID'; result.registryReason = e.code ?? 'REGISTRY_INVALID'; return result; }
}
export function selectWorkspaceStrategies(view, group = 'ALL', market = 'ALL') {
  check(['ALL','STOCK','CRYPTO'].includes(group) && (market === 'ALL' || MARKETS.includes(market)), 'FILTER_INVALID');
  return view.strategies.filter(s => (group === 'ALL' || (group === 'STOCK' ? s.market.endsWith('_STOCK') : s.market.startsWith('CRYPTO_'))) && (market === 'ALL' || s.market === market));
}
