import { fail, optionalString, requireString } from './errors.js';

const DOI_PATTERN = /^10\.\d{4,9}\/[^\s]+$/u;
const MODERN_ARXIV_PATTERN = /^\d{4}\.\d{4,5}$/u;
const LEGACY_ARXIV_PATTERN = /^[a-z][a-z0-9.-]*\/\d{7}$/u;

function decodeIdentifier(value, code) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail(code);
  }
}

export function normalizeDoi(value) {
  const input = optionalString(value, 'DOI_INVALID');
  if (input == null) return null;
  let doi = input;

  if (/^https?:\/\//iu.test(doi)) {
    let url;
    try {
      url = new URL(doi);
    } catch {
      fail('DOI_INVALID');
    }
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'doi.org' && hostname !== 'dx.doi.org') fail('DOI_URL_HOST_INVALID');
    doi = decodeIdentifier(url.pathname.replace(/^\/+/, ''), 'DOI_ENCODING_INVALID');
  } else {
    doi = doi.replace(/^doi:\s*/iu, '');
    doi = decodeIdentifier(doi, 'DOI_ENCODING_INVALID');
  }

  doi = doi.trim().normalize('NFC').toLowerCase();
  if (doi.length > 2048 || !DOI_PATTERN.test(doi) || /[\u0000-\u001f\u007f]/u.test(doi)) fail('DOI_INVALID');
  return doi;
}

export function canonicalDoiUrl(value) {
  const doi = normalizeDoi(value);
  if (doi == null) fail('DOI_REQUIRED');
  return `https://doi.org/${doi.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

export function normalizeArxivId(value) {
  const input = optionalString(value, 'ARXIV_ID_INVALID');
  if (input == null) return null;
  let identifier = input;

  if (/^https?:\/\//iu.test(identifier)) {
    let url;
    try {
      url = new URL(identifier);
    } catch {
      fail('ARXIV_ID_INVALID');
    }
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'arxiv.org' && hostname !== 'www.arxiv.org' && hostname !== 'export.arxiv.org') fail('ARXIV_URL_HOST_INVALID');
    identifier = decodeIdentifier(url.pathname.replace(/^\/(?:abs|pdf)\//iu, '').replace(/\.pdf$/iu, ''), 'ARXIV_ID_ENCODING_INVALID');
  } else {
    identifier = identifier.replace(/^arxiv:\s*/iu, '').replace(/\.pdf$/iu, '');
  }

  identifier = identifier.trim().normalize('NFC').toLowerCase();
  const versionMatch = identifier.match(/v([1-9]\d*)$/u);
  const version = versionMatch ? Number(versionMatch[1]) : null;
  const arXivId = versionMatch ? identifier.slice(0, -versionMatch[0].length) : identifier;
  if ((!MODERN_ARXIV_PATTERN.test(arXivId) && !LEGACY_ARXIV_PATTERN.test(arXivId)) || (version != null && !Number.isSafeInteger(version))) {
    fail('ARXIV_ID_INVALID');
  }
  return Object.freeze({ arXivId, version });
}

export function canonicalArxivUrl(value, explicitVersion = null) {
  const normalized = normalizeArxivId(value);
  if (normalized == null) fail('ARXIV_ID_REQUIRED');
  if (explicitVersion != null && (!Number.isSafeInteger(explicitVersion) || explicitVersion < 1)) fail('ARXIV_VERSION_INVALID');
  if (normalized.version != null && explicitVersion != null && normalized.version !== explicitVersion) fail('ARXIV_VERSION_CONFLICT');
  const version = explicitVersion ?? normalized.version;
  return `https://arxiv.org/abs/${normalized.arXivId}${version == null ? '' : `v${version}`}`;
}

export function normalizeProviderRecordId(value) {
  const id = requireString(value, 'PROVIDER_RECORD_ID_REQUIRED');
  if (id.length > 512 || /[\u0000-\u001f\u007f]/u.test(id)) fail('PROVIDER_RECORD_ID_INVALID');
  return id;
}

export function normalizeTemporal(value, code = 'TEMPORAL_VALUE_INVALID') {
  const text = requireString(String(value), code);
  if (/^\d{4}$/u.test(text)) {
    const year = Number(text);
    if (year < 1000 || year > 9999) fail(code);
    return text;
  }
  if (/^\d{4}-\d{2}$/u.test(text)) {
    const [year, month] = text.split('-').map(Number);
    if (year < 1000 || month < 1 || month > 12) fail(code);
    return text;
  }
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) fail(code);
    return text;
  }
  if (!/(?:z|[+-]\d{2}:\d{2})$/iu.test(text)) fail(code);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) fail(code);
  return new Date(timestamp).toISOString();
}

export function normalizeRetrievedAt(value) {
  const normalized = normalizeTemporal(value, 'RETRIEVED_AT_INVALID');
  if (!normalized.includes('T')) fail('RETRIEVED_AT_PRECISION_REQUIRED');
  return normalized;
}

export function derivePaperId({ DOI, arXivId, source, providerRecordId }) {
  const doi = normalizeDoi(DOI);
  if (doi) return `doi:${doi}`;
  const arxiv = normalizeArxivId(arXivId);
  if (arxiv) return `arxiv:${arxiv.arXivId}`;
  return `${requireString(source, 'SOURCE_REQUIRED').toLowerCase()}:${normalizeProviderRecordId(providerRecordId)}`;
}
