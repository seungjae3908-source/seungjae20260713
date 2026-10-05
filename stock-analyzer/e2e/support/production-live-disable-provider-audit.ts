export const SAFE_DISABLE_PROVIDER_ORDER = ['toss', 'kiwoom', 'upbit', 'bitget'] as const;

export type SafeDisableProvider = typeof SAFE_DISABLE_PROVIDER_ORDER[number];

export type ReadonlyProviderSnapshot = {
  provider?: unknown;
  readOnly?: unknown;
  connected?: unknown;
  status?: unknown;
  checkedAt?: unknown;
  lastGoodAt?: unknown;
  stale?: unknown;
  errorCode?: unknown;
  openOrders?: unknown;
  orderRequests?: unknown;
  cancelRequests?: unknown;
  amendRequests?: unknown;
  transferRequests?: unknown;
  withdrawalRequests?: unknown;
  credentialsReturned?: unknown;
  liveTradingEnabled?: unknown;
  autoTradingEnabled?: unknown;
};

export type ReadonlyProbeObservation = {
  responseReceived: boolean;
  httpStatus: number | null;
  payload: ReadonlyProviderSnapshot | null;
  transportClassification: 'NONE' | 'NETWORK_TIMEOUT' | 'NETWORK_FAILURE' | 'INVALID_JSON';
};

export type SanitizedProviderDiagnostic = {
  provider: SafeDisableProvider;
  responseReceived: boolean;
  httpStatus: number | null;
  configured: boolean;
  verified: boolean;
  connected: boolean;
  status: string;
  stale: boolean | null;
  errorCode: string | null;
  openOrdersIsArray: boolean;
  openOrdersKnown: boolean;
  lastVerifiedAtPresent: boolean;
  diagnosticClassification: string;
};

const PROVIDER_STATUSES = new Set([
  'CONNECTED',
  'CONFIGURED_UNVERIFIED',
  'NOT_CONFIGURED',
  'STALE',
  'AUTH_FAILED',
  'RATE_LIMITED',
  'UNAVAILABLE',
]);

function finiteDate(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function sanitizedStatus(value: unknown) {
  const status = String(value ?? '').trim().toUpperCase();
  return PROVIDER_STATUSES.has(status) ? status : 'MISSING';
}

function sanitizedErrorCode(value: unknown) {
  if (value == null) return null;
  const code = String(value).trim().toUpperCase();
  return /^[A-Z0-9_/-]{1,64}$/u.test(code) ? code : 'UNSAFE_ERROR_CODE_REDACTED';
}

function mutationCountersAreZero(snapshot: ReadonlyProviderSnapshot | null) {
  return [
    snapshot?.orderRequests,
    snapshot?.cancelRequests,
    snapshot?.amendRequests,
    snapshot?.transferRequests,
    snapshot?.withdrawalRequests,
  ].every((value) => value === 0);
}

export function providerDiagnostic(
  provider: SafeDisableProvider,
  observation: ReadonlyProbeObservation,
): SanitizedProviderDiagnostic {
  const snapshot = observation.payload;
  const status = sanitizedStatus(snapshot?.status);
  const errorCode = sanitizedErrorCode(snapshot?.errorCode);
  const connected = snapshot?.connected === true;
  const stale = typeof snapshot?.stale === 'boolean' ? snapshot.stale : null;
  const openOrdersIsArray = Array.isArray(snapshot?.openOrders);
  const lastVerifiedAtPresent = finiteDate(snapshot?.lastGoodAt);
  const configured = status !== 'MISSING' && status !== 'NOT_CONFIGURED';
  const verified = connected && lastVerifiedAtPresent;

  let diagnosticClassification = 'PASS';
  if (!observation.responseReceived) diagnosticClassification = observation.transportClassification;
  else if (observation.httpStatus === 401) diagnosticClassification = 'AUTHENTICATION_REJECTED';
  else if (observation.httpStatus === 403) diagnosticClassification = 'PERMISSION_OR_IP_ALLOWLIST_REJECTED';
  else if (observation.httpStatus === 429) diagnosticClassification = 'RATE_LIMITED';
  else if (observation.httpStatus !== 200) diagnosticClassification = observation.httpStatus != null && observation.httpStatus >= 500
    ? 'PROVIDER_OR_NETWORK_UNAVAILABLE'
    : 'HTTP_ERROR';
  else if (observation.transportClassification === 'INVALID_JSON') diagnosticClassification = 'INVALID_JSON';
  else if (snapshot?.provider !== provider) diagnosticClassification = 'PROVIDER_IDENTITY_MISMATCH';
  else if (snapshot?.readOnly !== true) diagnosticClassification = 'READ_ONLY_CONTRACT_MISSING';
  else if (!mutationCountersAreZero(snapshot)) diagnosticClassification = 'MUTATION_COUNTER_NONZERO';
  else if (snapshot?.credentialsReturned !== false) diagnosticClassification = 'CREDENTIAL_EXPOSURE_CONTRACT_FAILED';
  else if (snapshot?.liveTradingEnabled !== false || snapshot?.autoTradingEnabled !== false) {
    diagnosticClassification = 'QA_AUTHORITY_NOT_FALSE';
  } else if (!configured) diagnosticClassification = 'NOT_CONFIGURED';
  else if (!connected) diagnosticClassification = 'NOT_CONNECTED';
  else if (status !== 'CONNECTED') diagnosticClassification = `STATUS_${status}`;
  else if (stale !== false) diagnosticClassification = 'STALE_SNAPSHOT';
  else if (errorCode !== null) diagnosticClassification = `ERROR_${errorCode}`;
  else if (!openOrdersIsArray) diagnosticClassification = 'OPEN_ORDERS_UNKNOWN';
  else if (!lastVerifiedAtPresent) diagnosticClassification = 'LAST_VERIFIED_AT_MISSING';

  return {
    provider,
    responseReceived: observation.responseReceived,
    httpStatus: observation.httpStatus,
    configured,
    verified,
    connected,
    status,
    stale,
    errorCode,
    openOrdersIsArray,
    openOrdersKnown: openOrdersIsArray,
    lastVerifiedAtPresent,
    diagnosticClassification,
  };
}

export function providerDiagnosticHealthy(value: SanitizedProviderDiagnostic) {
  return value.responseReceived === true
    && value.httpStatus === 200
    && value.configured === true
    && value.verified === true
    && value.connected === true
    && value.status === 'CONNECTED'
    && value.stale === false
    && value.errorCode === null
    && value.openOrdersKnown === true
    && value.lastVerifiedAtPresent === true
    && value.diagnosticClassification === 'PASS';
}

export function providerDiagnosticRetryable(value: SanitizedProviderDiagnostic) {
  return [
    'NETWORK_TIMEOUT',
    'NETWORK_FAILURE',
    'RATE_LIMITED',
    'PROVIDER_OR_NETWORK_UNAVAILABLE',
    'STALE_SNAPSHOT',
    'NOT_CONNECTED',
    'STATUS_UNAVAILABLE',
    'STATUS_RATE_LIMITED',
  ].includes(value.diagnosticClassification);
}
