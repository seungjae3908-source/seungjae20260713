import { createResearchPaperV2 } from '../contract.js';
import { fail, requirePlainObject } from '../errors.js';
import { canonicalArxivUrl, canonicalDoiUrl, derivePaperId, normalizeArxivId, normalizeDoi, normalizeTemporal } from '../identifiers.js';
import {
  adapterContext,
  normalizeAuthors,
  normalizeText,
  publicDomainMetadataLicense,
  unknownContentLicense,
  unknownIntegrityState,
} from './common.js';

function authorName(value) {
  if (typeof value === 'string') return normalizeText(value, 'ARXIV_AUTHOR_NAME_REQUIRED');
  return normalizeText(requirePlainObject(value, 'ARXIV_AUTHOR_INVALID').name, 'ARXIV_AUTHOR_NAME_REQUIRED');
}

export function adaptArxivMetadata(payload, context) {
  const entry = requirePlainObject(payload, 'ARXIV_PAYLOAD_INVALID');
  const identity = normalizeArxivId(entry.id ?? entry.arXivId);
  if (!identity) fail('ARXIV_ID_REQUIRED');
  const DOI = normalizeDoi(entry.doi ?? entry.DOI);
  const title = normalizeText(entry.title, 'ARXIV_TITLE_REQUIRED');
  const authors = normalizeAuthors(entry.authors ?? entry.author, authorName);
  const publishedAt = normalizeTemporal(entry.published, 'ARXIV_PUBLISHED_AT_REQUIRED');
  const updatedAt = normalizeTemporal(entry.updated, 'ARXIV_UPDATED_AT_REQUIRED');
  const canonicalUrl = DOI ? canonicalDoiUrl(DOI) : canonicalArxivUrl(identity.arXivId, identity.version);
  const providerRecordId = `${identity.arXivId}${identity.version == null ? '' : `v${identity.version}`}`;
  const fieldSources = {
    title: 'entry.title',
    authors: 'entry.author[].name',
    publishedAt: 'entry.published',
    DOI: 'entry.arxiv:doi',
    arXivId: 'entry.id',
    canonicalUrl: DOI ? 'derived:entry.arxiv:doi' : 'derived:entry.id',
    version: 'entry.id|entry.updated',
    correctionState: 'provider-metadata:unsupported',
    retractionState: 'provider-metadata:unsupported',
    license: 'arxiv-api-metadata-policy|provider-metadata:content-license-unavailable',
  };
  const adapter = adapterContext('ARXIV', payload, context, 'arxiv-atom-metadata-adapter', providerRecordId, fieldSources);
  return createResearchPaperV2({
    paperId: derivePaperId({ DOI, arXivId: identity.arXivId, source: 'ARXIV', providerRecordId }),
    title,
    authors,
    publishedAt,
    source: 'ARXIV',
    DOI,
    arXivId: identity.arXivId,
    canonicalUrl,
    version: {
      workVersion: identity.version == null ? null : `v${identity.version}`,
      providerRecordVersion: null,
      providerUpdatedAt: updatedAt,
    },
    // The legacy Atom API exposes neither a structured withdrawal flag nor a
    // content-license field. Title/comment guessing is intentionally forbidden.
    correctionState: unknownIntegrityState(),
    retractionState: unknownIntegrityState(),
    license: {
      metadata: publicDomainMetadataLicense('CC0-1.0', 'https://info.arxiv.org/help/api/tou.html', false),
      content: unknownContentLicense(),
    },
    ...adapter,
  });
}
