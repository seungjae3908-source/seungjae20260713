export type EvidenceStatus = 'pass' | 'partial' | 'unverified';

export type EvidenceCell = {
  status: EvidenceStatus;
  evidence: string[];
  note?: string;
};

export type FailedRequestClassification =
  | 'expected-abort'
  | 'intentional-fixture'
  | 'navigation-cancel'
  | 'unexpected';

export type FailedRequestInput = {
  method?: string;
  url: string;
  errorText?: string | null;
  resourceType?: string | null;
  intentionalFixtureFailure?: boolean;
  navigationCancellation?: boolean;
};

export type SanitizedFailedRequest = {
  method: string;
  pathname: string;
  resourceClass: string;
  classification: FailedRequestClassification;
  reasonClass: 'aborted' | 'cancelled' | 'timeout' | 'connection' | 'other';
};

export type FailedRequestSummary = {
  totalFailedRequests: number;
  expectedFailedRequests: number;
  unexpectedFailedRequests: number;
  items: SanitizedFailedRequest[];
};

const ABORT_PATTERN = /ERR_ABORTED|NS_BINDING_ABORTED|AbortError|aborted/i;
const CANCEL_PATTERN = /ERR_CANCELED|ERR_CANCELLED|cancelled|canceled/i;
const TIMEOUT_PATTERN = /timeout|timed out|ERR_TIMED_OUT/i;
const CONNECTION_PATTERN = /ERR_CONNECTION|ERR_NETWORK|ENOTFOUND|ECONNRESET|ECONNREFUSED/i;

export function sanitizePathname(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, 'http://evidence.invalid');
    return parsed.pathname || '/';
  } catch {
    return '/invalid-url';
  }
}

export function classifyResource(pathname: string, resourceType?: string | null): string {
  if (resourceType) {
    const normalized = resourceType.trim().toLowerCase();
    if (normalized && /^[a-z0-9_-]{1,32}$/.test(normalized)) return normalized;
  }
  if (pathname.startsWith('/api/market/scan')) return 'scanner-api';
  if (pathname.startsWith('/api/ai/')) return 'ai-api';
  if (pathname.startsWith('/api/')) return 'app-api';
  if (/\.(?:js|mjs|cjs)$/i.test(pathname)) return 'script';
  if (/\.css$/i.test(pathname)) return 'stylesheet';
  if (/\.(?:png|jpe?g|gif|svg|webp|ico)$/i.test(pathname)) return 'image';
  if (/\.(?:woff2?|ttf|otf)$/i.test(pathname)) return 'font';
  return 'document-or-other';
}

function reasonClass(errorText: string): SanitizedFailedRequest['reasonClass'] {
  if (ABORT_PATTERN.test(errorText)) return 'aborted';
  if (CANCEL_PATTERN.test(errorText)) return 'cancelled';
  if (TIMEOUT_PATTERN.test(errorText)) return 'timeout';
  if (CONNECTION_PATTERN.test(errorText)) return 'connection';
  return 'other';
}

export function sanitizeAndClassifyFailedRequest(input: FailedRequestInput): SanitizedFailedRequest {
  const pathname = sanitizePathname(input.url);
  const errorText = String(input.errorText ?? '');
  let classification: FailedRequestClassification = 'unexpected';

  if (input.intentionalFixtureFailure) classification = 'intentional-fixture';
  else if (input.navigationCancellation && (ABORT_PATTERN.test(errorText) || CANCEL_PATTERN.test(errorText))) {
    classification = 'navigation-cancel';
  } else if (ABORT_PATTERN.test(errorText)) classification = 'expected-abort';

  return {
    method: (input.method ?? 'GET').toUpperCase().slice(0, 12),
    pathname,
    resourceClass: classifyResource(pathname, input.resourceType),
    classification,
    reasonClass: reasonClass(errorText),
  };
}

export function summarizeFailedRequests(inputs: FailedRequestInput[]): FailedRequestSummary {
  const items = inputs.map(sanitizeAndClassifyFailedRequest);
  const unexpectedFailedRequests = items.filter((item) => item.classification === 'unexpected').length;
  return {
    totalFailedRequests: items.length,
    expectedFailedRequests: items.length - unexpectedFailedRequests,
    unexpectedFailedRequests,
    items,
  };
}

export function evidenceCell(status: EvidenceStatus, evidence: string[], note?: string): EvidenceCell {
  return note ? { status, evidence, note } : { status, evidence };
}
