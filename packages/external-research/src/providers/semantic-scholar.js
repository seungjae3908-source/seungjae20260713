import { createResearchPaperV2 } from '../contract.js';
import { fail, optionalString, requirePlainObject } from '../errors.js';
import { canonicalArxivUrl, canonicalDoiUrl, derivePaperId, normalizeArxivId, normalizeDoi, normalizeProviderRecordId, normalizeTemporal } from '../identifiers.js';
import {
  adapterContext,
  normalizeAuthors,
  normalizeText,
  termsGovernedMetadataLicense,
  unknownContentLicense,
  unknownIntegrityState,
} from './common.js';

function authorName(value) {
  return normalizeText(requirePlainObject(value, 'SEMANTIC_SCHOLAR_AUTHOR_INVALID').name, 'SEMANTIC_SCHOLAR_AUTHOR_NAME_REQUIRED');
}

function publicationDate(paper) {
  if (paper.publicationDate != null) return { value: normalizeTemporal(paper.publicationDate, 'SEMANTIC_SCHOLAR_PUBLICATION_DATE_INVALID'), source: 'publicationDate' };
  if (paper.year != null) return { value: normalizeTemporal(String(paper.year), 'SEMANTIC_SCHOLAR_YEAR_INVALID'), source: 'year' };
  fail('SEMANTIC_SCHOLAR_PUBLISHED_AT_REQUIRED');
}

function contentLicense(paper) {
  if (paper.openAccessPdf == null) return unknownContentLicense();
  const pdf = requirePlainObject(paper.openAccessPdf, 'SEMANTIC_SCHOLAR_OPEN_ACCESS_PDF_INVALID');
  const identifier = optionalString(pdf.license, 'SEMANTIC_SCHOLAR_CONTENT_LICENSE_INVALID');
  if (!identifier) return unknownContentLicense();
  const entry = Object.freeze({
    identifier,
    url: optionalString(pdf.url, 'SEMANTIC_SCHOLAR_PDF_URL_INVALID'),
    appliesTo: 'OPEN_ACCESS_PDF',
    startsAt: null,
    delayInDays: null,
    verificationRequired: true,
  });
  return { status: 'KNOWN', entries: Object.freeze([entry]) };
}

export function adaptSemanticScholarMetadata(payload, context) {
  const paper = requirePlainObject(payload, 'SEMANTIC_SCHOLAR_PAYLOAD_INVALID');
  const providerRecordId = normalizeProviderRecordId(paper.paperId);
  const externalIds = paper.externalIds == null ? {} : requirePlainObject(paper.externalIds, 'SEMANTIC_SCHOLAR_EXTERNAL_IDS_INVALID');
  const DOI = normalizeDoi(externalIds.DOI);
  const arxiv = normalizeArxivId(externalIds.ArXiv ?? externalIds.ARXIV);
  const published = publicationDate(paper);
  const title = normalizeText(paper.title, 'SEMANTIC_SCHOLAR_TITLE_REQUIRED');
  const authors = normalizeAuthors(paper.authors, authorName);
  let canonicalUrl;
  if (DOI) canonicalUrl = canonicalDoiUrl(DOI);
  else if (arxiv) canonicalUrl = canonicalArxivUrl(arxiv.arXivId, arxiv.version);
  else {
    const supplied = optionalString(paper.url, 'SEMANTIC_SCHOLAR_URL_INVALID');
    if (supplied) {
      let url;
      try { url = new URL(supplied); } catch { fail('SEMANTIC_SCHOLAR_URL_INVALID'); }
      if (url.protocol !== 'https:' || !['semanticscholar.org', 'www.semanticscholar.org'].includes(url.hostname.toLowerCase())) fail('SEMANTIC_SCHOLAR_URL_INVALID');
      canonicalUrl = url.toString();
    } else canonicalUrl = `https://www.semanticscholar.org/paper/${encodeURIComponent(providerRecordId)}`;
  }
  const fieldSources = {
    title: 'title',
    authors: 'authors[].name',
    publishedAt: published.source,
    DOI: 'externalIds.DOI',
    arXivId: 'externalIds.ArXiv',
    canonicalUrl: DOI ? 'derived:externalIds.DOI' : arxiv ? 'derived:externalIds.ArXiv' : paper.url ? 'url' : 'derived:paperId',
    version: 'externalIds.ArXiv|retrievalVersion',
    correctionState: 'provider-metadata:unsupported',
    retractionState: 'provider-metadata:unsupported',
    license: 'openAccessPdf.license|semantic-scholar-api-license',
  };
  const adapter = adapterContext('SEMANTIC_SCHOLAR', payload, context, 'semantic-scholar-metadata-adapter', providerRecordId, fieldSources);
  return createResearchPaperV2({
    paperId: derivePaperId({ DOI, arXivId: arxiv?.arXivId ?? null, source: 'SEMANTIC_SCHOLAR', providerRecordId }),
    title,
    authors,
    publishedAt: published.value,
    source: 'SEMANTIC_SCHOLAR',
    DOI,
    arXivId: arxiv?.arXivId ?? null,
    canonicalUrl,
    version: {
      workVersion: arxiv?.version == null ? null : `v${arxiv.version}`,
      providerRecordVersion: optionalString(paper.retrievalVersion, 'SEMANTIC_SCHOLAR_RETRIEVAL_VERSION_INVALID'),
      providerUpdatedAt: null,
    },
    correctionState: unknownIntegrityState(),
    retractionState: unknownIntegrityState(),
    license: {
      metadata: termsGovernedMetadataLicense('https://www.semanticscholar.org/product/api/license', true),
      content: contentLicense(paper),
    },
    ...adapter,
  });
}
