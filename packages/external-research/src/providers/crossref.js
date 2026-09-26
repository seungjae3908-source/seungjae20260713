import { createResearchPaperV2 } from '../contract.js';
import { fail, optionalString, requirePlainObject, requireString } from '../errors.js';
import { canonicalDoiUrl, derivePaperId, normalizeArxivId, normalizeDoi } from '../identifiers.js';
import {
  adapterContext,
  dateTimeOrParts,
  firstString,
  normalizeAuthors,
  normalizeText,
  publicDomainMetadataLicense,
  temporalFromDateParts,
  unknownIntegrityState,
} from './common.js';

const CORRECTION_TYPES = new Set(['correction', 'corrigendum', 'erratum']);
const RETRACTION_TYPES = new Set(['retraction', 'withdrawal']);
const CONCERN_TYPES = new Set(['expression-of-concern', 'expression of concern']);
const REINSTATEMENT_TYPES = new Set(['reinstatement']);

function unwrapWork(payload) {
  const raw = requirePlainObject(payload, 'CROSSREF_PAYLOAD_INVALID');
  if (Object.hasOwn(raw, 'message')) {
    if (raw.status !== 'ok' || (raw['message-type'] != null && raw['message-type'] !== 'work')) fail('CROSSREF_RESPONSE_NOT_OK');
    return requirePlainObject(raw.message, 'CROSSREF_WORK_REQUIRED');
  }
  return raw;
}

function authorName(value) {
  const author = requirePlainObject(value, 'CROSSREF_AUTHOR_INVALID');
  if (author.name != null) return normalizeText(author.name, 'CROSSREF_AUTHOR_NAME_INVALID');
  const parts = [author.given, author.family].filter((entry) => typeof entry === 'string' && entry.trim());
  if (parts.length === 0) fail('CROSSREF_AUTHOR_NAME_INVALID');
  return normalizeText(parts.join(' '), 'CROSSREF_AUTHOR_NAME_INVALID');
}

function publishedAt(work) {
  for (const key of ['published-online', 'published-print', 'published', 'issued', 'posted', 'created']) {
    const value = temporalFromDateParts(work[key], `CROSSREF_${key.toUpperCase()}_INVALID`);
    if (value) return { value, source: `message.${key}.date-parts` };
  }
  fail('CROSSREF_PUBLISHED_AT_REQUIRED');
}

function arxivIdentity(work) {
  if (!Array.isArray(work['alternative-id'])) return null;
  const candidates = [];
  for (const value of work['alternative-id']) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (!/^(?:arxiv:\s*|https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/|\d{4}\.\d{4,5}(?:v\d+)?$|[a-z][a-z0-9.-]*\/\d{7}(?:v\d+)?$)/iu.test(text)) continue;
    candidates.push(normalizeArxivId(text));
  }
  const unique = [...new Map(candidates.map((entry) => [entry.arXivId, entry])).values()];
  if (unique.length > 1) fail('CROSSREF_ARXIV_ID_CONFLICT');
  return unique[0] ?? null;
}

function normalizeUpdate(entry, relation) {
  const update = requirePlainObject(entry, 'CROSSREF_UPDATE_INVALID');
  const type = requireString(update.type, 'CROSSREF_UPDATE_TYPE_REQUIRED').toLowerCase();
  if (!CORRECTION_TYPES.has(type) && !RETRACTION_TYPES.has(type) && !CONCERN_TYPES.has(type) && !REINSTATEMENT_TYPES.has(type)) return null;
  const identifier = update.DOI == null ? null : normalizeDoi(update.DOI);
  return Object.freeze({
    relation,
    type,
    identifier,
    label: optionalString(update.label, 'CROSSREF_UPDATE_LABEL_INVALID'),
    source: optionalString(update.source, 'CROSSREF_UPDATE_SOURCE_INVALID'),
    updatedAt: dateTimeOrParts(update.updated, 'CROSSREF_UPDATE_DATE_INVALID'),
  });
}

function updates(work) {
  const result = [];
  for (const [key, relation] of [['update-to', 'UPDATES'], ['updated-by', 'UPDATED_BY']]) {
    if (work[key] == null) continue;
    if (!Array.isArray(work[key])) fail('CROSSREF_UPDATES_INVALID');
    for (const entry of work[key]) {
      const normalized = normalizeUpdate(entry, relation);
      if (normalized) result.push(normalized);
    }
  }
  return result;
}

function integrityStates(work) {
  const evidence = updates(work);
  const corrections = evidence.filter((entry) => CORRECTION_TYPES.has(entry.type));
  const retractions = evidence.filter((entry) => !CORRECTION_TYPES.has(entry.type));
  const correctionState = corrections.length === 0
    ? unknownIntegrityState()
    : { status: corrections.some((entry) => entry.relation === 'UPDATED_BY') ? 'CORRECTED' : 'CORRECTION_NOTICE', evidence: Object.freeze(corrections) };

  let retractionState = unknownIntegrityState();
  if (retractions.length > 0) {
    const affected = retractions.filter((entry) => entry.relation === 'UPDATED_BY');
    const latest = [...(affected.length > 0 ? affected : retractions)].sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt))).at(-1);
    let status = 'RETRACTION_NOTICE';
    if (affected.length > 0 && REINSTATEMENT_TYPES.has(latest.type)) status = 'REINSTATED';
    else if (affected.length > 0 && CONCERN_TYPES.has(latest.type)) status = 'EXPRESSION_OF_CONCERN';
    else if (affected.length > 0 && RETRACTION_TYPES.has(latest.type)) status = 'RETRACTED';
    retractionState = { status, evidence: Object.freeze(retractions) };
  }
  return { correctionState, retractionState };
}

function contentLicense(work) {
  if (work.license == null) return { status: 'UNKNOWN', entries: Object.freeze([]) };
  if (!Array.isArray(work.license) || work.license.length === 0) fail('CROSSREF_LICENSE_INVALID');
  const entries = work.license.map((value) => {
    const license = requirePlainObject(value, 'CROSSREF_LICENSE_ENTRY_INVALID');
    return Object.freeze({
      identifier: null,
      url: requireString(license.URL, 'CROSSREF_LICENSE_URL_REQUIRED'),
      appliesTo: optionalString(license['content-version'], 'CROSSREF_LICENSE_VERSION_INVALID') ?? 'UNSPECIFIED',
      startsAt: dateTimeOrParts(license.start, 'CROSSREF_LICENSE_START_INVALID'),
      delayInDays: license['delay-in-days'] == null ? null : license['delay-in-days'],
      verificationRequired: true,
    });
  });
  return { status: 'KNOWN', entries: Object.freeze(entries) };
}

export function adaptCrossrefMetadata(payload, context) {
  const work = unwrapWork(payload);
  const DOI = normalizeDoi(work.DOI);
  if (!DOI) fail('CROSSREF_DOI_REQUIRED');
  const arxiv = arxivIdentity(work);
  const publication = publishedAt(work);
  const title = firstString(work.title, 'CROSSREF_TITLE_REQUIRED');
  const authors = normalizeAuthors(work.author, authorName);
  const integrity = integrityStates(work);
  const providerRecordId = DOI;
  const canonicalUrl = canonicalDoiUrl(DOI);
  const version = {
    workVersion: arxiv?.version == null ? null : `v${arxiv.version}`,
    providerRecordVersion: optionalString(work.indexed?.version, 'CROSSREF_INDEX_VERSION_INVALID'),
    providerUpdatedAt: dateTimeOrParts(work.indexed, 'CROSSREF_INDEXED_AT_INVALID') ?? dateTimeOrParts(work.deposited, 'CROSSREF_DEPOSITED_AT_INVALID'),
  };
  const fieldSources = {
    title: 'message.title[0]',
    authors: 'message.author',
    publishedAt: publication.source,
    DOI: 'message.DOI',
    arXivId: arxiv ? 'message.alternative-id' : 'provider-metadata:absent',
    canonicalUrl: 'derived:message.DOI',
    version: 'message.indexed|message.deposited|message.alternative-id',
    correctionState: 'message.updated-by|message.update-to',
    retractionState: 'message.updated-by|message.update-to',
    license: 'message.license|crossref-metadata-policy',
  };
  const adapter = adapterContext('CROSSREF', payload, context, 'crossref-metadata-adapter', providerRecordId, fieldSources);
  return createResearchPaperV2({
    paperId: derivePaperId({ DOI, arXivId: arxiv?.arXivId ?? null, source: 'CROSSREF', providerRecordId }),
    title,
    authors,
    publishedAt: publication.value,
    source: 'CROSSREF',
    DOI,
    arXivId: arxiv?.arXivId ?? null,
    canonicalUrl,
    version,
    ...integrity,
    license: {
      metadata: publicDomainMetadataLicense('CROSSREF_FACTS_AND_CC0', 'https://www.crossref.org/documentation/retrieve-metadata/', false),
      content: contentLicense(work),
    },
    ...adapter,
  });
}
