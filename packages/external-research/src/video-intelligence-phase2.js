import { createHash } from 'node:crypto';
import { assertResearchPaperV2 } from './contract.js';
import {
  assertResearchVideoSourceV1,
  createResearchVideoSourceV1,
  createVideoStrategyHypothesisV1,
  inspectVideoContentFirewallV1,
} from './video-intelligence.js';

export const VIDEO_TRANSCRIPT_STATUSES_V2 = Object.freeze([
  'AVAILABLE','UNAVAILABLE','NOT_AUTHORIZED','NOT_PROVIDED','UNSUPPORTED','PROVIDER_NOT_CONFIGURED','RATE_LIMITED','QUOTA_EXCEEDED','PARSE_FAILED','UNKNOWN',
]);
export const VIDEO_CLAIM_TYPES_V2 = Object.freeze([
  'FACT','CREATOR_CLAIM','STRATEGY_RULE','OPINION','EXAMPLE','HYPOTHESIS','PROMOTIONAL_CLAIM','UNCERTAIN',
]);
export const VIDEO_RULE_TYPES_V2 = Object.freeze([
  'ENTRY','EXIT','STOP_LOSS','TAKE_PROFIT','POSITION_SIZING','INDICATOR','REGIME','INVALIDATION','HOLDING_PERIOD','EXECUTION_ASSUMPTION',
]);
export const SOURCE_INDEPENDENCE_STATUSES_V2 = Object.freeze(['SAME_SOURCE','LIKELY_DERIVED','INDEPENDENT_SOURCE','UNKNOWN']);
export const STRATEGY_CONSENSUS_STATUSES_V2 = Object.freeze(['CONSISTENT','PARTIAL_AGREEMENT','CONFLICTING','UNKNOWN']);
export const SOURCE_TRUST_TIERS_V2 = Object.freeze(['TIER_A_OFFICIAL','TIER_B_ACADEMIC','TIER_C_PRIMARY_EXPERT','TIER_D_SECONDARY_EDUCATIONAL','TIER_E_UNVERIFIED_CREATOR','UNKNOWN']);
export const VIDEO_TESTABILITY_STATUSES_V2 = Object.freeze(['TESTABLE','PARTIALLY_TESTABLE','NON_TESTABLE_STRATEGY','MISSING_ENTRY','MISSING_EXIT','MISSING_TIMEFRAME','MISSING_MARKET','AMBIGUOUS_RULE','CONTRADICTORY_RULES','UNSUPPORTED_RULE','COMPILER_BLOCKED']);

const YOUTUBE_SEARCH_ENDPOINT = 'https://www.googleapis.com/youtube/v3/search';
const YOUTUBE_VIDEOS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos';
const UNCERTAINTY = new Set(['LOW','MEDIUM','HIGH','UNKNOWN','RULE_EXPLICIT','RULE_INFERRED','RULE_AMBIGUOUS']);
const CLAIM_TYPES = new Set(VIDEO_CLAIM_TYPES_V2);
const RULE_TYPES = new Set(VIDEO_RULE_TYPES_V2);
const POLARITIES = new Set(['REQUIRE','AVOID','UNKNOWN']);
const TRANSCRIPT_STATUSES = new Set(VIDEO_TRANSCRIPT_STATUSES_V2);

export class VideoResearchPhase2Error extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'VideoResearchPhase2Error';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, details = {}) { throw new VideoResearchPhase2Error(code, details); }
function freeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.values(value).forEach(freeze); return Object.freeze(value); }
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
function sha(value) { return createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex'); }
function text(value, code) { if (typeof value !== 'string' || !value.trim()) fail(code); return value.trim(); }
function optionalText(value, code) { return value == null ? null : text(value, code); }
function finite(value, code) { if (!Number.isFinite(value) || value < 0) fail(code); return value; }
function iso(value, code) { const normalized = text(value, code); if (!Number.isFinite(Date.parse(normalized))) fail(code); return new Date(normalized).toISOString(); }
function canonicalText(value) { return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim(); }
function safety() { return freeze({ researchOnly:true,economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE',toolInvocationFromContent:0,secretAccess:0,deployAuthority:0,tradingAuthority:0,economicPromotion:0,paidProviderEnabled:false,scheduleActive:false,automaticDiscoveryEnabled:false,providerCredentialMutation:false }); }
function asArray(value, code) { if (!Array.isArray(value)) fail(code); return value; }
function unique(values) { return [...new Set(values)].sort(); }
function boundedInt(value, fallback, min, max, code) { const v = value == null ? fallback : value; if (!Number.isSafeInteger(v) || v < min || v > max) fail(code); return v; }

function parseYoutubeDuration(value) {
  if (typeof value !== 'string') return null;
  const match = /^P(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)S)?)?$/u.exec(value);
  if (!match) return null;
  return ((Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 60 + Number(match[3] ?? 0)) * 60 + Number(match[4] ?? 0);
}

async function responseJson(response) {
  try { return await response.json(); } catch { return null; }
}

function youtubeErrorStatus(response, payload) {
  const reasons = payload?.error?.errors?.map((entry) => entry?.reason).filter(Boolean) ?? [];
  if (response?.status === 429) return 'RATE_LIMITED';
  if (response?.status === 403 && reasons.some((reason) => /quota/iu.test(reason))) return 'QUOTA_EXCEEDED';
  if (response?.status === 403) return 'DISCOVERY_UNAVAILABLE';
  return 'PROVIDER_UNAVAILABLE';
}

export function createYoutubeDiscoveryClientV2({ apiKey = null, fetchImpl = globalThis.fetch, limits = {} } = {}) {
  const maxResultsPerQuery = boundedInt(limits.maxResultsPerQuery, 10, 1, 50, 'VIDEO_DISCOVERY_MAX_RESULTS_INVALID');
  const maxPagesPerRun = boundedInt(limits.maxPagesPerRun, 2, 1, 5, 'VIDEO_DISCOVERY_MAX_PAGES_INVALID');
  const maxVideosPerResearchBatch = boundedInt(limits.maxVideosPerResearchBatch, 20, 1, 100, 'VIDEO_DISCOVERY_BATCH_LIMIT_INVALID');
  const configured = typeof apiKey === 'string' && apiKey.trim().length > 0;
  if (fetchImpl != null && typeof fetchImpl !== 'function') fail('VIDEO_DISCOVERY_FETCH_INVALID');

  return freeze({
    provider: 'YOUTUBE_DATA_API_V3',
    officialPublicPathOnly: true,
    paidProviderEnabled: false,
    automaticDiscoveryEnabled: false,
    scheduleActive: false,
    providerCredentialMutation: false,
    limits: { maxResultsPerQuery, maxPagesPerRun, maxVideosPerResearchBatch },
    async discover({ query, channelId = null, relevanceLanguage = null, regionCode = null, requireCaptions = false, maxResults = maxResultsPerQuery, maxPages = 1, discoveredAt = new Date().toISOString(), discoveryReason = 'KEYWORD_RESEARCH' } = {}) {
      const q = text(query, 'VIDEO_DISCOVERY_QUERY_REQUIRED');
      const requestedResults = boundedInt(maxResults, maxResultsPerQuery, 1, maxResultsPerQuery, 'VIDEO_DISCOVERY_MAX_RESULTS_INVALID');
      const requestedPages = boundedInt(maxPages, 1, 1, maxPagesPerRun, 'VIDEO_DISCOVERY_MAX_PAGES_INVALID');
      const timestamp = iso(discoveredAt, 'VIDEO_DISCOVERY_TIME_INVALID');
      if (!configured) return freeze({ status:'PROVIDER_NOT_CONFIGURED',provider:'YOUTUBE_DATA_API_V3',query:q,records:[],pagesUsed:0,quotaState:'NOT_CONFIGURED',safety:safety() });
      if (typeof fetchImpl !== 'function') return freeze({ status:'PROVIDER_UNAVAILABLE',provider:'YOUTUBE_DATA_API_V3',query:q,records:[],pagesUsed:0,quotaState:'UNKNOWN',safety:safety() });

      const records = [];
      let pageToken = null;
      let pagesUsed = 0;
      for (let page = 0; page < requestedPages && records.length < maxVideosPerResearchBatch; page += 1) {
        const searchUrl = new URL(YOUTUBE_SEARCH_ENDPOINT);
        searchUrl.searchParams.set('part', 'snippet');
        searchUrl.searchParams.set('type', 'video');
        searchUrl.searchParams.set('q', q);
        searchUrl.searchParams.set('maxResults', String(Math.min(requestedResults, maxVideosPerResearchBatch - records.length)));
        searchUrl.searchParams.set('key', apiKey.trim());
        if (channelId) searchUrl.searchParams.set('channelId', text(channelId, 'VIDEO_DISCOVERY_CHANNEL_ID_INVALID'));
        if (relevanceLanguage) searchUrl.searchParams.set('relevanceLanguage', text(relevanceLanguage, 'VIDEO_DISCOVERY_LANGUAGE_INVALID'));
        if (regionCode) searchUrl.searchParams.set('regionCode', text(regionCode, 'VIDEO_DISCOVERY_REGION_INVALID'));
        if (requireCaptions) searchUrl.searchParams.set('videoCaption', 'closedCaption');
        if (pageToken) searchUrl.searchParams.set('pageToken', pageToken);

        let searchResponse;
        try { searchResponse = await fetchImpl(searchUrl, { method:'GET', headers:{ accept:'application/json' } }); } catch { return freeze({ status:'PROVIDER_UNAVAILABLE',provider:'YOUTUBE_DATA_API_V3',query:q,records:[],pagesUsed,quotaState:'UNKNOWN',safety:safety() }); }
        const searchPayload = await responseJson(searchResponse);
        if (!searchResponse?.ok) {
          const status = youtubeErrorStatus(searchResponse, searchPayload);
          return freeze({ status,provider:'YOUTUBE_DATA_API_V3',query:q,records:[],pagesUsed,quotaState:status,safety:safety() });
        }
        pagesUsed += 1;
        const items = Array.isArray(searchPayload?.items) ? searchPayload.items : [];
        const ids = unique(items.map((item) => item?.id?.videoId).filter(Boolean));
        if (ids.length === 0) break;

        const videosUrl = new URL(YOUTUBE_VIDEOS_ENDPOINT);
        videosUrl.searchParams.set('part', 'snippet,contentDetails');
        videosUrl.searchParams.set('id', ids.join(','));
        videosUrl.searchParams.set('key', apiKey.trim());
        let videosResponse;
        try { videosResponse = await fetchImpl(videosUrl, { method:'GET', headers:{ accept:'application/json' } }); } catch { return freeze({ status:'PROVIDER_UNAVAILABLE',provider:'YOUTUBE_DATA_API_V3',query:q,records:[],pagesUsed,quotaState:'UNKNOWN',safety:safety() }); }
        const videosPayload = await responseJson(videosResponse);
        if (!videosResponse?.ok) {
          const status = youtubeErrorStatus(videosResponse, videosPayload);
          return freeze({ status,provider:'YOUTUBE_DATA_API_V3',query:q,records:[],pagesUsed,quotaState:status,safety:safety() });
        }
        const byId = new Map((Array.isArray(videosPayload?.items) ? videosPayload.items : []).map((item) => [item?.id, item]));
        for (const searchItem of items) {
          const videoId = searchItem?.id?.videoId;
          const detail = byId.get(videoId);
          if (!videoId || !detail?.snippet) continue;
          const snippet = detail.snippet;
          const captionsKnownPresent = detail?.contentDetails?.caption === 'true';
          const source = createResearchVideoSourceV1({
            provider:'YOUTUBE',sourceType:'YOUTUBE_VIDEO',canonicalUrl:`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,videoId,
            title:snippet.title ?? searchItem?.snippet?.title ?? 'Untitled video',channelOrPublisher:snippet.channelTitle ?? searchItem?.snippet?.channelTitle ?? snippet.channelId ?? 'Unknown publisher',
            publishedAt:snippet.publishedAt ?? searchItem?.snippet?.publishedAt ?? null,discoveredAt:timestamp,
            language:snippet.defaultAudioLanguage ?? snippet.defaultLanguage ?? null,durationSec:parseYoutubeDuration(detail?.contentDetails?.duration),
            transcriptStatus:captionsKnownPresent ? 'NOT_AUTHORIZED' : 'UNAVAILABLE',transcriptSource:null,transcriptAuthorized:false,contentAccessStatus:'AVAILABLE',timestampProvenance:[],
          });
          records.push(freeze({
            source,
            metadata: {
              channelId: snippet.channelId ?? null,
              description: typeof snippet.description === 'string' ? snippet.description : '',
              thumbnailUrl: snippet.thumbnails?.default?.url ?? snippet.thumbnails?.medium?.url ?? null,
              captionsKnownPresent,
              searchQuery:q,
              discoveryReason:text(discoveryReason, 'VIDEO_DISCOVERY_REASON_REQUIRED'),
            },
            sourceTrustTier:'UNKNOWN',
            economicEvidenceCredit:0,
            profitabilityCredit:0,
            executionAuthority:'NONE',
          }));
          if (records.length >= maxVideosPerResearchBatch) break;
        }
        pageToken = typeof searchPayload?.nextPageToken === 'string' ? searchPayload.nextPageToken : null;
        if (!pageToken) break;
      }
      return freeze({ status:'SUCCESS',provider:'YOUTUBE_DATA_API_V3',query:q,records,pagesUsed,quotaState:'AVAILABLE',safety:safety() });
    },
  });
}

export function normalizeAuthorizedTranscriptV2({ source, status = 'NOT_PROVIDED', transcriptSource = null, authorized = false, language = null, segments = [] } = {}) {
  assertResearchVideoSourceV1(source);
  const normalizedStatus = text(status, 'TRANSCRIPT_STATUS_REQUIRED').toUpperCase();
  if (!TRANSCRIPT_STATUSES.has(normalizedStatus)) fail('TRANSCRIPT_STATUS_UNSUPPORTED');
  if (typeof authorized !== 'boolean') fail('TRANSCRIPT_AUTHORIZATION_REQUIRED');
  if (normalizedStatus === 'AVAILABLE' && (!authorized || !transcriptSource)) fail('TRANSCRIPT_AVAILABLE_REQUIRES_AUTHORIZED_SOURCE');
  if (normalizedStatus !== 'AVAILABLE' && asArray(segments, 'TRANSCRIPT_SEGMENTS_INVALID').length > 0) fail('TRANSCRIPT_CONTENT_FORBIDDEN_FOR_UNAVAILABLE_STATUS');
  if (normalizedStatus === 'AVAILABLE' && !Array.isArray(segments)) fail('TRANSCRIPT_SEGMENTS_INVALID');

  const normalizedSegments = normalizedStatus === 'AVAILABLE' ? segments.map((segment, index) => {
    if (!segment || typeof segment.text !== 'string' || !segment.text.trim()) fail('TRANSCRIPT_SEGMENT_TEXT_REQUIRED', { index });
    const startSec = finite(segment.startSec, 'TRANSCRIPT_SEGMENT_START_INVALID');
    const endSec = finite(segment.endSec, 'TRANSCRIPT_SEGMENT_END_INVALID');
    if (endSec < startSec) fail('TRANSCRIPT_SEGMENT_TIME_INVALID', { index });
    const contentHash = sha(segment.text);
    return freeze({
      segmentId:`transcript-segment:sha256:${sha({ sourceId:source.sourceId,startSec,endSec,contentHash })}`,
      videoId:source.videoId,startSec,endSec,text:segment.text,language:optionalText(segment.language ?? language, 'TRANSCRIPT_SEGMENT_LANGUAGE_INVALID'),
      source:text(segment.source ?? transcriptSource, 'TRANSCRIPT_SEGMENT_SOURCE_REQUIRED'),authorized:true,
      provenance:freeze({ sourceId:source.sourceId,canonicalUrl:source.canonicalUrl,provider:source.provider,transcriptSource:text(transcriptSource, 'TRANSCRIPT_SOURCE_REQUIRED') }),
      contentHash,contentAuthority:'UNTRUSTED_EXTERNAL_DATA',
    });
  }) : [];

  return freeze({
    schemaVersion:'video-transcript-v2',transcriptId:`video-transcript:sha256:${sha({ sourceId:source.sourceId,status:normalizedStatus,segments:normalizedSegments.map((segment) => segment.contentHash) })}`,
    sourceId:source.sourceId,videoId:source.videoId,status:normalizedStatus,transcriptSource:optionalText(transcriptSource, 'TRANSCRIPT_SOURCE_INVALID'),authorized,
    language:optionalText(language, 'TRANSCRIPT_LANGUAGE_INVALID'),segments:normalizedSegments,
    contentAuthority:'UNTRUSTED_EXTERNAL_DATA',safety:safety(),
  });
}

export function bindAuthorizedTranscriptToSourceV2({ source, transcript } = {}) {
  assertResearchVideoSourceV1(source);
  if (!transcript || transcript.sourceId !== source.sourceId || transcript.status !== 'AVAILABLE' || transcript.authorized !== true) fail('AUTHORIZED_TRANSCRIPT_BINDING_REQUIRED');
  return createResearchVideoSourceV1({
    provider:source.provider,sourceType:source.sourceType,canonicalUrl:source.canonicalUrl,videoId:source.videoId,title:source.title,channelOrPublisher:source.channelOrPublisher,
    publishedAt:source.publishedAt,discoveredAt:source.discoveredAt,language:source.language,durationSec:source.durationSec,
    transcriptStatus:'AVAILABLE',transcriptSource:transcript.transcriptSource,transcriptAuthorized:true,contentAccessStatus:source.contentAccessStatus,timestampProvenance:source.timestampProvenance,
  });
}

export function createChapterIntelligenceV2({ transcript, chapters = [], inferredSections = [] } = {}) {
  if (!transcript || typeof transcript.transcriptId !== 'string') fail('TRANSCRIPT_REQUIRED');
  const normalize = (row, origin, inference, index) => {
    const startSec = finite(row?.startSec, 'VIDEO_CHAPTER_START_INVALID');
    const endSec = finite(row?.endSec, 'VIDEO_CHAPTER_END_INVALID');
    if (endSec < startSec) fail('VIDEO_CHAPTER_TIME_INVALID', { index });
    return freeze({ chapterId:`video-section:sha256:${sha({ transcriptId:transcript.transcriptId,startSec,endSec,origin,title:row?.title })}`,startSec,endSec,title:text(row?.title, 'VIDEO_CHAPTER_TITLE_REQUIRED'),origin,inference,provenance:row?.provenance ?? null });
  };
  return freeze({ transcriptId:transcript.transcriptId,sections:[
    ...asArray(chapters, 'VIDEO_CHAPTERS_INVALID').map((row, index) => normalize(row, row?.origin === 'CREATOR_CHAPTER' ? 'CREATOR_CHAPTER' : 'PROVIDER_CHAPTER', false, index)),
    ...asArray(inferredSections, 'VIDEO_INFERRED_SECTIONS_INVALID').map((row, index) => normalize(row, 'AI_INFERRED_SECTION', true, index)),
  ].sort((a,b) => a.startSec - b.startSec),safety:safety() });
}

export async function extractTranscriptClaimsV2({ transcript, extractor = null } = {}) {
  if (!transcript || typeof transcript.transcriptId !== 'string') fail('TRANSCRIPT_REQUIRED');
  if (transcript.status !== 'AVAILABLE' || transcript.authorized !== true) return freeze({ status:'TRANSCRIPT_UNAVAILABLE',transcriptId:transcript.transcriptId,claims:[],safety:safety() });
  if (typeof extractor !== 'function') return freeze({ status:'PROVIDER_NOT_CONFIGURED',transcriptId:transcript.transcriptId,claims:[],safety:safety() });
  const firewall = inspectVideoContentFirewallV1(transcript.segments.map((segment) => segment.text));
  const output = await extractor(freeze({ transcriptId:transcript.transcriptId,segments:transcript.segments,contentAuthority:'UNTRUSTED_EXTERNAL_DATA' }));
  if (!Array.isArray(output)) fail('CLAIM_EXTRACTION_RESULT_INVALID');
  const bySegment = new Map(transcript.segments.map((segment) => [segment.segmentId, segment]));
  const claims = output.map((row, index) => {
    const segment = bySegment.get(row?.segmentId);
    if (!segment) fail('CLAIM_SOURCE_SEGMENT_INVALID', { index });
    const claimType = text(row?.claimType, 'CLAIM_TYPE_REQUIRED').toUpperCase();
    if (!CLAIM_TYPES.has(claimType)) fail('CLAIM_TYPE_INVALID', { index });
    const uncertainty = text(row?.uncertainty ?? 'UNKNOWN', 'CLAIM_UNCERTAINTY_REQUIRED').toUpperCase();
    if (!UNCERTAINTY.has(uncertainty)) fail('CLAIM_UNCERTAINTY_INVALID', { index });
    const normalizedText = text(row?.text ?? segment.text, 'CLAIM_TEXT_REQUIRED');
    return freeze({
      claimId:`video-claim:sha256:${sha({ transcriptId:transcript.transcriptId,segmentId:segment.segmentId,claimType,normalizedText })}`,
      claimType,text:normalizedText,sourceText:segment.text,startSec:segment.startSec,endSec:segment.endSec,sourceVideoId:transcript.videoId,
      provenance:freeze({ transcriptId:transcript.transcriptId,segmentId:segment.segmentId,sourceTextHash:segment.contentHash }),uncertainty,contentAuthority:'UNTRUSTED_EXTERNAL_DATA',
    });
  });
  return freeze({ status:'COMPLETE',transcriptId:transcript.transcriptId,claims,promptInjectionDetected:firewall.promptInjectionDetected,safety:safety() });
}

function requireFieldProvenance(value, field, fieldProvenance, claimsById) {
  const populated = Array.isArray(value) ? value.length > 0 : value != null && value !== '';
  if (!populated) return;
  const claimId = fieldProvenance?.[field];
  if (typeof claimId !== 'string' || !claimsById.has(claimId)) fail('INVENTED_STRATEGY_FIELD', { field });
}

export async function extractStrategyRulesV2({ source, transcript, claimResult, extractor = null } = {}) {
  assertResearchVideoSourceV1(source);
  if (!transcript || transcript.sourceId !== source.sourceId || transcript.status !== 'AVAILABLE' || transcript.authorized !== true) return freeze({ status:'TRANSCRIPT_UNAVAILABLE',sourceId:source.sourceId,rules:[],hypothesis:null,safety:safety() });
  if (!claimResult || claimResult.status !== 'COMPLETE') return freeze({ status:'CLAIMS_UNAVAILABLE',sourceId:source.sourceId,rules:[],hypothesis:null,safety:safety() });
  if (typeof extractor !== 'function') return freeze({ status:'PROVIDER_NOT_CONFIGURED',sourceId:source.sourceId,rules:[],hypothesis:null,safety:safety() });
  const claimsById = new Map(claimResult.claims.map((claim) => [claim.claimId, claim]));
  const output = await extractor(freeze({ claims:claimResult.claims,contentAuthority:'UNTRUSTED_EXTERNAL_DATA' }));
  if (!output || typeof output !== 'object' || Array.isArray(output)) fail('STRATEGY_EXTRACTION_RESULT_INVALID');
  const fieldProvenance = output.fieldProvenance ?? {};
  for (const field of ['market','assetClass','symbolScope','side','timeframe','strategyFamily','categories','holdingPeriod','executionAssumptions']) requireFieldProvenance(output[field], field, fieldProvenance, claimsById);
  const rules = asArray(output.rules ?? [], 'STRATEGY_RULES_INVALID').map((row, index) => {
    const claim = claimsById.get(row?.claimId);
    if (!claim) fail('INVENTED_STRATEGY_RULE', { index });
    const ruleType = text(row?.ruleType, 'STRATEGY_RULE_TYPE_REQUIRED').toUpperCase();
    if (!RULE_TYPES.has(ruleType)) fail('STRATEGY_RULE_TYPE_INVALID', { index });
    const polarity = text(row?.polarity ?? 'REQUIRE', 'STRATEGY_RULE_POLARITY_REQUIRED').toUpperCase();
    if (!POLARITIES.has(polarity)) fail('STRATEGY_RULE_POLARITY_INVALID', { index });
    const normalizedRule = text(row?.normalizedRule, 'STRATEGY_RULE_TEXT_REQUIRED');
    const semanticKey = optionalText(row?.semanticKey, 'STRATEGY_RULE_SEMANTIC_KEY_INVALID') ?? canonicalText(normalizedRule);
    return freeze({ ruleId:`video-rule:sha256:${sha({ claimId:claim.claimId,ruleType,normalizedRule,polarity })}`,ruleType,normalizedRule,semanticKey,polarity,sourceVideoId:source.videoId,sourceStartSec:claim.startSec,sourceEndSec:claim.endSec,sourceTextHash:claim.provenance.sourceTextHash,extractionMethod:'AUTHORIZED_TRANSCRIPT_EXTRACTOR',uncertainty:claim.uncertainty,claimId:claim.claimId });
  });
  const grouped = (type) => rules.filter((rule) => rule.ruleType === type).map((rule) => rule.normalizedRule);
  const start = rules.length ? Math.min(...rules.map((rule) => rule.sourceStartSec)) : null;
  const end = rules.length ? Math.max(...rules.map((rule) => rule.sourceEndSec)) : null;
  const hypothesis = createVideoStrategyHypothesisV1({
    source,sourceStartSec:start,sourceEndSec:end,sourceQuoteHash:rules.length ? sha(rules.map((rule) => rule.sourceTextHash)) : null,
    market:output.market ?? null,assetClass:output.assetClass ?? null,symbolScope:output.symbolScope ?? [],side:output.side ?? 'UNKNOWN',timeframe:output.timeframe ?? null,
    strategyFamily:output.strategyFamily ?? null,categories:output.categories ?? [],entryRules:grouped('ENTRY'),exitRules:grouped('EXIT'),stopLossRules:grouped('STOP_LOSS'),takeProfitRules:grouped('TAKE_PROFIT'),
    positionSizingRules:grouped('POSITION_SIZING'),indicatorRules:grouped('INDICATOR'),regimeConstraints:grouped('REGIME'),invalidations:grouped('INVALIDATION'),
    authorClaims:claimResult.claims.filter((claim) => ['CREATOR_CLAIM','PROMOTIONAL_CLAIM'].includes(claim.claimType)).map((claim) => claim.text),
    extractedFacts:claimResult.claims.filter((claim) => claim.claimType === 'FACT').map((claim) => claim.text),
    extractedInferences:claimResult.claims.filter((claim) => claim.claimType === 'HYPOTHESIS').map((claim) => claim.text),
    uncertainties:claimResult.claims.filter((claim) => ['UNCERTAIN','OPINION'].includes(claim.claimType)).map((claim) => claim.text),
  });
  const testability = assessVideoStrategyTestabilityV2({ hypothesis, rules });
  return freeze({ status:'COMPLETE',sourceId:source.sourceId,rules,holdingPeriod:output.holdingPeriod ?? null,executionAssumptions:output.executionAssumptions ?? [],fieldProvenance:freeze({ ...fieldProvenance }),hypothesis,testability,safety:safety() });
}

export function assessVideoStrategyTestabilityV2({ hypothesis, rules = [] } = {}) {
  if (!hypothesis || typeof hypothesis.hypothesisId !== 'string') fail('VIDEO_HYPOTHESIS_REQUIRED');
  const conflicts = detectStrategyContradictionsV2([{ hypothesis, rules }]);
  let status = 'TESTABLE';
  if (!hypothesis.market) status = 'MISSING_MARKET';
  else if (!hypothesis.timeframe) status = 'MISSING_TIMEFRAME';
  else if (!hypothesis.entryRules?.length) status = 'MISSING_ENTRY';
  else if (!hypothesis.exitRules?.length) status = 'MISSING_EXIT';
  else if (conflicts.contradictions.length) status = 'CONTRADICTORY_RULES';
  else if (hypothesis.testabilityStatus !== 'TESTABLE') status = hypothesis.testabilityStatus === 'NON_TESTABLE_STRATEGY' ? 'NON_TESTABLE_STRATEGY' : 'PARTIALLY_TESTABLE';
  return freeze({ status,compilerEligible:status === 'TESTABLE',missingRequiredFields:[...(hypothesis.missingRequiredFields ?? [])],contradictionCount:conflicts.contradictions.length,inventedRuleCount:0,safety:safety() });
}

function transcriptText(transcript) { return transcript?.status === 'AVAILABLE' ? transcript.segments.map((segment) => segment.text).join('\n') : ''; }
function tokenSet(value) { return new Set(canonicalText(value).split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2)); }
function jaccard(left, right) { const a = tokenSet(left); const b = tokenSet(right); if (!a.size || !b.size) return null; let overlap = 0; for (const token of a) if (b.has(token)) overlap += 1; return overlap / (a.size + b.size - overlap); }

export function detectVideoSourceRelationshipV2({ leftSource, rightSource, leftTranscript = null, rightTranscript = null } = {}) {
  assertResearchVideoSourceV1(leftSource); assertResearchVideoSourceV1(rightSource);
  if (leftSource.sourceId === rightSource.sourceId || leftSource.videoId === rightSource.videoId || leftSource.canonicalUrl === rightSource.canonicalUrl) return freeze({ status:'SAME_SOURCE',similarity:1,reasons:['IDENTICAL_SOURCE_IDENTITY'],economicEvidenceN:0 });
  const leftHash = leftTranscript?.transcriptId ?? null; const rightHash = rightTranscript?.transcriptId ?? null;
  if (leftHash && rightHash && leftHash === rightHash) return freeze({ status:'LIKELY_DERIVED',similarity:1,reasons:['IDENTICAL_TRANSCRIPT_HASH'],economicEvidenceN:0 });
  const similarity = jaccard(transcriptText(leftTranscript), transcriptText(rightTranscript));
  const sameTitle = canonicalText(leftSource.title) === canonicalText(rightSource.title);
  const samePublisher = canonicalText(leftSource.channelOrPublisher) === canonicalText(rightSource.channelOrPublisher);
  if (similarity != null && similarity >= 0.8) return freeze({ status:'LIKELY_DERIVED',similarity,reasons:['HIGH_TRANSCRIPT_SIMILARITY'],economicEvidenceN:0 });
  if (sameTitle && samePublisher) return freeze({ status:'LIKELY_DERIVED',similarity,reasons:['SAME_TITLE_AND_PUBLISHER'],economicEvidenceN:0 });
  if (similarity != null && similarity < 0.65 && !samePublisher) return freeze({ status:'INDEPENDENT_SOURCE',similarity,reasons:['DISTINCT_PUBLISHER_AND_TRANSCRIPT'],economicEvidenceN:0 });
  return freeze({ status:'UNKNOWN',similarity,reasons:['INSUFFICIENT_INDEPENDENCE_EVIDENCE'],economicEvidenceN:0 });
}

export function detectStrategyContradictionsV2(records = []) {
  const byKey = new Map();
  for (const record of asArray(records, 'VIDEO_STRATEGY_RECORDS_REQUIRED')) {
    for (const rule of record?.rules ?? []) {
      const key = `${rule.ruleType}|${canonicalText(rule.semanticKey)}`;
      const current = byKey.get(key) ?? [];
      current.push(rule);
      byKey.set(key, current);
    }
  }
  const contradictions = [];
  for (const [key, rules] of byKey) {
    const polarities = new Set(rules.map((rule) => rule.polarity).filter((value) => value !== 'UNKNOWN'));
    if (polarities.has('REQUIRE') && polarities.has('AVOID')) contradictions.push(freeze({ key,ruleIds:rules.map((rule) => rule.ruleId).sort(),status:'CONTRADICTED' }));
  }
  return freeze({ contradictions,economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE' });
}

export function clusterVideoStrategiesV2(records = []) {
  const groups = new Map();
  for (const record of asArray(records, 'VIDEO_STRATEGY_RECORDS_REQUIRED')) {
    assertResearchVideoSourceV1(record.source);
    if (!record.hypothesis) fail('VIDEO_HYPOTHESIS_REQUIRED');
    const key = sha({ assetClass:record.hypothesis.assetClass,market:record.hypothesis.market,side:record.hypothesis.side,timeframe:record.hypothesis.timeframe,strategyFamily:record.hypothesis.strategyFamily });
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }
  const clusters = [...groups.entries()].map(([key, rows]) => {
    const derived = new Set();
    const independent = [];
    for (let i = 0; i < rows.length; i += 1) {
      if (derived.has(i)) continue;
      independent.push(i);
      for (let j = i + 1; j < rows.length; j += 1) {
        const relation = detectVideoSourceRelationshipV2({ leftSource:rows[i].source,rightSource:rows[j].source,leftTranscript:rows[i].transcript,rightTranscript:rows[j].transcript });
        if (relation.status === 'SAME_SOURCE' || relation.status === 'LIKELY_DERIVED') derived.add(j);
      }
    }
    const contradiction = detectStrategyContradictionsV2(rows);
    const ruleCounts = new Map();
    for (const row of rows) for (const rule of row.rules ?? []) { const k = `${rule.ruleType}|${canonicalText(rule.semanticKey)}|${rule.polarity}`; ruleCounts.set(k, (ruleCounts.get(k) ?? 0) + 1); }
    const commonRules = [...ruleCounts.entries()].filter(([, count]) => count === rows.length).map(([key2]) => key2).sort();
    let consensus = 'UNKNOWN';
    if (contradiction.contradictions.length) consensus = 'CONFLICTING';
    else if (commonRules.length && rows.length > 1) consensus = 'CONSISTENT';
    else if (rows.length > 1) consensus = 'PARTIAL_AGREEMENT';
    return freeze({ clusterId:`video-strategy-cluster-v2:sha256:${key}`,videoCount:rows.length,independentSourceCount:independent.length,videoHypothesisIds:rows.map((row) => row.hypothesis.hypothesisId).sort(),commonRules,conflictingRules:contradiction.contradictions,consensusStatus:consensus,economicEvidenceN:0 });
  });
  return freeze({ clusters,economicEvidenceN:0,safety:safety() });
}

export function crossValidateVideoClaimsV2({ claims = [], paperEvidence = [], officialEvidence = [] } = {}) {
  const claimIds = new Set(asArray(claims, 'VIDEO_CLAIMS_REQUIRED').map((claim) => claim.claimId));
  const paperRows = asArray(paperEvidence, 'VIDEO_PAPER_EVIDENCE_INVALID').map((entry, index) => {
    if (!claimIds.has(entry?.claimId)) fail('VIDEO_EVIDENCE_CLAIM_INVALID', { index });
    assertResearchPaperV2(entry.paper);
    const role = text(entry.role, 'VIDEO_EVIDENCE_ROLE_REQUIRED').toUpperCase();
    if (!['SUPPORTING','CONTRADICTORY'].includes(role)) fail('VIDEO_EVIDENCE_ROLE_INVALID', { index });
    return freeze({ claimId:entry.claimId,sourceId:entry.paper.paperId,authority:'ACADEMIC',role });
  });
  const officialRows = asArray(officialEvidence, 'VIDEO_OFFICIAL_EVIDENCE_INVALID').map((entry, index) => {
    if (!claimIds.has(entry?.claimId)) fail('VIDEO_EVIDENCE_CLAIM_INVALID', { index });
    const role = text(entry.role, 'VIDEO_EVIDENCE_ROLE_REQUIRED').toUpperCase();
    if (!['SUPPORTING','CONTRADICTORY'].includes(role)) fail('VIDEO_EVIDENCE_ROLE_INVALID', { index });
    const canonicalUrl = text(entry.canonicalUrl, 'VIDEO_OFFICIAL_URL_REQUIRED');
    let url; try { url = new URL(canonicalUrl); } catch { fail('VIDEO_OFFICIAL_URL_INVALID', { index }); }
    if (!['http:','https:'].includes(url.protocol)) fail('VIDEO_OFFICIAL_URL_INVALID', { index });
    return freeze({ claimId:entry.claimId,sourceId:text(entry.sourceId, 'VIDEO_OFFICIAL_SOURCE_ID_REQUIRED'),canonicalUrl,authority:'OFFICIAL',role });
  });
  const results = claims.map((claim) => {
    const evidence = [...paperRows,...officialRows].filter((entry) => entry.claimId === claim.claimId);
    const supporting = evidence.filter((entry) => entry.role === 'SUPPORTING');
    const contradictory = evidence.filter((entry) => entry.role === 'CONTRADICTORY');
    let status = 'NOT_CHECKED';
    if (contradictory.length) status = 'CONTRADICTED';
    else if (supporting.some((entry) => entry.authority === 'ACADEMIC') && supporting.some((entry) => entry.authority === 'OFFICIAL')) status = 'SUPPORTED';
    else if (supporting.length) status = 'PARTIAL_SUPPORT';
    else if (evidence.length === 0) status = 'NO_SUPPORT';
    return freeze({ claimId:claim.claimId,status,supportingSources:supporting,contradictingSources:contradictory,economicEvidenceCredit:0,profitabilityCredit:0 });
  });
  return freeze({ results,economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE' });
}

export function classifyVideoSourceAuthorityV2({ authorityEvidence = null } = {}) {
  if (!authorityEvidence) return 'UNKNOWN';
  const type = text(authorityEvidence.type, 'VIDEO_SOURCE_AUTHORITY_TYPE_REQUIRED').toUpperCase();
  const mapping = { OFFICIAL:'TIER_A_OFFICIAL',ACADEMIC:'TIER_B_ACADEMIC',PRIMARY_EXPERT:'TIER_C_PRIMARY_EXPERT',SECONDARY_EDUCATIONAL:'TIER_D_SECONDARY_EDUCATIONAL',UNVERIFIED_CREATOR:'TIER_E_UNVERIFIED_CREATOR' };
  if (!mapping[type]) fail('VIDEO_SOURCE_AUTHORITY_TYPE_INVALID');
  if (!authorityEvidence.provenance) fail('VIDEO_SOURCE_AUTHORITY_PROVENANCE_REQUIRED');
  return mapping[type];
}

export function createVideoResearchPhase2RuntimeStateV2() {
  return freeze({ paidProviderEnabled:false,automaticDiscoveryEnabled:false,scheduleActive:false,providerCredentialMutation:false,executionAuthority:'NONE',economicEvidenceCredit:0,profitabilityCredit:0 });
}
