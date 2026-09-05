import { deepFreeze } from './canonical-json.js';
import { fail, requireString } from './errors.js';

export const PROVIDER_POLICY_VERSION = 'external-research-provider-policy-2026-08-24';

export const PROVIDER_POLICIES = deepFreeze({
  CROSSREF: {
    apiDocumentation: 'https://www.crossref.org/documentation/retrieve-metadata/rest-api/',
    accessDocumentation: 'https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/',
    integrityDocumentation: 'https://www.crossref.org/documentation/retrieve-metadata/retraction-watch/',
    licenseDocumentation: 'https://www.crossref.org/documentation/retrieve-metadata/',
    accessMode: 'PUBLIC_ANONYMOUS',
    credentialsAllowed: false,
    requestPolicy: {
      obeyRateLimitHeaders: true,
      backoffOn429: true,
      singleRecordPublicRpsCap: 5,
      listPublicRpsCap: 1,
    },
  },
  SEMANTIC_SCHOLAR: {
    apiDocumentation: 'https://api.semanticscholar.org/api-docs/',
    accessDocumentation: 'https://www.semanticscholar.org/product/api',
    licenseDocumentation: 'https://www.semanticscholar.org/product/api/license',
    accessMode: 'PUBLIC_ANONYMOUS',
    credentialsAllowed: false,
    attributionRequired: true,
    requestPolicy: {
      sharedAnonymousPoolRps: 1000,
      additionalThrottlingPossible: true,
      backoffOn429: true,
    },
  },
  ARXIV: {
    apiDocumentation: 'https://info.arxiv.org/help/api/user-manual.html',
    accessDocumentation: 'https://info.arxiv.org/help/api/tou.html',
    licenseDocumentation: 'https://info.arxiv.org/help/license/index.html',
    accessMode: 'PUBLIC_ANONYMOUS',
    credentialsAllowed: false,
    requestPolicy: {
      minimumIntervalMs: 3000,
      maximumConcurrency: 1,
      cacheSameQueryForDay: true,
    },
  },
});

export function validateProviderRequestUrl(source, value) {
  const text = requireString(value, 'RETRIEVED_FROM_REQUIRED');
  let url;
  try {
    url = new URL(text);
  } catch {
    fail('RETRIEVED_FROM_INVALID');
  }
  if (url.protocol !== 'https:' || url.username || url.password) fail('RETRIEVED_FROM_HTTPS_REQUIRED');
  for (const key of url.searchParams.keys()) {
    if (/^(?:x-)?api[-_]?key$|token|authorization|^mailto$/iu.test(key)) fail('PRIVATE_API_FORBIDDEN');
  }
  const hostname = url.hostname.toLowerCase();
  if (source === 'CROSSREF' && (hostname !== 'api.crossref.org' || !/^\/(?:v1\/)?works(?:\/|$)/u.test(url.pathname))) fail('CROSSREF_REQUEST_URL_INVALID');
  if (source === 'SEMANTIC_SCHOLAR' && (hostname !== 'api.semanticscholar.org' || !/^\/graph\/v1\/paper(?:\/|$)/u.test(url.pathname))) fail('SEMANTIC_SCHOLAR_REQUEST_URL_INVALID');
  if (source === 'ARXIV' && (!['arxiv.org', 'export.arxiv.org'].includes(hostname) || url.pathname !== '/api/query')) fail('ARXIV_REQUEST_URL_INVALID');
  if (!Object.hasOwn(PROVIDER_POLICIES, source)) fail('SOURCE_UNSUPPORTED');
  return url.toString();
}
