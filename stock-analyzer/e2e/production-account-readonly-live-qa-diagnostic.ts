export type SanitizedBitgetReadonlyDiagnostic = {
  provider: 'bitget';
  requestMethod: 'GET';
  requestPath: string;
  endpointFamily: 'UTA_V3' | 'CLASSIC';
  probe: 'ACCOUNT_SETTINGS' | 'ACCOUNT_INFO' | 'ASSETS' | 'POSITIONS' | 'OPEN_ORDERS';
  httpStatus: number;
  applicationCode: string | null;
  sanitizedClassification: string;
  fallbackAttempted: boolean;
  timestampRejected: boolean;
  productionHost: boolean;
  credentialPresence: {
    key: boolean;
    secret: boolean;
    passphrase: boolean;
  };
};

type RecordValue = Record<string, unknown>;

const requestPaths = new Set([
  '/api/v3/account/settings',
  '/api/v3/account/info',
  '/api/v3/account/assets',
  '/api/v3/position/current-position',
  '/api/v3/trade/unfilled-orders',
  '/api/v2/mix/account/accounts',
  '/api/v2/mix/position/all-position',
  '/api/v2/mix/order/orders-pending',
]);
const endpointFamilies = new Set(['UTA_V3', 'CLASSIC']);
const probes = new Set(['ACCOUNT_SETTINGS', 'ACCOUNT_INFO', 'ASSETS', 'POSITIONS', 'OPEN_ORDERS']);
const classifications = new Set([
  'BITGET_NOT_UTA',
  'BITGET_AUTH_FAILED',
  'BITGET_HTTP_401_NO_APPLICATION_CODE',
  'BITGET_IP_NOT_ALLOWED',
  'BITGET_PERMISSION_DENIED',
  'BITGET_TIMESTAMP_REJECTED',
  'BITGET_PARAMETER_REJECTED',
  'BITGET_REQUEST_REJECTED',
  'PROVIDER_UNAVAILABLE',
  'RATE_LIMITED',
]);

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function booleans(value: unknown) {
  if (!record(value)
    || typeof value.key !== 'boolean'
    || typeof value.secret !== 'boolean'
    || typeof value.passphrase !== 'boolean') return null;
  return { key: value.key, secret: value.secret, passphrase: value.passphrase };
}

export function parseBitgetReadonlyDiagnosticHeader(
  headerValue: string | null | undefined,
): SanitizedBitgetReadonlyDiagnostic | null {
  if (typeof headerValue !== 'string' || headerValue.length === 0) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(headerValue);
  } catch {
    return null;
  }
  if (!record(raw)
    || raw.provider !== 'bitget'
    || raw.requestMethod !== 'GET'
    || typeof raw.requestPath !== 'string'
    || !requestPaths.has(raw.requestPath)
    || typeof raw.endpointFamily !== 'string'
    || !endpointFamilies.has(raw.endpointFamily)
    || typeof raw.probe !== 'string'
    || !probes.has(raw.probe)
    || !Number.isInteger(raw.httpStatus)
    || raw.httpStatus < 100
    || raw.httpStatus > 599
    || (raw.applicationCode !== null
      && (typeof raw.applicationCode !== 'string' || !/^\d+$/.test(raw.applicationCode)))
    || typeof raw.sanitizedClassification !== 'string'
    || !classifications.has(raw.sanitizedClassification)
    || typeof raw.fallbackAttempted !== 'boolean'
    || typeof raw.timestampRejected !== 'boolean'
    || typeof raw.productionHost !== 'boolean') return null;

  const credentialPresence = booleans(raw.credentialPresence);
  if (!credentialPresence) return null;

  return {
    provider: 'bitget',
    requestMethod: 'GET',
    requestPath: raw.requestPath,
    endpointFamily: raw.endpointFamily as SanitizedBitgetReadonlyDiagnostic['endpointFamily'],
    probe: raw.probe as SanitizedBitgetReadonlyDiagnostic['probe'],
    httpStatus: raw.httpStatus,
    applicationCode: raw.applicationCode,
    sanitizedClassification: raw.sanitizedClassification,
    fallbackAttempted: raw.fallbackAttempted,
    timestampRejected: raw.timestampRejected,
    productionHost: raw.productionHost,
    credentialPresence,
  };
}
