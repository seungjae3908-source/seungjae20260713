import { deepFreeze, sha256Hex } from './canonical-json.js';
import { assertExactKeys, fail, requirePlainObject, requireString } from './errors.js';
import {
  canonicalArxivUrl,
  canonicalDoiUrl,
  derivePaperId,
  normalizeArxivId,
  normalizeDoi,
  normalizeProviderRecordId,
  normalizeRetrievedAt,
  normalizeTemporal,
} from './identifiers.js';
import { PROVIDER_POLICIES, PROVIDER_POLICY_VERSION, validateProviderRequestUrl } from './policies.js';

export const RESEARCH_PAPER_SCHEMA_VERSION = 2;
export const RESEARCH_PAPER_SOURCES = Object.freeze(['CROSSREF', 'SEMANTIC_SCHOLAR', 'ARXIV']);

const TOP_LEVEL_KEYS = Object.freeze([
  'schemaVersion',
  'paperId',
  'title',
  'authors',
  'publishedAt',
  'source',
  'DOI',
  'arXivId',
  'canonicalUrl',
  'version',
  'correctionState',
  'retractionState',
  'license',
  'retrievedAt',
  'metadataHash',
  'provenance',
]);

export const FIELD_SOURCE_KEYS = Object.freeze([
  'title',
  'authors',
  'publishedAt',
  'DOI',
  'arXivId',
  'canonicalUrl',
  'version',
  'correctionState',
  'retractionState',
  'license',
]);

const CORRECTION_STATUSES = new Set(['UNKNOWN', 'CORRECTED', 'CORRECTION_NOTICE']);
const RETRACTION_STATUSES = new Set(['UNKNOWN', 'RETRACTED', 'RETRACTION_NOTICE', 'EXPRESSION_OF_CONCERN', 'REINSTATED']);
const METADATA_LICENSE_STATUSES = new Set(['PUBLIC_DOMAIN', 'TERMS_GOVERNED']);
const CONTENT_LICENSE_STATUSES = new Set(['KNOWN', 'UNKNOWN']);
const INTEGRITY_RELATIONS = new Set(['UPDATES', 'UPDATED_BY']);

function assertNullableString(value, code) {
  if (value !== null) requireString(value, code);
}

function assertWebUrl(value, code, { httpsOnly = false } = {}) {
  const text = requireString(value, code);
  let url;
  try {
    url = new URL(text);
  } catch {
    fail(code);
  }
  if ((httpsOnly && url.protocol !== 'https:') || (!httpsOnly && !['http:', 'https:'].includes(url.protocol))) fail(code);
  if (url.username || url.password) fail(code);
  return url.toString();
}

function assertVersion(version) {
  assertExactKeys(version, ['workVersion', 'providerRecordVersion', 'providerUpdatedAt'], 'VERSION_INVALID');
  assertNullableString(version.workVersion, 'WORK_VERSION_INVALID');
  assertNullableString(version.providerRecordVersion, 'PROVIDER_RECORD_VERSION_INVALID');
  if (version.providerUpdatedAt !== null) normalizeTemporal(version.providerUpdatedAt, 'PROVIDER_UPDATED_AT_INVALID');
}

function arxivWorkVersion(paper) {
  if (paper.arXivId === null) {
    if (paper.version.workVersion !== null) fail('WORK_VERSION_WITHOUT_ARXIV_ID');
    return null;
  }
  if (paper.version.workVersion === null) return null;
  const match = paper.version.workVersion.match(/^v([1-9]\d*)$/u);
  const version = match == null ? NaN : Number(match[1]);
  if (!Number.isSafeInteger(version)) fail('ARXIV_WORK_VERSION_INVALID');
  return version;
}

function assertArxivCanonicalIdentity(paper, version) {
  if (paper.DOI !== null || paper.arXivId === null) return;
  let parsed;
  try {
    parsed = normalizeArxivId(paper.canonicalUrl);
  } catch {
    fail('ARXIV_CANONICAL_URL_MISMATCH');
  }
  if (parsed?.arXivId !== paper.arXivId || parsed.version !== version) fail('ARXIV_CANONICAL_URL_MISMATCH');
  if (paper.canonicalUrl !== canonicalArxivUrl(paper.arXivId, version)) fail('ARXIV_CANONICAL_URL_MISMATCH');
}

function assertProviderRecordIdentity(paper, providerRecordId, version) {
  if (paper.source === 'CROSSREF') {
    const providerDOI = normalizeDoi(providerRecordId);
    if (paper.DOI === null || providerDOI !== paper.DOI) fail('CROSSREF_PROVIDER_RECORD_ID_MISMATCH');
    return;
  }
  if (paper.source === 'ARXIV') {
    const providerArxiv = normalizeArxivId(providerRecordId);
    if (paper.arXivId === null || providerArxiv?.arXivId !== paper.arXivId || providerArxiv.version !== version) {
      fail('ARXIV_PROVIDER_RECORD_ID_MISMATCH');
    }
  }
  // Semantic Scholar paper IDs are opaque provider identities. They are not
  // aliases for DOI or arXiv IDs; the provider-scoped fallback paperId binds
  // them when no external strong identity is available.
}

function assertIntegrityEvidence(evidence) {
  if (!Array.isArray(evidence)) fail('INTEGRITY_EVIDENCE_INVALID');
  for (const entry of evidence) {
    assertExactKeys(entry, ['relation', 'type', 'identifier', 'label', 'source', 'updatedAt'], 'INTEGRITY_EVIDENCE_INVALID');
    if (!INTEGRITY_RELATIONS.has(entry.relation)) fail('INTEGRITY_RELATION_INVALID');
    requireString(entry.type, 'INTEGRITY_TYPE_REQUIRED');
    assertNullableString(entry.identifier, 'INTEGRITY_IDENTIFIER_INVALID');
    assertNullableString(entry.label, 'INTEGRITY_LABEL_INVALID');
    assertNullableString(entry.source, 'INTEGRITY_SOURCE_INVALID');
    if (entry.updatedAt !== null) normalizeTemporal(entry.updatedAt, 'INTEGRITY_UPDATED_AT_INVALID');
  }
}

function assertCorrectionState(state) {
  assertExactKeys(state, ['status', 'evidence'], 'CORRECTION_STATE_INVALID');
  if (!CORRECTION_STATUSES.has(state.status)) fail('CORRECTION_STATUS_INVALID');
  assertIntegrityEvidence(state.evidence);
  if ((state.status === 'UNKNOWN') !== (state.evidence.length === 0)) fail('CORRECTION_STATUS_EVIDENCE_MISMATCH');
}

function assertRetractionState(state) {
  assertExactKeys(state, ['status', 'evidence'], 'RETRACTION_STATE_INVALID');
  if (!RETRACTION_STATUSES.has(state.status)) fail('RETRACTION_STATUS_INVALID');
  assertIntegrityEvidence(state.evidence);
  if ((state.status === 'UNKNOWN') !== (state.evidence.length === 0)) fail('RETRACTION_STATUS_EVIDENCE_MISMATCH');
}

function assertLicense(license) {
  assertExactKeys(license, ['metadata', 'content'], 'LICENSE_INVALID');
  assertExactKeys(license.metadata, ['status', 'identifier', 'url', 'attributionRequired'], 'METADATA_LICENSE_INVALID');
  if (!METADATA_LICENSE_STATUSES.has(license.metadata.status)) fail('METADATA_LICENSE_STATUS_INVALID');
  assertNullableString(license.metadata.identifier, 'METADATA_LICENSE_IDENTIFIER_INVALID');
  assertWebUrl(license.metadata.url, 'METADATA_LICENSE_URL_INVALID', { httpsOnly: true });
  if (typeof license.metadata.attributionRequired !== 'boolean') fail('METADATA_LICENSE_ATTRIBUTION_INVALID');

  assertExactKeys(license.content, ['status', 'entries'], 'CONTENT_LICENSE_INVALID');
  if (!CONTENT_LICENSE_STATUSES.has(license.content.status) || !Array.isArray(license.content.entries)) fail('CONTENT_LICENSE_STATUS_INVALID');
  if ((license.content.status === 'UNKNOWN') !== (license.content.entries.length === 0)) fail('CONTENT_LICENSE_STATUS_ENTRIES_MISMATCH');
  for (const entry of license.content.entries) {
    assertExactKeys(entry, ['identifier', 'url', 'appliesTo', 'startsAt', 'delayInDays', 'verificationRequired'], 'CONTENT_LICENSE_ENTRY_INVALID');
    assertNullableString(entry.identifier, 'CONTENT_LICENSE_IDENTIFIER_INVALID');
    if (entry.url !== null) assertWebUrl(entry.url, 'CONTENT_LICENSE_URL_INVALID');
    requireString(entry.appliesTo, 'CONTENT_LICENSE_SCOPE_REQUIRED');
    if (entry.startsAt !== null) normalizeTemporal(entry.startsAt, 'CONTENT_LICENSE_START_INVALID');
    if (entry.delayInDays !== null && (!Number.isSafeInteger(entry.delayInDays) || entry.delayInDays < 0)) fail('CONTENT_LICENSE_DELAY_INVALID');
    if (typeof entry.verificationRequired !== 'boolean') fail('CONTENT_LICENSE_VERIFICATION_INVALID');
  }
}

function assertProvenance(provenance, paper) {
  assertExactKeys(
    provenance,
    ['provider', 'providerRecordId', 'retrievedFrom', 'retrievedAt', 'sourceHash', 'adapter', 'accessMode', 'policyVersion', 'fieldSources'],
    'PROVENANCE_INVALID',
  );
  if (provenance.provider !== paper.source) fail('PROVENANCE_PROVIDER_MISMATCH');
  normalizeProviderRecordId(provenance.providerRecordId);
  validateProviderRequestUrl(paper.source, provenance.retrievedFrom);
  if (normalizeRetrievedAt(provenance.retrievedAt) !== paper.retrievedAt) fail('PROVENANCE_RETRIEVED_AT_MISMATCH');
  if (!/^[0-9a-f]{64}$/u.test(provenance.sourceHash)) fail('SOURCE_HASH_INVALID');
  assertExactKeys(provenance.adapter, ['name', 'version'], 'ADAPTER_PROVENANCE_INVALID');
  requireString(provenance.adapter.name, 'ADAPTER_NAME_REQUIRED');
  requireString(provenance.adapter.version, 'ADAPTER_VERSION_REQUIRED');
  if (provenance.accessMode !== 'PUBLIC_ANONYMOUS' || provenance.accessMode !== PROVIDER_POLICIES[paper.source].accessMode) fail('PRIVATE_API_FORBIDDEN');
  if (provenance.policyVersion !== PROVIDER_POLICY_VERSION) fail('PROVIDER_POLICY_VERSION_MISMATCH');
  assertExactKeys(provenance.fieldSources, FIELD_SOURCE_KEYS, 'FIELD_SOURCES_INVALID');
  for (const key of FIELD_SOURCE_KEYS) requireString(provenance.fieldSources[key], `FIELD_SOURCE_REQUIRED:${key}`);
}

export function metadataHashMaterial(paper) {
  return {
    schemaVersion: paper.schemaVersion,
    paperId: paper.paperId,
    title: paper.title,
    authors: paper.authors,
    publishedAt: paper.publishedAt,
    source: paper.source,
    DOI: paper.DOI,
    arXivId: paper.arXivId,
    canonicalUrl: paper.canonicalUrl,
    version: paper.version,
    correctionState: paper.correctionState,
    retractionState: paper.retractionState,
    license: paper.license,
    provenance: {
      provider: paper.provenance.provider,
      providerRecordId: paper.provenance.providerRecordId,
      sourceHash: paper.provenance.sourceHash,
      adapter: paper.provenance.adapter,
      accessMode: paper.provenance.accessMode,
      policyVersion: paper.provenance.policyVersion,
      fieldSources: paper.provenance.fieldSources,
    },
  };
}

export function computeResearchPaperMetadataHash(paper) {
  return sha256Hex(metadataHashMaterial(paper));
}

export function assertResearchPaperV2(paper) {
  assertExactKeys(paper, TOP_LEVEL_KEYS, 'RESEARCH_PAPER_V2_SHAPE_INVALID');
  if (paper.schemaVersion !== RESEARCH_PAPER_SCHEMA_VERSION) fail('RESEARCH_PAPER_SCHEMA_VERSION_INVALID');
  if (!RESEARCH_PAPER_SOURCES.includes(paper.source)) fail('SOURCE_UNSUPPORTED');

  const title = requireString(paper.title, 'TITLE_REQUIRED');
  if (title !== paper.title || title.length > 4096) fail('TITLE_NOT_CANONICAL');
  if (!Array.isArray(paper.authors) || paper.authors.length === 0) fail('AUTHORS_REQUIRED');
  for (const author of paper.authors) if (requireString(author, 'AUTHOR_INVALID') !== author) fail('AUTHOR_NOT_CANONICAL');
  normalizeTemporal(paper.publishedAt, 'PUBLISHED_AT_INVALID');
  const canonicalUrl = assertWebUrl(paper.canonicalUrl, 'CANONICAL_URL_INVALID', { httpsOnly: true });
  if (canonicalUrl !== paper.canonicalUrl) fail('CANONICAL_URL_NOT_CANONICAL');
  assertVersion(paper.version);
  assertCorrectionState(paper.correctionState);
  assertRetractionState(paper.retractionState);
  assertLicense(paper.license);
  const retrievedAt = normalizeRetrievedAt(paper.retrievedAt);
  if (retrievedAt !== paper.retrievedAt) fail('RETRIEVED_AT_NOT_CANONICAL');
  requirePlainObject(paper.provenance, 'PROVENANCE_INVALID');
  const providerRecordId = normalizeProviderRecordId(paper.provenance.providerRecordId);

  const DOI = normalizeDoi(paper.DOI);
  if (DOI !== paper.DOI) fail('DOI_NOT_CANONICAL');
  const arxiv = normalizeArxivId(paper.arXivId);
  if ((arxiv?.arXivId ?? null) !== paper.arXivId) fail('ARXIV_ID_NOT_CANONICAL');
  const expectedPaperId = derivePaperId({ DOI, arXivId: paper.arXivId, source: paper.source, providerRecordId });
  if (paper.paperId !== expectedPaperId) fail('PAPER_ID_MISMATCH');
  if (DOI && paper.canonicalUrl !== canonicalDoiUrl(DOI)) fail('DOI_CANONICAL_URL_MISMATCH');
  const workVersion = arxivWorkVersion(paper);
  assertArxivCanonicalIdentity(paper, workVersion);
  assertProviderRecordIdentity(paper, providerRecordId, workVersion);
  assertProvenance(paper.provenance, paper);

  if (!/^[0-9a-f]{64}$/u.test(paper.metadataHash)) fail('METADATA_HASH_INVALID');
  if (paper.metadataHash !== computeResearchPaperMetadataHash(paper)) fail('METADATA_HASH_MISMATCH');
  return paper;
}

export function verifyResearchPaperV2(paper) {
  try {
    assertResearchPaperV2(paper);
    return true;
  } catch {
    return false;
  }
}

export function createResearchPaperV2(core) {
  requirePlainObject(core, 'RESEARCH_PAPER_CORE_INVALID');
  const withoutHash = {
    schemaVersion: RESEARCH_PAPER_SCHEMA_VERSION,
    paperId: core.paperId,
    title: core.title,
    authors: core.authors,
    publishedAt: core.publishedAt,
    source: core.source,
    DOI: core.DOI,
    arXivId: core.arXivId,
    canonicalUrl: core.canonicalUrl,
    version: core.version,
    correctionState: core.correctionState,
    retractionState: core.retractionState,
    license: core.license,
    retrievedAt: core.retrievedAt,
    provenance: core.provenance,
  };
  const paper = { ...withoutHash, metadataHash: computeResearchPaperMetadataHash(withoutHash) };
  // Keep the public shape ordered and explicit for stable inspection.
  const ordered = Object.fromEntries(TOP_LEVEL_KEYS.map((key) => [key, paper[key]]));
  assertResearchPaperV2(ordered);
  return deepFreeze(ordered);
}
