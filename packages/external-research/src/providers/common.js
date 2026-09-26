import { sha256Hex } from '../canonical-json.js';
import { fail, optionalString, requirePlainObject, requireString } from '../errors.js';
import { normalizeRetrievedAt, normalizeTemporal } from '../identifiers.js';
import { PROVIDER_POLICY_VERSION, validateProviderRequestUrl } from '../policies.js';

export const ADAPTER_VERSION = '2.0.0';

export function normalizeText(value, code) {
  return requireString(value, code).replace(/\s+/gu, ' ');
}

export function normalizeAuthors(values, mapper) {
  if (!Array.isArray(values) || values.length === 0) fail('AUTHORS_REQUIRED');
  return Object.freeze(values.map((value, index) => normalizeText(mapper(value, index), `AUTHOR_INVALID:${index}`)));
}

export function firstString(values, code) {
  if (!Array.isArray(values)) fail(code);
  const value = values.find((entry) => typeof entry === 'string' && entry.trim());
  return normalizeText(value, code);
}

export function temporalFromDateParts(value, code) {
  if (value == null) return null;
  const object = requirePlainObject(value, code);
  const parts = object['date-parts'];
  if (!Array.isArray(parts) || !Array.isArray(parts[0]) || parts[0].length < 1 || parts[0].length > 3) fail(code);
  const numbers = parts[0];
  if (numbers.some((entry) => !Number.isSafeInteger(entry))) fail(code);
  const text = numbers.map((entry, index) => (index === 0 ? String(entry).padStart(4, '0') : String(entry).padStart(2, '0'))).join('-');
  return normalizeTemporal(text, code);
}

export function dateTimeOrParts(value, code) {
  if (value == null) return null;
  const object = requirePlainObject(value, code);
  if (object['date-time'] != null) return normalizeTemporal(object['date-time'], code);
  return temporalFromDateParts(object, code);
}

export function adapterContext(source, rawPayload, context, adapterName, providerRecordId, fieldSources) {
  const input = requirePlainObject(context, 'ADAPTER_CONTEXT_REQUIRED');
  const retrievedAt = normalizeRetrievedAt(input.retrievedAt);
  const retrievedFrom = validateProviderRequestUrl(source, input.retrievedFrom);
  return {
    retrievedAt,
    provenance: {
      provider: source,
      providerRecordId: requireString(providerRecordId, 'PROVIDER_RECORD_ID_REQUIRED'),
      retrievedFrom,
      retrievedAt,
      sourceHash: sha256Hex(rawPayload),
      adapter: { name: adapterName, version: ADAPTER_VERSION },
      accessMode: 'PUBLIC_ANONYMOUS',
      policyVersion: PROVIDER_POLICY_VERSION,
      fieldSources,
    },
  };
}

export function publicDomainMetadataLicense(identifier, url, attributionRequired = false) {
  return {
    status: 'PUBLIC_DOMAIN',
    identifier: optionalString(identifier, 'METADATA_LICENSE_IDENTIFIER_INVALID'),
    url,
    attributionRequired,
  };
}

export function termsGovernedMetadataLicense(url, attributionRequired) {
  return { status: 'TERMS_GOVERNED', identifier: null, url, attributionRequired };
}

export function unknownContentLicense() {
  return { status: 'UNKNOWN', entries: Object.freeze([]) };
}

export function unknownIntegrityState() {
  return { status: 'UNKNOWN', evidence: Object.freeze([]) };
}
